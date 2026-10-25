// POST /api/checkpoints - record a reconciliation checkpoint and lock every
// transaction up to its date. The server recomputes the ledger balance and
// returns the discrepancy so the record always says what both sides showed.

import type { Env } from './_lib'
import { json, error } from './_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { account_id?: string; date?: string; balance_cents?: number }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const { account_id, date, balance_cents } = body
  if (!account_id || !date || typeof balance_cents !== 'number' || !Number.isInteger(balance_cents))
    return error('account_id, date, balance_cents (integer) required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return error('date must be YYYY-MM-DD')

  const db = env.DB
  const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(account_id).first()
  if (!account) return error('Unknown account', 404)

  const anchor = await db
    .prepare('SELECT date, balance_cents FROM ledger_anchors WHERE account_id = ?')
    .bind(account_id)
    .first<{ date: string; balance_cents: number }>()
  const anchorDate = anchor?.date ?? '0000-01-01'
  const anchorCents = anchor?.balance_cents ?? 0

  const sum = await db
    .prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE account_id = ? AND date >= ? AND date <= ?'
    )
    .bind(account_id, anchorDate, date)
    .first<{ s: number }>()
  const computed = anchorCents + (sum?.s ?? 0)

  // A matched checkpoint freezes the period (locked rows, ingest gate). A
  // mismatched one only ATTESTS: the institution's number is recorded as
  // ground truth and the account is flagged, but the period stays open so
  // the correcting transactions can land. When they do and the live
  // discrepancy hits zero, the freeze engages by itself.
  const matched = balance_cents === computed
  const stmts = [
    db
      .prepare(
        'INSERT INTO reconciliation_checkpoints (account_id, date, balance_cents, computed_cents, verified_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(account_id, date, balance_cents, computed, new Date().toISOString()),
  ]
  if (matched)
    stmts.push(
      db.prepare('UPDATE transactions SET locked = 1 WHERE account_id = ? AND date <= ?').bind(account_id, date)
    )
  await db.batch(stmts)

  return json({ ok: true, computed_cents: computed, discrepancy_cents: balance_cents - computed, matched })
}
