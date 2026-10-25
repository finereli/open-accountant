// POST /api/import/read - read one strip of a bank-app screenshot into rows.
// Body: { image: "data:image/jpeg;base64,...", account_id? }. Kept for one-off
// use; the import sheet goes through background jobs (./jobs).

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { readStrip, isCardAccount, ReadError } from './_vision'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { image?: string; account_id?: string }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  if (!body.image?.startsWith('data:image/')) return error('image (data URL) required')
  try {
    return json({ rows: await readStrip(env, body.image, await isCardAccount(env.DB, body.account_id)) })
  } catch (e) {
    if (e instanceof ReadError) return error(e.message, e.status)
    throw e
  }
}
