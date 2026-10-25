// POST /api/auto-categorize - run the automatic pass on demand: transfer
// pairing, then the classifier over its queue (see _autocat.ts and
// _classify.ts). Body:
//   { dry_run?: boolean,   -- list the transfer pairs it would make, write nothing
//     days?: number,       -- transfer-pairing window (default 120)
//     limit?: number,      -- rows to classify this call (default 100, max 400)
//     requeue?: 'all' | 'YYYY-MM-DD' }
//                          -- first put rows (all, or from that date) back in the
//                             queue, e.g. after the rules changed
// Returns how many rows remain queued; call again until 0.

import type { Env } from './_lib'
import { json, error } from './_lib'
import { runAutoCategorize, findTransfers } from './_autocat'
import { requeue } from './_classify'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { dry_run?: boolean; days?: number; limit?: number; requeue?: string } = {}
  try {
    body = await request.json()
  } catch {}
  const days = body.days ?? 120
  if (body.dry_run) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    return json({ dry_run: true, transfer_pairs: await findTransfers(env.DB, since) })
  }
  let requeued = 0
  if (body.requeue !== undefined) {
    if (body.requeue !== 'all' && !/^\d{4}-\d{2}-\d{2}$/.test(body.requeue)) return error("requeue must be 'all' or YYYY-MM-DD")
    requeued = await requeue(env.DB, body.requeue === 'all' ? undefined : body.requeue)
  }
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 400)
  return json({ requeued, ...(await runAutoCategorize(env, { days, limit, parallel: 4 })) })
}
