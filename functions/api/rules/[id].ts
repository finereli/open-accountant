// PATCH /api/rules/:id - edit a rule. Body: { text?: string, retired?: boolean }
// (retired: the model stops reading it; it stays listed so it can come back)
// DELETE /api/rules/:id - remove it.

import type { Env } from '../_lib'
import { json, error } from '../_lib'

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad rule id')
  let body: { text?: string; retired?: boolean }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const now = new Date().toISOString()
  const text = body.text === undefined ? null : body.text.trim()
  if (text === '') return error('text cannot be empty')
  if (text === null && body.retired === undefined) return error('text or retired required')
  const retired = body.retired === undefined ? undefined : body.retired ? now : null
  const res = await env.DB.prepare(
    `UPDATE rules SET text = COALESCE(?, text),
                      retired_at = CASE WHEN ? THEN ? ELSE retired_at END,
                      updated_at = ?
     WHERE id = ?`
  )
    .bind(text, retired !== undefined ? 1 : 0, retired ?? null, now, id)
    .run()
  if ((res.meta.changes ?? 0) === 0) return error('Unknown rule', 404)
  return json({ ok: true })
}

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad rule id')
  await env.DB.prepare('DELETE FROM rule_uses WHERE rule_id = ?').bind(id).run()
  const res = await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run()
  if ((res.meta.changes ?? 0) === 0) return error('Unknown rule', 404)
  return json({ ok: true })
}
