// GET /api/import/jobs/:id - progress, and every strip's rows once all are
//   read. Polling also restarts any strip whose worker went quiet.
// DELETE /api/import/jobs/:id - done with it (imported or discarded).

import type { Env } from '../../../_lib'
import { json, error } from '../../../_lib'
import { workJob, jobStatus, deleteJob, selfFanout } from '../../_jobs'

export const onRequestGet: PagesFunction<Env> = async ({ env, params, request, waitUntil }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad job id')
  const status = await jobStatus(env.DB, id)
  if (!status) return error('Unknown import', 404)
  if (status.needs_work) waitUntil(workJob(env, id, selfFanout(env, request.url, id)).catch(() => {}))
  return json(status)
}

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad job id')
  await deleteJob(env.DB, id)
  return json({ ok: true })
}
