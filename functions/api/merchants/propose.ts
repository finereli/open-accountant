// POST /api/merchants/propose - run one LLM proposal pass by hand.
// Body: { limit?: number } - keys per run (default 40). Re-run to continue.
// The same pass fires automatically after every sync; see _propose.ts.

import type { Env } from '../_lib'
import { json } from '../_lib'
import { runPropose } from '../_propose'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let limit = 40
  try {
    const body = (await request.json()) as { limit?: number }
    if (body.limit) limit = Math.min(body.limit, 100)
  } catch {
    // empty body is fine
  }
  return json(await runPropose(env, limit))
}
