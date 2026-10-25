// Only the owners get in: a Cloudflare Access JWT (signed by the team's keys,
// for this application's AUD) carrying an OWNER_EMAIL address, or the
// configured service token. Local dev lets DEV_AUTH_EMAIL in on localhost
// only. Everything else 401s.

import { describe, it, expect, beforeAll } from 'vitest'
import { onRequest } from '../functions/api/_middleware'
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
