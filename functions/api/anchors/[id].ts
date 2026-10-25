// PUT /api/anchors/:id - set an account's starting balance. Refused once the
// account has any reconciliation checkpoint: the anchor is then part of
// verified history and changing it would silently move every balance.

import type { Env } from '../_lib'
import { json, error, lastCheckpointDate } from '../_lib'

export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = params.id as string
  let body: { date?: string; balance_cents?: number; source?: string }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const { date, balance_cents } = body
  const source = body.source ?? 'manual'
  if (!date || typeof balance_cents !== 'number' || !Number.isInteger(balance_cents))
    return error('date, balance_cents (integer) required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return error('date must be YYYY-MM-DD')
  if (!['manual', 'absorbed', 'derived'].includes(source)) return error('bad source')

  const db = env.DB
  const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first()
  if (!account) return error('Unknown account', 404)

  if (await lastCheckpointDate(db, id))
    return error('This ledger has reconciliation checkpoints; unlock them before moving the anchor', 409)

  await db
    .prepare(
      `INSERT INTO ledger_anchors (account_id, date, balance_cents, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE
         SET date = excluded.date, balance_cents = excluded.balance_cents, source = excluded.source`
    )
    .bind(id, date, balance_cents, source)
    .run()

  return json({ ok: true })
}
