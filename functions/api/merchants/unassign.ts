// POST /api/merchants/unassign - undo a merchant decision.
// Body: { merchant_key?: string,     -- drop the key alias (all rows sharing it)
//         transaction_id?: number }  -- clear one row's override (falls back to alias)

import type { Env } from '../_lib'
import { json, error } from '../_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { merchant_key?: string; transaction_id?: number }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }

  if (body.transaction_id) {
    await env.DB.prepare('UPDATE transactions SET merchant_override_id = NULL WHERE id = ?')
      .bind(body.transaction_id)
      .run()
    return json({ ok: true })
  }

  const key = body.merchant_key?.trim()
  if (!key) return error('merchant_key or transaction_id required')

  await env.DB.prepare('DELETE FROM merchant_aliases WHERE normalized_raw = ?').bind(key).run()
  return json({ ok: true })
}
