// PATCH /api/expected/:id - edit an expected item (full-field update).
// DELETE /api/expected/:id - remove it.

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { validateItem } from '../expected'

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad item id')
  let b: Parameters<typeof validateItem>[0] & { account_id?: string | null; category_id?: number | null }
  try {
    b = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const bad = validateItem(b)
  if (bad) return error(bad)
  const res = await env.DB.prepare(
    `UPDATE expected_items SET name = ?, kind = ?, amount_cents = ?, currency = ?,
       day_of_month = ?, date = ?, end_month = ?, end_date = ?, per_day = ?, account_id = ?, category_id = ?
     WHERE id = ?`
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
      id
    )
    .run()
  if ((res.meta.changes ?? 0) === 0) return error('Unknown item', 404)
  return json({ ok: true })
}

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad item id')
  const res = await env.DB.prepare('DELETE FROM expected_items WHERE id = ?').bind(id).run()
  if ((res.meta.changes ?? 0) === 0) return error('Unknown item', 404)
  return json({ ok: true })
}
