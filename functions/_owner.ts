// Who may use the app. Cloudflare Access stands in front of the whole site
// and signs every request it lets through with a JWT (the
// Cf-Access-Jwt-Assertion header, or the CF_Authorization cookie). We check
// that JWT ourselves too, so a misconfigured Access policy can't open the
// books to the world:
//
//   - a person: the token's email must be one of OWNER_EMAIL (comma-separated)
//   - a machine (the CLI, the server's own requests to itself): an Access
//     service token whose client id is ACCESS_CLIENT_ID
//
// Local development has no Access in front, so DEV_AUTH_EMAIL (set in
// .dev.vars) lets requests to localhost in as that person. It is ignored on
// any other host.

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string // e.g. "myteam.cloudflareaccess.com"
  ACCESS_AUD?: string // the Access application's AUD tag
  OWNER_EMAIL?: string
  ACCESS_CLIENT_ID?: string
  DEV_AUTH_EMAIL?: string
}

export interface Caller {
  email: string | null // null for the service token
  service: boolean
}

interface AccessClaims {
  aud: string | string[]
  iss: string
  exp: number
  nbf?: number
  email?: string
  common_name?: string
}

const LOCAL = ['localhost', '127.0.0.1', '[::1]']

export async function caller(request: Request, env: AuthEnv): Promise<Caller | null> {
  const url = new URL(request.url)
  if (env.DEV_AUTH_EMAIL && LOCAL.includes(url.hostname)) return { email: env.DEV_AUTH_EMAIL, service: false }

  const token = accessToken(request)
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null
  const claims = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD)
  if (!claims) return null
  if (claims.email && isOwner(claims.email, env.OWNER_EMAIL)) return { email: claims.email, service: false }
  if (!claims.email && env.ACCESS_CLIENT_ID && claims.common_name === env.ACCESS_CLIENT_ID) return { email: null, service: true }
  return null
}

export function isOwner(email: string, owners: string | undefined): boolean {
  const list = (owners ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return list.includes(email.toLowerCase())
}

export function accessToken(request: Request): string | undefined {
  const h = request.headers.get('Cf-Access-Jwt-Assertion')
  if (h) return h
  return request.headers.get('Cookie')?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1]
}

// Headers that get a machine request through Access to this same site (the
// import job's fan-out), when a service token is configured.
export function serviceHeaders(env: { ACCESS_CLIENT_ID?: string; ACCESS_CLIENT_SECRET?: string }): Record<string, string> {
  return env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET
    ? { 'CF-Access-Client-Id': env.ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET }
    : {}
}

// --- JWT verification against the team's published keys -------------------

const dec = new TextDecoder()
const enc = new TextEncoder()
let keys: { team: string; list: JsonWebKey[]; at: number } | null = null

// Tests swap the key fetch for a local key set.
let fetchKeys = async (team: string): Promise<JsonWebKey[] | null> => {
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`)
  return r.ok ? ((await r.json()) as { keys: JsonWebKey[] }).keys : null
}
export function setKeyFetcher(f: typeof fetchKeys) {
  fetchKeys = f
  keys = null
}

export async function verifyAccessJwt(token: string, team: string, aud: string): Promise<AccessClaims | null> {
  try {
    const [head, body, sig] = token.split('.')
    if (!sig) return null
    const header = JSON.parse(dec.decode(unb64u(head))) as { alg: string; kid: string }
    if (header.alg !== 'RS256') return null
    const jwk = await findKey(team, header.kid)
    if (!jwk) return null
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(sig), enc.encode(`${head}.${body}`))
    if (!ok) return null
    const c = JSON.parse(dec.decode(unb64u(body))) as AccessClaims
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud]
    const t = Date.now() / 1000
    if (c.iss !== `https://${team}` || !auds.includes(aud) || c.exp < t || (c.nbf && c.nbf > t + 60)) return null
    return c
  } catch {
    return null
  }
}

async function findKey(team: string, kid: string): Promise<JsonWebKey | undefined> {
  const fresh = keys && keys.team === team && Date.now() - keys.at < 3600_000
  let k = fresh ? keys!.list.find((j) => (j as { kid?: string }).kid === kid) : undefined
  // An unknown kid refetches at most once a minute (that's how a key
  // rotation arrives), so junk tokens can't turn every request into a fetch.
  if (!k && (!fresh || Date.now() - keys!.at > 60_000)) {
    const list = await fetchKeys(team)
    if (!list) return undefined
    keys = { team, list, at: Date.now() }
    k = list.find((j) => (j as { kid?: string }).kid === kid)
  }
  return k
}

function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
