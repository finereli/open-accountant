// POST /api/import/jobs - start reading a screenshot in the background.
//   Body: { account_id, strips: ["data:image/jpeg;base64,...", ...] }
//   Returns { id, total }; reading carries on after the phone leaves.
// GET /api/import/jobs?account_id= - the account's open import, if any
//   (so the account screen can show it after the app was closed).

import type { Env } from '../../_lib'
import { json, error } from '../../_lib'
import { createJob, workJob, jobStatus, selfFanout } from '../_jobs'

export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  let body: { account_id?: string; strips?: unknown }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const strips = body.strips
  if (!body.account_id) return error('account_id required')
  if (!Array.isArray(strips) || strips.length === 0 || strips.some((s) => typeof s !== 'string' || !s.startsWith('data:image/')))
    return error('strips (image data URLs) required')
  const acct = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(body.account_id).first()
  if (!acct) return error('Unknown account', 404)
  const id = await createJob(env.DB, body.account_id, strips as string[])
  waitUntil(workJob(env, id, selfFanout(env, request.url, id)).catch(() => {}))
  return json({ id, total: strips.length })
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  const accountId = new URL(request.url).searchParams.get('account_id')
  if (!accountId) return error('account_id required')
  const job = await env.DB.prepare('SELECT id FROM import_jobs WHERE account_id = ? ORDER BY id DESC LIMIT 1')
    .bind(accountId)
    .first<{ id: number }>()
  if (!job) return json({ job: null })
  const status = await jobStatus(env.DB, job.id)
  if (status?.needs_work) waitUntil(workJob(env, job.id, selfFanout(env, request.url, job.id)).catch(() => {}))
  return json({ job: status })
}
