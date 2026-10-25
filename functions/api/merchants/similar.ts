// GET /api/merchants/similar?merchant_key=... - every transaction sharing a
// key, ACROSS ALL ACCOUNTS. This is the blast-radius preview for "apply to
// all similar": aliases are global, so a preview built from one account's
// rows would understate what a key-wide decision touches.

import type { Env } from '../_lib'
import { json, error } from '../_lib'

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const key = new URL(request.url).searchParams.get('merchant_key')?.trim()
  if (!key) return error('merchant_key required')

  const rows = (
    await env.DB.prepare(
      `SELECT t.id, t.date, t.amount_cents,
              (t.merchant_override_id IS NOT NULL) AS overridden,
              a.display_name AS account_name, a.currency
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.merchant_key = ? ORDER BY t.date DESC LIMIT 100`
    )
      .bind(key)
      .all()
  ).results

  return json({ transactions: rows })
}
