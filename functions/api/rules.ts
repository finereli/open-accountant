// GET /api/rules - the household's plain-language rules, in order; the
// auto-categorizer reads all of them on every run.
// POST /api/rules - add one. Body: { text: string }

import type { Env } from './_lib'
import { json, error } from './_lib'
import { addRule, loadRules } from './_corrections'

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const [rules, corrections, queued] = await Promise.all([
    loadRules(env.DB),
    env.DB.prepare(
      `SELECT c.id, c.field, c.auto_value, c.human_value, c.scope, c.created_at,
              t.description, t.amount_cents, t.date, ac.currency
       FROM corrections c JOIN transactions t ON t.id = c.transaction_id JOIN accounts ac ON ac.id = t.account_id
       ORDER BY c.id DESC LIMIT 40`
    ).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE auto_at IS NULL').first<{ n: number }>(),
  ])
  return json({ rules, corrections: corrections.results, queued: queued?.n ?? 0 })
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { text?: string }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const text = body.text?.trim()
  if (!text) return error('text required')
  return json({ ok: true, id: await addRule(env.DB, text) })
}
