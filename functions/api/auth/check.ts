// GET /api/auth/check - the middleware has already let the owner through by
// the time this runs. With ?next=/path it sends the browser back into the
// app: the landing spot after Access signs someone in again.
import { json } from '../_lib'

export const onRequestGet: PagesFunction = async ({ request }) => {
  const url = new URL(request.url)
  const next = url.searchParams.get('next')
  // This site only. Checked after resolving, because browsers read
  // "/\evil.example" as "//evil.example".
  if (next) {
    const to = new URL(next, url.origin)
    if (to.origin === url.origin) return Response.redirect(to.toString(), 302)
  }
  return json({ ok: true })
}
