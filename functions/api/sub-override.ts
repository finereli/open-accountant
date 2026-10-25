// POST /api/sub-override - cancel or un-cancel a derived subscription.
// Body: { merchant_id: number, end_date: 'YYYY-MM-DD' | null }.
//   end_date set  -> the merchant's monthly projection stops after that date
//                    (a manual override on top of the derived sub)
//   end_date null -> clear the override; the sub returns to pure-derived.

import type { Env } from './_lib'
import { json, error } from './_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { merchant_id?: number; end_date?: string | null }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!Number.isInteger(body.merchant_id)) return error('merchant_id required')
  const merchantId = body.merchant_id as number

  if (body.end_date == null) {
    await env.DB.prepare('DELETE FROM sub_overrides WHERE merchant_id = ?').bind(merchantId).run()
    return json({ ok: true, cleared: true })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.end_date)) return error('end_date must be YYYY-MM-DD')
  const m = await env.DB.prepare('SELECT id FROM merchants WHERE id = ?').bind(merchantId).first()
  if (!m) return error('Unknown merchant', 404)

  await env.DB.prepare(
    `INSERT INTO sub_overrides (merchant_id, end_date, created_at) VALUES (?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET end_date = excluded.end_date`
  )
    .bind(merchantId, body.end_date, new Date().toISOString())
    .run()
  return json({ ok: true, end_date: body.end_date })
}
