// POST /api/fx-refresh - fetch live FX rates and upsert into fx_rates.
// GET  /api/fx-refresh - return the current stored rates without fetching.

import type { Env } from './_lib'
import { json, error, homeCurrency, currenciesInUse } from './_lib'

// Rates come from frankfurter.app (European Central Bank reference rates,
// free, no key). A currency it doesn't publish simply gets no rate, and
// amounts in it show unconverted.
export async function fetchRates(currencies: string[]): Promise<{ date: string; rates: Record<string, number> }> {
  if (currencies.length === 0) return { date: new Date().toISOString().slice(0, 10), rates: {} }
  const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${currencies.join(',')}`)
  if (!res.ok) throw new Error(`frankfurter API ${res.status}`)
  const data = (await res.json()) as { date: string; rates: Record<string, number> }
  return data
}

async function storedRates(db: D1Database) {
  const rows = (
    await db
      .prepare(
        `SELECT from_currency, rate, date FROM fx_rates
         WHERE to_currency = 'USD' AND date = (SELECT MAX(date) FROM fx_rates WHERE to_currency = 'USD')`
      )
      .all()
  ).results as Array<{ from_currency: string; rate: number; date: string }>
  const fx: Record<string, number> = {}
  let date: string | null = null
  for (const r of rows) {
    fx[r.from_currency] = r.rate
    date = r.date
  }
  return { fx, date }
}

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  let data: { date: string; rates: Record<string, number> }
  try {
    data = await fetchRates((await currenciesInUse(env.DB, homeCurrency(env))).filter((c) => c !== 'USD'))
  } catch (e) {
    return error(`FX fetch failed: ${e instanceof Error ? e.message : 'unknown'}`, 502)
  }
  // frankfurter returns rates FROM USD, e.g. { CAD: 1.37, EUR: 0.92 }
  // We store as "currency -> USD", i.e. 1/rate.
  const stmts = [
    env.DB.prepare(
      `INSERT INTO fx_rates (date, from_currency, to_currency, rate) VALUES (?, 'USD', 'USD', 1.0)
       ON CONFLICT(date, from_currency, to_currency) DO UPDATE SET rate = excluded.rate`
    ).bind(data.date),
    ...Object.keys(data.rates).map((c) =>
      env.DB.prepare(
        `INSERT INTO fx_rates (date, from_currency, to_currency, rate) VALUES (?, ?, 'USD', ?)
         ON CONFLICT(date, from_currency, to_currency) DO UPDATE SET rate = excluded.rate`
      ).bind(data.date, c, 1 / data.rates[c])
    ),
  ]
  await env.DB.batch(stmts)
  const { fx, date } = await storedRates(env.DB)
  return json({ ok: true, fx, fx_date: date })
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { fx, date } = await storedRates(env.DB)
  return json({ fx, fx_date: date })
}
