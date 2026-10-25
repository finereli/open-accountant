// GET /api/spending-txns?month=YYYY-MM&merchant_id=N  (or &label=... for
// rows with no merchant) [&category_id=N|none] - the transactions behind one
// merchant line in the Spending view, newest first. Same resolver as
// /api/spending (tx_resolved), in_spending accounts only. A merchant can sit
// under several categories (categories are per transaction), so the line's
// category narrows it; without one, every category is listed.

import type { Env } from './_lib'
import { json, error } from './_lib'

export interface SpendingTxn {
  id: number
  date: string
  description: string
  memo: string | null
  amount_cents: number
  currency: string
  account_name: string
}

export async function spendingTxns(
  db: D1Database,
  from: string,
  to: string,
  merchantId: number | null,
  label: string | null,
  categoryId?: number | null // undefined = any category; null = uncategorized
): Promise<SpendingTxn[]> {
  const base = `
    SELECT t.id, t.date, t.description, t.memo, t.amount_cents,
           ac.currency, ac.display_name AS account_name
    FROM tx_resolved t
    JOIN accounts ac ON ac.id = t.account_id AND ac.in_spending = 1
    WHERE t.date >= ?1 AND t.date < ?2
      AND (?4 = 0 OR t.res_category_id IS ?5) AND `
  const cat = [categoryId === undefined ? 0 : 1, categoryId ?? null] as const
  const stmt =
    merchantId !== null
      ? db.prepare(base + 't.res_merchant_id = ?3 ORDER BY t.date DESC, t.id DESC').bind(from, to, merchantId, ...cat)
      : db
          .prepare(
            base +
              't.res_merchant_id IS NULL AND COALESCE(t.merchant_key, t.description) = ?3 ORDER BY t.date DESC, t.id DESC'
          )
          .bind(from, to, label, ...cat)
  return (await stmt.all()).results as unknown as SpendingTxn[]
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url)
  const month = url.searchParams.get('month') ?? ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return error('month must be YYYY-MM')
  const [y, mo] = month.split('-').map(Number)
  const from = `${month}-01`
  const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`

  const midRaw = url.searchParams.get('merchant_id')
  const label = url.searchParams.get('label')
  const merchantId = midRaw !== null ? Number(midRaw) : null
  if (merchantId !== null && !Number.isInteger(merchantId)) return error('merchant_id must be an integer')
  if (merchantId === null && !label) return error('merchant_id or label required')

  const catRaw = url.searchParams.get('category_id')
  const categoryId = catRaw === null ? undefined : catRaw === 'none' ? null : Number(catRaw)
  if (categoryId !== undefined && categoryId !== null && !Number.isInteger(categoryId))
    return error('category_id must be an integer or none')

  return json({ transactions: await spendingTxns(env.DB, from, to, merchantId, label, categoryId) })
}
