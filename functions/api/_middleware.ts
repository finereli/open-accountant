// Everything under /api/ is the owner's: a Cloudflare Access identity that
// is one of OWNER_EMAIL, or the configured Access service token (the CLI,
// the server's own requests to itself). See functions/_owner.ts.
//
// Access signs people in with a cookie, and browsers attach cookies to
// requests other sites make too. So a write must come from this site's own
// pages: a browser marks every request with Sec-Fetch-Site (and Origin on
// writes), and anything from another site is refused. The CLI and the
// server's self-requests send neither header and get through on the token.

import type { Env } from './_lib'
import { error } from './_lib'
import { caller } from '../_owner'

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export function crossSite(request: Request): boolean {
  if (SAFE.has(request.method)) return false
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin' && site !== 'none') return true
  const origin = request.headers.get('Origin')
  return origin !== null && origin !== new URL(request.url).origin
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (crossSite(context.request)) return error('Cross-site request refused', 403)
  if (await caller(context.request, context.env)) return context.next()
  return error('Unauthorized', 401)
}
