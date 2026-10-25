// POST /api/plaid/sync - pull transactions from every linked bank (each
// access token in PLAID_ACCESS_TOKENS) into the ledger. Body: { dry_run? }.
//
// Accounts: each Plaid account is the ledger account whose external_ref is
// "plaid:<account_id>". One that doesn't exist yet is created, with its
// starting balance worked out from Plaid's current balance minus the posted
// rows this sync brings, so it agrees with the bank from day one. To feed an
// account that already has CSV history instead, set its external_ref
// before the first sync (README).
//
// Plaid and CSV exports describe the same bank feed, so rows MERGE across
// sources, not duplicate:
//   1. a row already carrying this Plaid id -> skip
//   2. a same-amount row with no external id (CSV or screenshot origin)
//      within +-4 days -> claim it: stamp the Plaid id on it, insert nothing
//   3. otherwise -> insert, with the CSV importer's semantic-hash scheme
//      (sha256 of account|date|amount + occurrence), so a later CSV download
//      of the same transaction dedups against it
// Inserts go through ingestRows - the verified-period gate applies.
//
// Each bank keeps its own cursor in plaid_state; a dry run advances nothing.

import type { Env } from '../_lib'
import { json, ingestRows, recordSync, newAccountId, type IngestRowIn } from '../_lib'
import { runAutoCategorize } from '../_autocat'
import { plaid, plaidTokens, plaidConfigured, kindFor } from './_plaid'

interface PlaidTxn {
  transaction_id: string
  account_id: string
  date: string
  name?: string
  merchant_name?: string
  amount: number
  pending: boolean
  iso_currency_code?: string | null
  unofficial_currency_code?: string | null
}

interface PlaidAccount {
  account_id: string
  name: string
  official_name?: string | null
  mask?: string | null
  type: string
  subtype: string | null
  balances: { current: number | null; iso_currency_code: string | null; unofficial_currency_code?: string | null }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// "up to date" must mean Plaid genuinely had nothing - never a stand-in for
// "something came back but we don't understand why nothing landed". When
// Plaid fetched rows but none became a ledger write, say why: pending
// (hasn't posted yet), unmapped (an investment account, which has no
// ledger), or re-fetched (already in the ledger - a repeat of that alone,
// sync after sync, means the cursor isn't advancing).
export function summaryLine(o: {
  inserted: number
  claimed: number
  fetched: number
  skippedPending: number
  skippedUnmapped: number
  alreadySynced: number
  lastBankRead?: string | null // Plaid's last successful pull from the bank (ISO)
  lastBankFail?: string | null
  now?: Date
}): string {
  const bank = bankStatus(o.lastBankRead ?? null, o.lastBankFail ?? null, o.now ?? new Date())
  const line = summaryCounts(o)
  return bank ? (line === 'up to date' ? bank : `${line} · ${bank}`) : line
}

// /transactions/sync only serves what Plaid last pulled from the bank; when
// that refresh keeps failing it reports "nothing new" forever. Null when
// Plaid read the bank within the last 2 days - the normal case.
function bankStatus(lastRead: string | null, lastFail: string | null, now: Date): string | null {
  const day = (iso: string) => iso.slice(0, 10)
  const failing = lastFail !== null && (lastRead === null || lastFail > lastRead)
  if (lastRead === null) return failing ? `Plaid can't read the bank (failing since ${day(lastFail!)})` : null
  const ageDays = (now.getTime() - new Date(lastRead).getTime()) / 86400000
  if (ageDays < 2) return null
  return failing
    ? `Plaid can't read the bank - last success ${day(lastRead)}, failing since ${day(lastFail!)}`
    : `Plaid last read the bank ${day(lastRead)}`
}

function summaryCounts(o: { inserted: number; claimed: number; fetched: number; skippedPending: number; skippedUnmapped: number; alreadySynced: number }): string {
  const parts: string[] = []
  if (o.inserted > 0) parts.push(`${o.inserted} new`)
  if (o.claimed > 0) parts.push(`${o.claimed} matched`)
  if (parts.length === 0 && o.fetched > 0) {
    if (o.skippedPending > 0) parts.push(`${o.skippedPending} pending`)
    if (o.skippedUnmapped > 0) parts.push(`${o.skippedUnmapped} unmapped`)
    if (o.alreadySynced > 0) parts.push(`${o.alreadySynced} re-fetched`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'up to date'
}

interface ItemOutcome {
  item: number // index into PLAID_ACCESS_TOKENS
  institution: string
  summary: string
  relink: boolean // needs the owner to log in again through Link
  error?: string
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  if (!plaidConfigured(env))
    return json({ ok: false, not_configured: true, message: 'Set PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ACCESS_TOKENS to sync banks through Plaid' })
  const dryRun = ((await request.json().catch(() => ({}))) as { dry_run?: boolean }).dry_run === true
  const db = env.DB

  const byRef = new Map(
    ((await db.prepare(`SELECT id, external_ref FROM accounts WHERE external_ref LIKE 'plaid:%'`).all()).results as Array<{ id: string; external_ref: string }>).map((a) => [
      a.external_ref,
      a.id,
    ])
  )

  const items: ItemOutcome[] = []
  const toInsert: IngestRowIn[] = []
  const created: string[] = []
  let claimed = 0
  const cursors: Array<{ itemId: string; cursor: string }> = []

  for (const [index, accessToken] of plaidTokens(env).entries()) {
    // Which bank, and is Plaid still able to read it?
    const info = await plaid<{
      item?: { item_id: string; institution_name?: string | null; error?: { error_code?: string; error_message?: string } | null }
      status?: { transactions?: { last_successful_update?: string | null; last_failed_update?: string | null } }
    }>(env, '/item/get', { access_token: accessToken })
    const institution = info.item?.institution_name ?? `Bank ${index + 1}`
    const itemError = info.item?.error?.error_code ?? info.error_code
    if (itemError === 'ITEM_LOGIN_REQUIRED' || itemError === 'PENDING_EXPIRATION') {
      items.push({ item: index, institution, summary: 'login required', relink: true })
      continue
    }
    if (itemError || !info.item) {
      items.push({ item: index, institution, summary: '', relink: false, error: `${itemError ?? 'no item'} - ${info.item?.error?.error_message ?? info.error_message ?? ''}` })
      continue
    }
    const itemId = info.item.item_id
    const lastBankRead = info.status?.transactions?.last_successful_update ?? null
    const lastBankFail = info.status?.transactions?.last_failed_update ?? null

    // Everything Plaid has since this bank's cursor.
    let cursor = (await db.prepare('SELECT cursor FROM plaid_state WHERE item_id = ?').bind(itemId).first<{ cursor: string | null }>())?.cursor ?? null
    const added: PlaidTxn[] = []
    let accounts: PlaidAccount[] = []
    let failed: string | null = null
    for (;;) {
      const page = await plaid<{ added?: PlaidTxn[]; accounts?: PlaidAccount[]; next_cursor?: string; has_more?: boolean }>(env, '/transactions/sync', {
        access_token: accessToken,
        cursor: cursor ?? undefined,
        count: 500,
      })
      if (page.error_code) {
        failed = page.error_code === 'ITEM_LOGIN_REQUIRED' ? 'relink' : `${page.error_code} - ${page.error_message}`
        break
      }
      // A 200 with none of the fields /transactions/sync always returns is
      // not an empty page; treating it as one would report "up to date"
      // over whatever went wrong.
      if (page.added === undefined && page.next_cursor === undefined) {
        failed = 'unrecognized response shape'
        break
      }
      added.push(...(page.added ?? []))
      if (page.accounts?.length) accounts = page.accounts
      cursor = page.next_cursor ?? cursor
      if (!page.has_more) break
    }
    if (failed === 'relink') {
      items.push({ item: index, institution, summary: 'login required', relink: true })
      continue
    }
    if (failed) {
      items.push({ item: index, institution, summary: '', relink: false, error: failed })
      continue
    }

    // Accounts seen for the first time become ledger accounts.
    const posted = added.filter((t) => !t.pending)
    for (const a of accounts) {
      const ref = `plaid:${a.account_id}`
      const kind = kindFor(a.type, a.subtype)
      if (byRef.has(ref) || !kind) continue
      const currency = (a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? 'USD').toUpperCase()
      const debt = kind === 'credit_card' || kind === 'line_of_credit'
      const name = `${a.name}${a.mask ? ` ${a.mask}` : ''}`
      const rows = posted.filter((t) => t.account_id === a.account_id)
      // Ledger amounts: Plaid's positive = money out. Plaid's current balance
      // on debt is the amount owed (positive); the ledger keeps debt negative.
      const current = Math.round((a.balances.current ?? 0) * 100) * (debt ? -1 : 1)
      const opening = current - rows.reduce((s, t) => s + -Math.round(t.amount * 100), 0)
      const start = rows.reduce((m, t) => (t.date < m ? t.date : m), new Date().toISOString().slice(0, 10))
      const id = await newAccountId(db, `${institution} ${a.name}`)
      if (!dryRun) {
        await db.batch([
          db
            .prepare(
              `INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending, external_ref)
               VALUES (?1, '', ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts), 1, ?6)`
            )
            .bind(id, institution, kind, currency, name, ref),
          db.prepare(`INSERT INTO ledger_anchors (account_id, date, balance_cents, source) VALUES (?1, ?2, ?3, 'derived')`).bind(id, start, opening),
        ])
      }
      byRef.set(ref, id)
      created.push(name)
    }

    let skippedPending = 0
    let skippedUnmapped = 0
    let alreadySynced = 0
    let itemClaimed = 0
    let itemNew = 0
    for (const t of added) {
      if (t.pending) {
        skippedPending++
        continue
      }
      const accountId = byRef.get(`plaid:${t.account_id}`)
      if (!accountId) {
        skippedUnmapped++
        continue
      }
      const amountCents = -Math.round(t.amount * 100) // Plaid: positive = money out
      const extId = `plaid:${t.transaction_id}`

      if (await db.prepare('SELECT id FROM transactions WHERE account_id = ? AND external_id = ?').bind(accountId, extId).first()) {
        alreadySynced++
        continue
      }

      // Same-amount rows near this date. Plaid's dates can run a few days
      // ahead of a CSV's posting dates (1-3 days, measured on real data), so
      // an exact-date match would miss twins and double the ledger. Claim the
      // NEAREST unclaimed same-amount row within +-4 days.
      const twins = (
        await db
          .prepare(
            `SELECT id, date, external_id FROM transactions
             WHERE account_id = ? AND amount_cents = ?
               AND date BETWEEN date(?, '-4 days') AND date(?, '+4 days')
             ORDER BY id`
          )
          .bind(accountId, amountCents, t.date, t.date)
          .all()
      ).results as Array<{ id: number; date: string; external_id: string | null }>
      const dayDiff = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000
      const unclaimed = twins.filter((w) => w.external_id === null).sort((a, b) => dayDiff(a.date, t.date) - dayDiff(b.date, t.date))[0]
      if (unclaimed) {
        if (!dryRun) await db.prepare('UPDATE transactions SET external_id = ? WHERE id = ?').bind(extId, unclaimed.id).run()
        itemClaimed++
        continue
      }

      // Genuinely new. Occurrence counts exact-date rows only - the claim
      // window above is wider on purpose.
      const base = `${accountId}|${t.date}|${amountCents}`
      const n = twins.filter((w) => w.date === t.date).length + 1 + toInsert.filter((r) => r.account_id === accountId && r.date === t.date && r.amount_cents === amountCents).length
      toInsert.push({
        account_id: accountId,
        date: t.date,
        description: t.merchant_name || t.name || 'Plaid transaction',
        amount_cents: amountCents,
        balance_after_cents: null,
        source_file: `plaid:${itemId}`,
        semantic_hash: await sha256(n > 1 ? `${base}#${n}` : base),
        external_id: extId,
        meta: JSON.stringify(t),
      })
      itemNew++
    }
    claimed += itemClaimed
    if (cursor) cursors.push({ itemId, cursor })
    items.push({
      item: index,
      institution,
      relink: false,
      summary: summaryLine({ inserted: itemNew, claimed: itemClaimed, fetched: added.length, skippedPending, skippedUnmapped, alreadySynced, lastBankRead, lastBankFail }),
    })
  }

  const outcome = !dryRun && toInsert.length > 0 ? await ingestRows(db, toInsert) : { inserted: 0, duplicates: 0, flagged: [], unknown_accounts: [] }
  if (!dryRun)
    for (const c of cursors)
      await db
        .prepare(
          `INSERT INTO plaid_state (item_id, cursor, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
        )
        .bind(c.itemId, c.cursor, new Date().toISOString())
        .run()

  const many = items.length > 1
  const summary = items
    .map((i) => (many ? `${i.institution}: ` : '') + (i.error ? `failed (${i.error.slice(0, 60)})` : i.summary))
    .concat(created.length ? [`added ${created.length} account${created.length > 1 ? 's' : ''}`] : [])
    .join(' · ')
  if (!dryRun) {
    await recordSync(db, 'plaid', summary)
    if (outcome.inserted > 0) waitUntil(runAutoCategorize(env).catch(() => {}))
  }
  return json({ ok: true, dry_run: dryRun, ...outcome, claimed, would_insert: toInsert.length, created, items, summary, relink: items.filter((i) => i.relink).map((i) => ({ item: i.item, institution: i.institution })) })
}
