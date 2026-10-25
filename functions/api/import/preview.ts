// POST /api/import/preview - which screenshot rows the ledger already has.
// Body: { account_id, rows: [{ date, amount_cents }] } newest first, as read.
// Returns { matches: (ledger id | null)[], ledger_balance_cents, locked_before }
// - the ledger's balance at the newest row's date before importing, and the
// last verified checkpoint: rows dated before it can't be imported (ingest
// refuses them), so the review doesn't offer them.
//
// A screenshot usually overlaps what a CSV or sync already brought in, and
// those rows must be skipped, not doubled. Matching is by amount near the
// date: bank feeds can date rows 0-3 days AHEAD of the bank's posting date, so a
// ledger row may sit from a day before to four days after. Exact-date pairs
// are taken first, so a run of identical daily charges pairs up day by day
// rather than greedily grabbing a neighbour's twin.

import type { Env } from '../_lib'
import { json, error, lastVerifiedDate } from '../_lib'

interface Row {
  date: string
  amount_cents: number
}

const DAY = 86400000
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

export async function matchLedger(db: D1Database, accountId: string, rows: Row[]): Promise<(number | null)[]> {
  if (rows.length === 0) return []
  const dates = rows.map((r) => r.date).sort()
  const ledger = (
    await db
      .prepare(
        `SELECT id, date, amount_cents FROM transactions
         WHERE account_id = ? AND date BETWEEN date(?, '-1 day') AND date(?, '+4 days')
         ORDER BY date, id`
      )
      .bind(accountId, dates[0], dates[dates.length - 1])
      .all<{ id: number; date: string; amount_cents: number }>()
  ).results
  const used = new Set<number>()
  const matches: (number | null)[] = rows.map(() => null)
  // Oldest first (rows arrive newest first), exact dates before near ones.
  const order = rows.map((_, i) => i).reverse()
  for (const exactOnly of [true, false]) {
    for (const i of order) {
      if (matches[i] !== null) continue
      const r = rows[i]
      const hit = ledger.find((l) => {
        if (used.has(l.id) || l.amount_cents !== r.amount_cents) return false
        const d = days(r.date, l.date)
        return exactOnly ? d === 0 : d >= -1 && d <= 4
      })
      if (hit) {
        used.add(hit.id)
        matches[i] = hit.id
      }
    }
  }
  return matches
}

// The ledger's balance at the end of `date`, so the client can show whether
// importing the new rows makes the ledger agree with the bank.
export async function ledgerBalanceAt(db: D1Database, accountId: string, date: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT balance_cents FROM ledger_anchors WHERE account_id = ?1), 0) +
              COALESCE((SELECT SUM(amount_cents) FROM transactions
                        WHERE account_id = ?1
                          AND date >= COALESCE((SELECT date FROM ledger_anchors WHERE account_id = ?1), '0000-01-01')
                          AND date <= ?2), 0) AS bal`
    )
    .bind(accountId, date)
    .first<{ bal: number }>()
  return row?.bal ?? 0
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { account_id?: string; rows?: Row[] }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!body.account_id || !Array.isArray(body.rows)) return error('account_id and rows required')
  const rows = body.rows
  if (rows.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isInteger(r.amount_cents)))
    return error('every row needs a date and integer amount_cents')
  const newest = rows.map((r) => r.date).sort().at(-1)
  return json({
    matches: await matchLedger(env.DB, body.account_id, rows),
    ledger_balance_cents: newest ? await ledgerBalanceAt(env.DB, body.account_id, newest) : null,
    locked_before: await lastVerifiedDate(env.DB, body.account_id),
  })
}
