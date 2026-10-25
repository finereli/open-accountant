// Everything under /api/ is the owner's: a Cloudflare Access identity that
// is one of OWNER_EMAIL, or the configured Access service token (the CLI,
// the server's own requests to itself). See functions/_owner.ts.

import type { Env } from './_lib'
import { error } from './_lib'
import { caller } from '../_owner'

export const onRequest: PagesFunction<Env> = async (context) => {
  if (await caller(context.request, context.env)) return context.next()
  return error('Unauthorized', 401)
}
