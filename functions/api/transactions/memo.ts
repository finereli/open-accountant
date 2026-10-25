import type { Env } from '../_lib'
import { json, error } from '../_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { transaction_id?: number; memo?: string | null }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!body.transaction_id) return error('transaction_id required')

  const memo = body.memo?.trim() || null
  await env.DB.prepare('UPDATE transactions SET memo = ? WHERE id = ?')
    .bind(memo, body.transaction_id)
    .run()

  return json({ ok: true })
}
