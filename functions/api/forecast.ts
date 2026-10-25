// GET /api/forecast?days=60 - the forecast's measured inputs: daily burn per
// run-rate category (native-currency sums over the trailing window) and the
// expected-items list. The projection itself runs client-side (src/lib/
// forecast.ts) so edits redraw instantly; cash starting balances come from
// the accounts the client already holds.

import type { Env } from './_lib'
import { json, error } from './_lib'

export interface BurnRow {
  category_id: number
  name: string
  currency: string
  total_cents: number
  pinned_daily_cents: number | null
  pinned_currency: string | null
}

export async function burnRows(db: D1Database, from: string, to: string): Promise<BurnRow[]> {
  return (
    await db
      .prepare(
        `SELECT c.id AS category_id, c.name, ac.currency,
                SUM(t.amount_cents) AS total_cents,
                c.pinned_daily_cents, c.pinned_currency
         FROM tx_resolved t
         JOIN accounts ac ON ac.id = t.account_id AND ac.in_spending = 1
         JOIN categories c ON c.id = t.res_category_id
         WHERE t.date >= ?1 AND t.date < ?2
           AND t.transfer_account_id IS NULL AND c.flow = 'run_rate'
         GROUP BY c.id, ac.currency`
      )
      .bind(from, to)
      .all()
  ).results as unknown as BurnRow[]
}

// Subscription categories (flow='subscriptions') are derived, not
// maintained: each merchant with charges in the trailing 35 days becomes a
// monthly item at its usual day - last charge's day-of-month, amount = the
// 35-day sum (so multi-charge merchants like inbox batches total up).
// Cancelled subs age out; new ones appear on their own.
export interface SubRow {
  merchant_id: number
  name: string
  currency: string
  monthly_cents: number // positive magnitude
  day: number
  end_date: string | null // set = cancelled/ending (from sub_overrides)
}

const DAY = 86400000
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / DAY)

export async function subRows(db: D1Database, today: string): Promise<SubRow[]> {
  // Fetch a wide window of individual charges, then take only the LAST
  // billing cycle per merchant: charges within 14 days of its most recent
  // charge. A batch of charges on adjacent days (e.g. inbox fees) sums into
  // one monthly figure, while a monthly sub whose previous cycle also fell
  // inside a flat window is not double-counted. Aged out if the last charge
  // is older than 35 days (a monthly sub that stopped charging = gone).
  const from = new Date(new Date(today + 'T00:00:00Z').getTime() - 49 * DAY).toISOString().slice(0, 10)
  const rows = (
    await db
      .prepare(
        `SELECT m.id AS merchant_id,
                COALESCE(m.household_name, m.concept) AS name,
                ac.currency,
                t.date AS date,
                t.amount_cents AS amount_cents,
                o.end_date AS end_date
         FROM tx_resolved t
         JOIN accounts ac ON ac.id = t.account_id AND ac.in_spending = 1
         JOIN merchants m ON m.id = t.res_merchant_id
         JOIN categories c ON c.id = t.res_category_id AND c.flow = 'subscriptions'
         LEFT JOIN sub_overrides o ON o.merchant_id = m.id
         WHERE t.date >= ?1 AND t.date <= ?2 AND t.amount_cents < 0`
      )
      .bind(from, today)
      .all()
  ).results as Array<{
    merchant_id: number
    name: string
    currency: string
    date: string
    amount_cents: number
    end_date: string | null
  }>

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = `${r.merchant_id}|${r.currency}`
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(r)
  }

  const out: SubRow[] = []
  for (const g of groups.values()) {
    const last = g.reduce((m, r) => (r.date > m ? r.date : m), g[0].date)
    if (daysBetween(today, last) > 35) continue // aged out
    const cycle = g.filter((r) => daysBetween(last, r.date) <= 14)
    const monthly = -cycle.reduce((s, r) => s + r.amount_cents, 0)
    if (monthly <= 0) continue
    out.push({
      merchant_id: g[0].merchant_id,
      name: g[0].name,
      currency: g[0].currency,
      monthly_cents: monthly,
      day: Number(last.slice(8)),
      end_date: g[0].end_date,
    })
  }
  return out
}

export async function forecastData(db: D1Database, days: number) {
  const env = { DB: db }
  const today = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

  const [burn, subs, items, pinned] = await Promise.all([
    burnRows(env.DB, from, today),
    subRows(env.DB, today),
    env.DB.prepare('SELECT * FROM expected_items ORDER BY kind DESC, day_of_month, date').all(),
    // Pinned run-rate categories with no activity in the window still burn.
    env.DB.prepare(
      `SELECT id AS category_id, name, pinned_currency AS currency, 0 AS total_cents,
              pinned_daily_cents, pinned_currency
       FROM categories WHERE flow = 'run_rate' AND pinned_daily_cents IS NOT NULL`
    ).all(),
  ])
  const seen = new Set(burn.map((b) => b.category_id))
  const extra = (pinned.results as unknown as BurnRow[]).filter((p) => !seen.has(p.category_id))
  return { days, from, to: today, burn: [...burn, ...extra], subs, items: items.results }
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const days = Number(new URL(request.url).searchParams.get('days') ?? '60')
  if (!Number.isInteger(days) || days < 7 || days > 365) return error('days must be 7-365')
  return json(await forecastData(env.DB, days))
}
