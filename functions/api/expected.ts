// POST /api/expected - create an expected item for the forecast.
// Body: { name, kind: 'income'|'expense', amount_cents (positive), currency,
//         day_of_month? | date?, end_month?, account_id?, category_id? }

import type { Env } from './_lib'
import { json, error, isCurrency } from './_lib'

export function validateItem(b: {
  name?: string
  kind?: string
  amount_cents?: number
  currency?: string
  day_of_month?: number | null
  date?: string | null
  end_month?: string | null
  end_date?: string | null
  per_day?: boolean
}): string | null {
  if (!b.name?.trim()) return 'name required'
  if (b.kind !== 'income' && b.kind !== 'expense') return 'kind must be income or expense'
  if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) <= 0)
    return 'amount_cents must be a positive integer'
  if (!isCurrency(b.currency)) return 'currency must be a 3-letter code'
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
  const hasDay = b.day_of_month != null
  const hasDate = !!b.date

  if (b.per_day) {
    if (hasDay || hasDate) return 'a daily rate cannot have day_of_month or date'
    return null
  }

  if (hasDay === hasDate) return 'exactly one of day_of_month or date'
  if (hasDay && (!Number.isInteger(b.day_of_month) || (b.day_of_month as number) < 1 || (b.day_of_month as number) > 31))
    return 'day_of_month must be 1-31'
  if (hasDate && !isDate(b.date as string)) return 'date must be YYYY-MM-DD'
  if (b.end_month && !/^\d{4}-\d{2}$/.test(b.end_month)) return 'end_month must be YYYY-MM'
  return null
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let b: Parameters<typeof validateItem>[0] & { account_id?: string | null; category_id?: number | null }
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const bad = validateItem(b)
  if (bad) return error(bad)
  const res = await env.DB.prepare(
    `INSERT INTO expected_items (name, kind, amount_cents, currency, day_of_month, date, end_month, end_date, per_day, account_id, category_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      b.name!.trim(),
      b.kind,
      b.amount_cents,
      b.currency,
      b.day_of_month ?? null,
      b.date ?? null,
      b.end_month ?? null,
      b.end_date ?? null,
      b.per_day ? 1 : 0,
      b.account_id ?? null,
      b.category_id ?? null,
      new Date().toISOString()
    )
    .run()
  return json({ ok: true, id: res.meta.last_row_id })
}
