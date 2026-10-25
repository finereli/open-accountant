// Stand-in for Cloudflare Access in tests: an RSA key served as the team's
// certs, and JWTs signed with it the way Access signs them.

import { setKeyFetcher } from '../functions/_owner'

export const TEAM = 'testteam.cloudflareaccess.com'
export const AUD = 'aud-tag-123'
export const OWNER = 'owner@example.com'
export const CLIENT_ID = 'abc123.access'

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString('base64url')

let keys: CryptoKeyPair | null = null

export async function installAccessKeys() {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' } as JsonWebKey
  setKeyFetcher(async (team) => (team === TEAM ? [jwk] : null))
}

export async function accessJwt(claims: Record<string, unknown>, opts: { key?: CryptoKey } = {}) {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }))
  const body = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000, ...claims }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? keys!.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64u(sig)}`
}

export const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: `${OWNER}, partner@example.com`, ACCESS_CLIENT_ID: CLIENT_ID }
