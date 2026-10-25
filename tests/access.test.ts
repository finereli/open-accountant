// Only the owners get in: a Cloudflare Access JWT (signed by the team's keys,
// for this application's AUD) carrying an OWNER_EMAIL address, or the
// configured service token. Local dev lets DEV_AUTH_EMAIL in on localhost
// only. Everything else 401s.

import { describe, it, expect, beforeAll } from 'vitest'
import { onRequest } from '../functions/api/_middleware'
import { onRequestGet as check } from '../functions/api/auth/check'
import { installAccessKeys, accessJwt, accessEnv, OWNER, CLIENT_ID, AUD } from './access-token'

const PROD = 'https://accountant.example.com'

beforeAll(installAccessKeys)

async function status(headers: Record<string, string>, origin = PROD, env: Record<string, string> = accessEnv) {
  const res = await onRequest({
    request: new Request(`${origin}/api/accounts`, { headers }),
    env,
    next: async () => new Response('ok'),
  } as any)
  return res.status
}
const as = async (claims: Record<string, unknown>) => ({ 'Cf-Access-Jwt-Assertion': await accessJwt(claims) })

describe('who gets into /api', () => {
  it('lets an owner in, by header or by cookie, any letter case', async () => {
    expect(await status(await as({ email: OWNER }))).toBe(200)
    expect(await status(await as({ email: 'Partner@Example.com' }))).toBe(200)
    expect(await status({ Cookie: `x=1; CF_Authorization=${await accessJwt({ email: OWNER })}` })).toBe(200)
  })
  it('refuses anyone else Access let through', async () => {
    expect(await status(await as({ email: 'stranger@example.com' }))).toBe(401)
  })
  it('refuses tokens for another application, expired, or signed by another key', async () => {
    expect(await status(await as({ email: OWNER, aud: ['other-app'] }))).toBe(401)
    expect(await status(await as({ email: OWNER, exp: Date.now() / 1000 - 10 }))).toBe(401)
    expect(await status(await as({ email: OWNER, iss: 'https://evil.cloudflareaccess.com' }))).toBe(401)
    const other = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair
    expect(await status({ 'Cf-Access-Jwt-Assertion': await accessJwt({ email: OWNER }, { key: other.privateKey }) })).toBe(401)
  })
  it('lets the configured service token in, and no other', async () => {
    expect(await status(await as({ common_name: CLIENT_ID }))).toBe(200)
    expect(await status(await as({ common_name: 'someone-else.access' }))).toBe(401)
    expect(await status(await as({ common_name: CLIENT_ID }), PROD, { ...accessEnv, ACCESS_CLIENT_ID: '' })).toBe(401)
  })
  it('fails closed when Access is not configured', async () => {
    expect(await status(await as({ email: OWNER }), PROD, { OWNER_EMAIL: OWNER })).toBe(401)
    expect(await status(await as({ email: OWNER }), PROD, { ...accessEnv, ACCESS_AUD: '' })).toBe(401)
    void AUD
  })
  it('lets DEV_AUTH_EMAIL in on localhost only', async () => {
    const dev = { ...accessEnv, DEV_AUTH_EMAIL: OWNER }
    expect(await status({}, 'http://localhost:8788', dev)).toBe(200)
    expect(await status({}, PROD, dev)).toBe(401)
  })
  it('refuses no credentials and junk', async () => {
    expect(await status({})).toBe(401)
    expect(await status({ 'Cf-Access-Jwt-Assertion': 'junk.junk.junk' })).toBe(401)
  })
})

// Access's session is a cookie, which a browser also sends on requests other
// sites make. Writes from another site are refused before auth is checked.
describe('cross-site writes', () => {
  const post = async (headers: Record<string, string>) => {
    const res = await onRequest({
      request: new Request(`${PROD}/api/ingest`, { method: 'POST', headers: { Cookie: `CF_Authorization=${await accessJwt({ email: OWNER })}`, ...headers } }),
      env: accessEnv,
      next: async () => new Response('ok'),
    } as any)
    return res.status
  }
  it('lets the app itself and the CLI write', async () => {
    expect(await post({ 'Sec-Fetch-Site': 'same-origin', Origin: PROD })).toBe(200)
    expect(await post({})).toBe(200)
  })
  it('refuses writes another site starts', async () => {
    expect(await post({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' })).toBe(403)
    expect(await post({ 'Sec-Fetch-Site': 'same-site' })).toBe(403)
    expect(await post({ Origin: 'https://evil.example' })).toBe(403)
  })
})

describe('/api/auth/check?next', () => {
  const go = async (next: string) => {
    const res = await check({ request: new Request(`${PROD}/api/auth/check?next=${encodeURIComponent(next)}`) } as any)
    return res.headers.get('Location')
  }
  it('returns to a path on this site', async () => {
    expect(await go('/spending?m=2026-09')).toBe(`${PROD}/spending?m=2026-09`)
  })
  it('never sends the browser to another site', async () => {
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/', '\\\\evil.example']) expect(await go(bad)).toBeNull()
  })
})
