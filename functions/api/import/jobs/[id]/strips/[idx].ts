// POST /api/import/jobs/:id/strips/:idx - read one claimed strip. Called by
// the job itself (one request per strip, so each gets its own time budget),
// not by the app. The read is held by waitUntil too, so it finishes even if
// the caller goes away.

import type { Env } from '../../../../_lib'
import { json, error } from '../../../../_lib'
import { readOne } from '../../../_jobs'

export const onRequestPost: PagesFunction<Env> = async ({ env, params, waitUntil }) => {
  const id = Number(params.id)
  const idx = Number(params.idx)
  if (!Number.isInteger(id) || !Number.isInteger(idx)) return error('Bad strip')
  const work = readOne(env, id, idx).catch(() => {})
  waitUntil(work)
  await work
  return json({ ok: true })
}
