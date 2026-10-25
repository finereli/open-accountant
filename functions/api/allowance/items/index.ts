// POST /api/allowance/items - add a plan item.
//   Body: { month, name, amount_cents, currency, date?, active? }

import type { Env } from '../../_lib'
import { json, error } from '../../_lib'
import { validateItem, type ItemBody } from '../_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let b: ItemBody
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const bad = validateItem(b)
  if (bad) return error(bad)
  const res = await env.DB.prepare(
    'INSERT INTO plan_items (month, name, amount_cents, currency, date, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(b.month, b.name!.trim(), b.amount_cents, b.currency, b.date ?? null, b.active === false ? 0 : 1, new Date().toISOString())
    .run()
  return json({ ok: true, id: Number(res.meta.last_row_id) })
}
