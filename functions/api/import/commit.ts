// POST /api/import/commit - write screenshot rows the user chose to import.
// Body: { account_id, rows: [{ date, description, amount_cents,
// balance_cents }] }. Goes through ingestRows like every other source, with
// the CSV importer's semantic-hash scheme (account|date|amount + occurrence,
// see cli/formats.ts), so a later CSV download of the same days dedups
// against these rows instead of doubling them.

import type { Env } from '../_lib'
import { json, error, ingestRows, type IngestRowIn } from '../_lib'
import { runAutoCategorize } from '../_autocat'

interface Row {
  date: string
  description: string
  amount_cents: number
  balance_cents: number | null
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Occurrence numbering starts past whatever the ledger already holds for
// the same account/date/amount: these rows were chosen as NEW, so a second
// identical same-day charge must not collide with the first one's hash.
export async function buildRows(db: D1Database, accountId: string, rows: Row[], source: string): Promise<IngestRowIn[]> {
  const existing = new Set(
    (
      await db
        .prepare('SELECT semantic_hash FROM transactions WHERE account_id = ?')
        .bind(accountId)
        .all<{ semantic_hash: string }>()
    ).results.map((r) => r.semantic_hash)
  )
  const out: IngestRowIn[] = []
  // Oldest first, so ids (and running balances) follow the bank's order.
  for (const r of [...rows].reverse()) {
    const key = `${accountId}|${r.date}|${r.amount_cents}`
    let n = 1
    let hash = await sha256(key)
    while (existing.has(hash)) hash = await sha256(`${key}#${++n}`)
    existing.add(hash)
    out.push({
      account_id: accountId,
      date: r.date,
      description: r.description,
      amount_cents: r.amount_cents,
      balance_after_cents: r.balance_cents,
      source_file: source,
      semantic_hash: hash,
      external_id: null,
    })
  }
  return out
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  let body: { account_id?: string; rows?: Row[] }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!body.account_id || !Array.isArray(body.rows) || body.rows.length === 0)
    return error('account_id and rows required')
  if (body.rows.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isInteger(r.amount_cents) || !r.description?.trim()))
    return error('every row needs a date, description and integer amount_cents')
  const rows = await buildRows(env.DB, body.account_id, body.rows, `screenshot:${new Date().toISOString().slice(0, 10)}`)
  const outcome = await ingestRows(env.DB, rows)
  // Same follow-up as a sync: name new merchants, pair transfers, categorize.
  if (outcome.inserted > 0) waitUntil(runAutoCategorize(env).catch(() => {}))
  return json(outcome)
}
