// GET /api/categories - the category list for pickers and the Spending view.
// POST /api/categories - create one. Body: { name: string, kind?: 'income' |
// 'expense' | 'excluded' }. Rename/re-sort stay SQL-level until a real need.

import type { Env } from './_lib'
import { json, error } from './_lib'

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = (
    await env.DB.prepare(
      `SELECT c.id, c.name, c.kind, c.sort, c.flow,
              c.pinned_daily_cents, c.pinned_currency, c.description,
              COUNT(m.id) AS merchant_count
       FROM categories c LEFT JOIN merchants m ON m.category_id = c.id
       GROUP BY c.id ORDER BY c.sort, c.id`
    ).all()
  ).results
  return json({ categories: rows })
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { name?: string; kind?: string }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const name = body.name?.trim()
  if (!name) return error('name required')
  const kind = body.kind ?? 'expense'
  if (!['income', 'expense', 'excluded'].includes(kind)) return error('kind must be income, expense or excluded')
  const dup = await env.DB.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').bind(name).first()
  if (dup) return error('Category already exists')
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM categories WHERE kind = ?')
    .bind(kind)
    .first<{ s: number }>()
  const res = await env.DB.prepare('INSERT INTO categories (name, kind, sort) VALUES (?, ?, ?)')
    .bind(name, kind, (max?.s ?? 0) + 1)
    .run()
  return json({ ok: true, id: res.meta.last_row_id })
}
