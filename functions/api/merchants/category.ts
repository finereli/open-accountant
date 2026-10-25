// POST /api/merchants/category - put a merchant in a category: the
// apply-to-all. Every transaction of the merchant, past and future, moves
// (a merchant's human category beats the per-row auto pick in tx_resolved).
//
// Body: { merchant_id: number,
//         category_id: number | null,          -- null = back to Uncategorized
//         small_category_id?: number | null,   -- price gate (set both or
//         small_max_cents?: number | null,     -- neither): |amount| <= max
//                                                 goes to small_category_id
//         transaction_id?: number,             -- the row the decision was made from
//                                                 (logged as a correction if it overrode
//                                                 the auto-categorizer)
//         reason?: string }                    -- optional "why", saved as a rule
//
// Rows a person categorized one by one keep their own category.

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { resolvedBefore, logCorrection, addRule } from '../_corrections'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: {
    merchant_id?: number
    category_id?: number | null
    small_category_id?: number | null
    small_max_cents?: number | null
    transaction_id?: number
    reason?: string
  }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!body.merchant_id) return error('merchant_id required')

  const db = env.DB
  const m = await db
    .prepare('SELECT id, household_name, concept, transfer_account_id FROM merchants WHERE id = ?')
    .bind(body.merchant_id)
    .first<{ id: number; household_name: string | null; concept: string | null; transfer_account_id: string | null }>()
  if (!m) return error('Unknown merchant', 404)
  // Transfer merchants are excluded from spending by construction, and the
  // reserved keep-as-is merchant spans unrelated raw keys - neither can
  // carry one category.
  if (m.transfer_account_id) return error('Transfer merchants are excluded from spending')
  if (m.household_name === null && m.concept === null) return error('Keep-as-is transactions have no shared category')

  for (const id of [body.category_id, body.small_category_id]) {
    if (id != null) {
      const c = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(id).first()
      if (!c) return error('Unknown category', 404)
    }
  }
  const gateOn = body.small_category_id != null && body.small_max_cents != null && body.small_max_cents > 0
  if ((body.small_category_id != null) !== (body.small_max_cents != null))
    return error('Gate needs both small_category_id and small_max_cents')

  const before = body.transaction_id ? await resolvedBefore(db, body.transaction_id) : null

  await db
    .prepare('UPDATE merchants SET category_id = ?, small_category_id = ?, small_max_cents = ?, category_auto = 0 WHERE id = ?')
    .bind(
      body.category_id ?? null,
      gateOn ? body.small_category_id : null,
      gateOn ? body.small_max_cents : null,
      m.id
    )
    .run()

  if (before && body.category_id != null) {
    const c = await db.prepare('SELECT name FROM categories WHERE id = ?').bind(body.category_id).first<{ name: string }>()
    await logCorrection(db, before, 'category', c?.name ?? null, 'all')
  }
  const reason = body.reason?.trim()
  if (reason) await addRule(db, reason, body.transaction_id ?? null)

  const affected = await db
    .prepare('SELECT COUNT(*) AS n FROM tx_resolved WHERE res_merchant_id = ?')
    .bind(m.id)
    .first<{ n: number }>()
  return json({ ok: true, transactions_covered: affected?.n ?? 0 })
}
