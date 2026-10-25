// POST /api/transactions/category - a person's category for ONE transaction,
// above every other source (see tx_resolved). For "every transaction of this
// merchant" use /api/merchants/category instead.
//
// Body: { transaction_id: number,
//         category_id: number | null,  -- null = drop the row decision (back to automatic)
//         reason?: string }            -- optional "why", saved as a rule

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { resolvedBefore, logCorrection, addRule } from '../_corrections'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { transaction_id?: number; category_id?: number | null; reason?: string }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!body.transaction_id) return error('transaction_id required')
  if (body.category_id === undefined) return error('category_id required (null clears)')
  const db = env.DB

  let catName: string | null = null
  if (body.category_id !== null) {
    const c = await db.prepare('SELECT name FROM categories WHERE id = ?').bind(body.category_id).first<{ name: string }>()
    if (!c) return error('Unknown category', 404)
    catName = c.name
  }
  const before = await resolvedBefore(db, body.transaction_id)
  if (!before) return error('Unknown transaction', 404)

  await db
    .prepare('UPDATE transactions SET category_id = ?, category_confirmed = ? WHERE id = ?')
    .bind(body.category_id, body.category_id === null ? 0 : 1, body.transaction_id)
    .run()
  if (body.category_id !== null) await logCorrection(db, before, 'category', catName, 'row')
  const reason = body.reason?.trim()
  if (reason) await addRule(db, reason, body.transaction_id)
  return json({ ok: true })
}
