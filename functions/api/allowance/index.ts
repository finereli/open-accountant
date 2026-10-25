// GET /api/allowance - the fun allowance: the default monthly amount, the
//   months set on their own (with their lock), and plan items, from the
//   current month on. The Forecast screen projects them.
// PUT /api/allowance - set the default. Body: { amount_cents, currency }

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { isCurrency } from './_lib'

export async function allowanceData(db: D1Database) {
  const env = { DB: db }
  const thisMonth = new Date().toISOString().slice(0, 7)
  const [months, items] = await Promise.all([
    env.DB.prepare('SELECT month, amount_cents, currency, locked_at, snapshot FROM allowance_months ORDER BY month').all(),
    env.DB.prepare('SELECT * FROM plan_items WHERE month >= ? ORDER BY month, date IS NULL, date, id').bind(thisMonth).all(),
  ])
  const rows = months.results as Array<{ month: string; snapshot: string | null } & Record<string, unknown>>
  const dflt = rows.find((m) => m.month === 'default') ?? null
  return {
    default: dflt ? { amount_cents: dflt.amount_cents as number, currency: dflt.currency as string } : null,
    months: rows
      .filter((m) => m.month !== 'default' && m.month >= thisMonth)
      .map((m) => ({ ...m, snapshot: m.snapshot ? JSON.parse(m.snapshot) : null })),
    items: items.results,
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => json(await allowanceData(env.DB))

export const onRequestPut: PagesFunction<Env> = async ({ env, request }) => {
  let b: { amount_cents?: number; currency?: string }
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) < 0) return error('amount_cents must be a whole number >= 0')
  if (!isCurrency(b.currency)) return error('currency must be a 3-letter code')
  await env.DB.prepare(
    `INSERT INTO allowance_months (month, amount_cents, currency) VALUES ('default', ?, ?)
     ON CONFLICT(month) DO UPDATE SET amount_cents = excluded.amount_cents, currency = excluded.currency`
  )
    .bind(b.amount_cents, b.currency)
    .run()
  return json({ ok: true })
}
