// GET /api/merchants - every merchant with its alias count and transaction
// count, for the assign sheet's picker.

import type { Env } from './_lib'
import { json } from './_lib'

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = (
    await env.DB.prepare(
      `SELECT m.id, m.household_name, m.concept, m.transfer_account_id,
              m.category_id, m.small_category_id, m.small_max_cents,
              COUNT(DISTINCT a.normalized_raw) AS alias_count,
              (SELECT COUNT(*) FROM transactions t
               WHERE t.merchant_key IN (SELECT a2.normalized_raw FROM merchant_aliases a2 WHERE a2.merchant_id = m.id)) AS tx_count
       FROM merchants m
       LEFT JOIN merchant_aliases a ON a.merchant_id = m.id
       GROUP BY m.id
       ORDER BY tx_count DESC`
    ).all()
  ).results
  return json({ merchants: rows })
}
