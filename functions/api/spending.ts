// GET /api/spending?month=YYYY-MM - one month of category totals across all
// in_spending accounts, broken down by merchant, in native currencies. The
// client aggregates and converts with the same FX table the dashboard uses.
//
// Merchant and category come from the tx_resolved view (schema.sql), the
// one resolver every screen shares. Transfer merchants are excluded by
// construction. Rows with no category come back with category_id null -
// the Uncategorized bucket the UI pins last.

import type { Env } from './_lib'
import { json, error } from './_lib'

export interface SpendingRow {
  category_id: number | null
  merchant_id: number | null
  label: string
  currency: string
  debt: number // 1 = row lives on a credit card / line of credit
  total_cents: number
  count: number
}

// Transfer rows are excluded from spending - except the debt flows worth
// seeing: the CASH-side leg of a transfer to or from a DEBT account shows up
// as Debt Repay (money into debt) or Debt Borrow (cash pulled from debt),
// both excluded-kind categories, so they render under Net without being
// counted. The debt-side legs stay hidden (counting both would cancel out).
export async function spendingRows(
  db: D1Database,
  from: string,
  to: string,
  debtRepayId: number | null,
  debtBorrowId: number | null
): Promise<SpendingRow[]> {
  return (
    await db
      .prepare(
        `SELECT
           CASE
             WHEN r.transfer_account_id IS NOT NULL THEN
               CASE WHEN r.amount_cents < 0 THEN ?3 ELSE ?4 END
             ELSE r.res_category_id
           END AS category_id,
           r.res_merchant_id AS merchant_id,
           CASE WHEN r.transfer_account_id IS NOT NULL
                THEN (CASE WHEN r.amount_cents < 0 THEN 'To ' ELSE 'From ' END) || tgt.display_name
                ELSE COALESCE(r.merchant_name, r.merchant_concept, r.merchant_key, r.description)
           END AS label,
           ac.currency AS currency,
           CASE WHEN ac.kind IN ('credit_card', 'line_of_credit') THEN 1 ELSE 0 END AS debt,
           SUM(r.amount_cents) AS total_cents,
           COUNT(*) AS count
         FROM tx_resolved r
         JOIN accounts ac ON ac.id = r.account_id AND ac.in_spending = 1
         LEFT JOIN accounts tgt ON tgt.id = r.transfer_account_id
         WHERE r.date >= ?1 AND r.date < ?2
           AND (r.transfer_account_id IS NULL
                OR (?3 IS NOT NULL
                    AND ac.kind NOT IN ('credit_card', 'line_of_credit')
                    AND tgt.kind IN ('credit_card', 'line_of_credit')))
         GROUP BY 1, 2, 3, 4, 5`
      )
      .bind(from, to, debtRepayId, debtBorrowId)
      .all()
  ).results as unknown as SpendingRow[]
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const month = new URL(request.url).searchParams.get('month') ?? ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return error('month must be YYYY-MM')
  const [y, mo] = month.split('-').map(Number)
  const from = `${month}-01`
  const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`

  const categories = (await env.DB.prepare('SELECT id, name, kind, sort FROM categories ORDER BY sort, id').all())
    .results as Array<{ id: number; name: string }>
  const idOf = (name: string) => categories.find((c) => c.name === name)?.id ?? null
  const rows = await spendingRows(env.DB, from, to, idOf('Debt Repay'), idOf('Debt Borrow'))
  return json({ month, rows, categories })
}
