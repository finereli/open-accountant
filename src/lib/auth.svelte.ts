// Sign-in is Cloudflare Access's job: it stands in front of the whole site,
// so by the time this app runs the person is signed in. When the Access
// session runs out, API calls start coming back as redirects to the Access
// login (or 401s), and we send the browser through /api/auth/check - a URL
// the service worker never serves from cache - so Access can sign the person
// in again and bring them back here.

const RETRY_KEY = 'accountant.reauth.at'

class Auth {
  // Always true: there is no in-app sign-in screen. Kept so stores can
  // react to it the way the PWA kit expects.
  signedIn = $state(true)

  get token(): string | undefined {
    return undefined // the Access cookie rides along by itself
  }

  init() {}

  handleUnauthorized() {
    // Once a minute at most, so a misconfigured server can't loop the page.
    try {
      const last = Number(sessionStorage.getItem(RETRY_KEY) ?? 0)
      if (Date.now() - last < 60_000) return
      sessionStorage.setItem(RETRY_KEY, String(Date.now()))
    } catch {}
    const next = location.pathname + location.search + location.hash
    location.href = `/api/auth/check?next=${encodeURIComponent(next)}`
  }

  signOut() {
    location.href = '/cdn-cgi/access/logout'
  }
}

export const auth = new Auth()
