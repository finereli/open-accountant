// PATCH /api/categories/:id - rename, change kind, re-sort, or describe a
// category (the description is what the auto-categorizer reads).
// DELETE /api/categories/:id - remove one, refused while any merchant or a
// person's row decision still points at it: emptying first is the honest
// path, silent re-bucketing of transactions is not. Auto picks of it are
// dropped and those rows go back in the classifier's queue.

import type { Env } from '../_lib'
import { json, error, isCurrency } from '../_lib'

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad category id')
  let body: {
    name?: string
    kind?: string
    sort?: number
    flow?: string
    pinned_daily_cents?: number | null
    pinned_currency?: string | null
    description?: string | null
  }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const existing = await env.DB.prepare(
    'SELECT id, name, kind, sort, flow, pinned_daily_cents, pinned_currency, description FROM categories WHERE id = ?'
  )
    .bind(id)
    .first<{
      id: number
      name: string
      kind: string
      sort: number
      flow: string
      pinned_daily_cents: number | null
      pinned_currency: string | null
      description: string | null
    }>()
  if (!existing) return error('Unknown category', 404)

  const name = body.name?.trim() ?? existing.name
  if (!name) return error('name cannot be empty')
  const kind = body.kind ?? existing.kind
  if (!['income', 'expense', 'excluded'].includes(kind)) return error('kind must be income, expense or excluded')
  const sort = body.sort ?? existing.sort
  if (!Number.isInteger(sort)) return error('sort must be an integer')

  const flow = body.flow ?? existing.flow
  if (!['run_rate', 'discrete', 'subscriptions', 'off'].includes(flow))
    return error('flow must be run_rate, discrete, subscriptions or off')
  // Pin fields: explicit null clears the pin; both travel together.
  const pinCents = 'pinned_daily_cents' in body ? body.pinned_daily_cents : existing.pinned_daily_cents
  const pinCur = 'pinned_daily_cents' in body ? (body.pinned_currency ?? null) : existing.pinned_currency
  if (pinCents != null && (!Number.isInteger(pinCents) || pinCents < 0)) return error('pinned_daily_cents must be >= 0')
  if (pinCents != null && !isCurrency(pinCur))
    return error('pinned_currency required with a pin')

  const dup = await env.DB.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id != ?')
    .bind(name, id)
    .first()
  if (dup) return error('Category name already taken')

  const description = 'description' in body ? body.description?.trim() || null : existing.description

  await env.DB.prepare(
    'UPDATE categories SET name = ?, kind = ?, sort = ?, flow = ?, pinned_daily_cents = ?, pinned_currency = ?, description = ? WHERE id = ?'
  )
    .bind(name, kind, sort, flow, pinCents ?? null, pinCents != null ? pinCur : null, description, id)
    .run()
  return json({ ok: true })
}

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad category id')
  const used = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM merchants WHERE category_id = ?1 OR small_category_id = ?1'
  )
    .bind(id)
    .first<{ n: number }>()
  if ((used?.n ?? 0) > 0) return error(`${used!.n} merchants still use this category - move them first`)
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ? AND category_confirmed = 1')
    .bind(id)
    .first<{ n: number }>()
  if ((rows?.n ?? 0) > 0) return error(`${rows!.n} transactions are set to this category one by one - move them first`)
  await env.DB.prepare('UPDATE transactions SET auto_category_id = NULL, auto_at = NULL WHERE auto_category_id = ?').bind(id).run()
  const res = await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run()
  if ((res.meta.changes ?? 0) === 0) return error('Unknown category', 404)
  return json({ ok: true })
}
