// PUT /api/allowance/months/:month - this month's allowance on its own.
//   Body: { amount_cents, currency } or { amount_cents: null } to go back to
//   the default (only while the month isn't locked; a lock keeps its row).
// POST /api/allowance/months/:month - lock or unlock the month's plan.
//   Body: { locked: true, snapshot: {...} } | { locked: false }. The snapshot
//   (allowance, items, the baseline as the forecast showed it) is built by
//   the client, which holds the projection.

import type { Env } from '../../_lib'
import { json, error, homeCurrency } from '../../_lib'
import { isCurrency, isMonth } from '../_lib'

async function amountFor(db: D1Database, month: string, home: string) {
  return (
    (await db
      .prepare('SELECT amount_cents, currency FROM allowance_months WHERE month = ?')
      .bind(month)
      .first<{ amount_cents: number; currency: string }>()) ??
    (await db
      .prepare(`SELECT amount_cents, currency FROM allowance_months WHERE month = 'default'`)
      .first<{ amount_cents: number; currency: string }>()) ?? { amount_cents: 0, currency: home }
  )
}

export const onRequestPut: PagesFunction<Env> = async ({ env, params, request }) => {
  const month = params.month as string
  if (!isMonth(month)) return error('month must be YYYY-MM')
  let b: { amount_cents?: number | null; currency?: string }
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (b.amount_cents === null) {
    const row = await env.DB.prepare('SELECT locked_at FROM allowance_months WHERE month = ?').bind(month).first<{ locked_at: string | null }>()
    if (row?.locked_at) {
      const d = await amountFor(env.DB, 'default', homeCurrency(env))
      await env.DB.prepare('UPDATE allowance_months SET amount_cents = ?, currency = ? WHERE month = ?').bind(d.amount_cents, d.currency, month).run()
    } else await env.DB.prepare('DELETE FROM allowance_months WHERE month = ?').bind(month).run()
    return json({ ok: true })
  }
  if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) < 0) return error('amount_cents must be a whole number >= 0')
  if (!isCurrency(b.currency)) return error('currency must be a 3-letter code')
  await env.DB.prepare(
    `INSERT INTO allowance_months (month, amount_cents, currency) VALUES (?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET amount_cents = excluded.amount_cents, currency = excluded.currency`
  )
    .bind(month, b.amount_cents, b.currency)
    .run()
  return json({ ok: true })
}

export const onRequestPost: PagesFunction<Env> = async ({ env, params, request }) => {
  const month = params.month as string
  if (!isMonth(month)) return error('month must be YYYY-MM')
  let b: { locked?: boolean; snapshot?: unknown }
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (b.locked) {
    if (!b.snapshot || typeof b.snapshot !== 'object') return error('snapshot required to lock')
    const a = await amountFor(env.DB, month, homeCurrency(env))
    // Locking pins the month's amount too: a later change to the default
    // must not move a locked month.
    await env.DB.prepare(
      `INSERT INTO allowance_months (month, amount_cents, currency, locked_at, snapshot) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET locked_at = excluded.locked_at, snapshot = excluded.snapshot`
    )
      .bind(month, a.amount_cents, a.currency, new Date().toISOString(), JSON.stringify(b.snapshot))
      .run()
  } else {
    await env.DB.prepare('UPDATE allowance_months SET locked_at = NULL, snapshot = NULL WHERE month = ?').bind(month).run()
  }
  return json({ ok: true })
}
