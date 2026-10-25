// GET /api/auth/check - the middleware has already let the owner through by
// the time this runs. With ?next=/path it sends the browser back into the
// app: the landing spot after Access signs someone in again.
import { json } from '../_lib'

export const onRequestGet: PagesFunction = async ({ request }) => {
  const url = new URL(request.url)
  const next = url.searchParams.get('next')
  // Same-site paths only, never //evil.example.
  if (next && next.startsWith('/') && !next.startsWith('//')) return Response.redirect(new URL(next, url.origin).toString(), 302)
  return json({ ok: true })
}
