// PATCH /api/allowance/items/:id - edit or toggle. Body: any of
//   { name, amount_cents, currency, date, active }
// DELETE /api/allowance/items/:id

import type { Env } from '../../_lib'
import { json, error } from '../../_lib'
import { validateItem, type ItemBody } from '../_lib'

export const onRequestPatch: PagesFunction<Env> = async ({ env, params, request }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad item id')
  let b: ItemBody
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const cur = await env.DB.prepare('SELECT * FROM plan_items WHERE id = ?').bind(id).first<{ month: string; name: string; amount_cents: number; currency: string; date: string | null; active: number }>()
  if (!cur) return error('Unknown item', 404)
  const next = {
    month: cur.month,
    name: b.name ?? cur.name,
    amount_cents: b.amount_cents ?? cur.amount_cents,
    currency: b.currency ?? cur.currency,
    date: b.date !== undefined ? b.date : cur.date,
    active: b.active !== undefined ? b.active : cur.active === 1,
  }
  const bad = validateItem(next)
  if (bad) return error(bad)
  await env.DB.prepare('UPDATE plan_items SET name = ?, amount_cents = ?, currency = ?, date = ?, active = ? WHERE id = ?')
    .bind(next.name!.trim(), next.amount_cents, next.currency, next.date ?? null, next.active ? 1 : 0, id)
    .run()
  return json({ ok: true })
}

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad item id')
  await env.DB.prepare('DELETE FROM plan_items WHERE id = ?').bind(id).run()
  return json({ ok: true })
}
