// POST /api/wise-sync - pull Wise balance statements straight from the Wise
// API into the ledger, entirely on Cloudflare, so a phone can refresh Wise
// without a desktop. Body: { since?: 'YYYY-MM-DD' } (default: Jan 1 of this
// year; Wise allows up to 469 days per statement).
//
// WISE_API_KEYS is a Pages secret: one or more Wise personal API tokens,
// comma-separated (one per person - each token sees that person's personal
// and business profiles). Every balance is an account whose external_ref is
// "wise:<profile id>:<CUR>". The first time a balance shows up, its account
// is created, with the starting balance worked out from Wise's own
// current balance minus everything in the statement, so the ledger agrees
// with Wise from day one.
//
// FLAT statements, runningBalance -> balance_after_cents (so derive-anchors
// works), referenceNumber occurrence-numbering for stable dedup. Writes go
// through ingestRows - the one gate that enforces dedup and locked history.

import type { Env } from './_lib'
import { json, error, ingestRows, recordSync, newAccountId, type IngestRowIn } from './_lib'
import { runAutoCategorize } from './_autocat'

const BASE = 'https://api.wise.com'

interface WiseTxn {
  type: string
  date: string
  amount: { value: number; currency: string }
  details?: { description?: string; type?: string } | null
  runningBalance?: { value: number } | null
  referenceNumber?: string | null
  [k: string]: unknown
}

interface WiseProfile {
  id: number
  type: string // PERSONAL | BUSINESS
  fullName?: string
  details?: { firstName?: string; lastName?: string; name?: string }
}

const cents = (v: number) => Math.round(v * 100)

export const wiseRef = (profileId: number, currency: string) => `wise:${profileId}:${currency}`

function profileName(p: WiseProfile): string {
  return p.fullName ?? p.details?.name ?? [p.details?.firstName, p.details?.lastName].filter(Boolean).join(' ')
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  let since = `${new Date().getFullYear()}-01-01`
  try {
    const body = (await request.json()) as { since?: string }
    if (body.since) since = body.since
  } catch {
    // empty body is fine
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return error('since must be YYYY-MM-DD')

  const keys = (env.WISE_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (keys.length === 0) return json({ ok: false, not_configured: true, message: 'Set the WISE_API_KEYS secret to sync Wise' })

  const db = env.DB
  const byRef = new Map(
    ((await db.prepare('SELECT id, external_ref FROM accounts WHERE external_ref IS NOT NULL').all()).results as Array<{ id: string; external_ref: string }>).map((a) => [a.external_ref, a.id])
  )
  const rows: IngestRowIn[] = []
  const created: string[] = []
  const nowIso = new Date().toISOString().slice(0, 19) + '.000Z'

  try {
    for (const apiKey of keys) {
      const wise = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
        const url = new URL(BASE + path)
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
        const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (!r.ok) throw new Error(`Wise ${path}: ${r.status}`)
        return r.json() as Promise<T>
      }

      const profiles = await wise<WiseProfile[]>('/v2/profiles')
      for (const prof of profiles) {
        const bals = await wise<Array<{ id: number; currency: string; amount: { value: number } }>>(`/v4/profiles/${prof.id}/balances`, { types: 'STANDARD' })
        for (const bal of bals) {
          const ref = wiseRef(prof.id, bal.currency)
          let accountId = byRef.get(ref)
          const stmt = await wise<{ transactions: WiseTxn[] }>(`/v1/profiles/${prof.id}/balance-statements/${bal.id}/statement.json`, {
            currency: bal.currency,
            intervalStart: `${since}T00:00:00.000Z`,
            intervalEnd: nowIso,
            type: 'FLAT',
          })
          const txns = [...stmt.transactions].sort((a, b) => a.date.localeCompare(b.date))

          if (!accountId) {
            // A wallet that never held anything stays out of the way.
            if (txns.length === 0 && bal.amount.value === 0) continue
            const biz = prof.type.toUpperCase() !== 'PERSONAL'
            const name = `Wise ${biz ? 'Business' : 'Personal'} ${bal.currency}`
            accountId = await newAccountId(db, `wise-${biz ? 'biz-' : ''}${bal.currency}`)
            const opening = cents(bal.amount.value) - txns.reduce((s, t) => s + cents(t.amount.value), 0)
            await db.batch([
              db
                .prepare(
                  `INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending, external_ref)
                   VALUES (?1, ?2, 'Wise', 'wallet', ?3, ?4, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts), 1, ?5)`
                )
                .bind(accountId, profileName(prof), bal.currency, name, ref),
              db
                .prepare(`INSERT INTO ledger_anchors (account_id, date, balance_cents, source) VALUES (?1, ?2, ?3, 'derived')`)
                .bind(accountId, since, opening),
            ])
            byRef.set(ref, accountId)
            created.push(name)
          }

          const refSeen = new Map<string, number>()
          for (const t of txns) {
            const ref = t.referenceNumber || `${t.date}|${t.amount.value}`
            const n = (refSeen.get(ref) ?? 0) + 1
            refSeen.set(ref, n)
            const ext = n === 1 ? ref : `${ref}:${n}`
            rows.push({
              account_id: accountId,
              date: t.date.slice(0, 10),
              description: t.details?.description || t.details?.type || t.type,
              amount_cents: cents(t.amount.value),
              balance_after_cents: t.runningBalance ? cents(t.runningBalance.value) : null,
              source_file: `wise-api:${prof.id}:${bal.currency}`,
              semantic_hash: `wise:${ext}`,
              external_id: ext,
              meta: JSON.stringify(t),
            })
          }
        }
      }
    }
  } catch (e) {
    // Structured 200, not 5xx - Cloudflare replaces 502 bodies with its own
    // error page and the client would lose the reason.
    return json({ ok: false, message: e instanceof Error ? e.message : 'Wise API failed' })
  }

  const outcome = rows.length > 0 ? await ingestRows(db, rows) : { inserted: 0, duplicates: 0, flagged: [], unknown_accounts: [] }
  const parts = [outcome.inserted > 0 ? `${outcome.inserted} new` : 'up to date']
  if (created.length) parts.push(`added ${created.length} account${created.length > 1 ? 's' : ''}`)
  await recordSync(db, 'wise', parts.join(' · '))
  // Fresh transactions get categorized without anyone asking.
  if (outcome.inserted > 0) waitUntil(runAutoCategorize(env).catch(() => {}))
  return json({ ok: true, ...outcome, fetched: rows.length, created, summary: parts.join(' · ') })
}
