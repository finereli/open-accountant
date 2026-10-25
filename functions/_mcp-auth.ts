// OAuth 2.1 for MCP clients: discovery documents, dynamic client
// registration (RFC 7591), authorization code with PKCE (S256 only),
// rotating refresh tokens. Approval happens on /oauth/authorize, which sits
// behind Cloudflare Access like the app: the owner is already signed in
// there, sees what the agent asks for, and taps Allow.

import { caller, type AuthEnv } from './_owner'

const ACCESS_TTL = 24 * 3600
const REFRESH_TTL = 180 * 86400
const CODE_TTL = 600

const enc = new TextEncoder()
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)))
const sha256 = async (s: string) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)))
const now = () => Math.floor(Date.now() / 1000)

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { ...cors, 'Cache-Control': 'no-store', ...headers } })
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status)
export const preflight = () => new Response(null, { status: 204, headers: cors })

export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`

export const protectedResource = (origin: string) =>
  json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'], bearer_methods_supported: ['header'], resource_name: 'Accountant' })

export const authorizationServer = (origin: string) =>
  json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read'],
  })

// Where a client may send the owner back to: https, or a local address for
// agents on a desktop.
const allowedRedirect = (u: string) => {
  try {
    const url = new URL(u)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

export async function register(request: Request, db: D1Database): Promise<Response> {
  const b = (await request.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null
  const uris = Array.isArray(b?.redirect_uris) ? b!.redirect_uris.map(String) : []
  if (!uris.length || !uris.every(allowedRedirect)) return oauthError('invalid_redirect_uri', 'Give one or more https (or localhost) redirect_uris')
  const id = 'mcp_' + randomToken(18)
  const name = typeof b?.client_name === 'string' ? b.client_name.slice(0, 80) : null
  await db.prepare('INSERT INTO mcp_clients (id, name, redirect_uris) VALUES (?1, ?2, ?3)').bind(id, name, JSON.stringify(uris)).run()
  return json(
    { client_id: id, client_id_issued_at: now(), client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    201
  )
}

async function client(db: D1Database, id: string) {
  const row = await db.prepare('SELECT id, name, redirect_uris FROM mcp_clients WHERE id = ?1').bind(id).first<{ id: string; name: string | null; redirect_uris: string }>()
  return row ? { ...row, uris: JSON.parse(row.redirect_uris) as string[] } : null
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;background:#f4f6f5;color:#1c2622;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px">
<div style="max-width:24rem"><h1 style="font-size:1.3rem;font-weight:500">${esc(title)}</h1>${body}</div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )

const button = (href: string, label: string, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:8px 8px 0 0;padding:11px 20px;border-radius:22px;text-decoration:none;${primary ? 'background:#0f4c4f;color:#fff' : 'border:1px solid #d5dedb;color:#0f4c4f'}">${esc(label)}</a>`

const withQuery = (base: string, q: Record<string, string | null | undefined>) => {
  const u = new URL(base)
  for (const [k, v] of Object.entries(q)) if (v != null) u.searchParams.set(k, v)
  return u.toString()
}

// Step 1: the client sends the owner here. Check what it asks for, keep the
// request, and ask the owner (signed in through Access) to allow it.
export async function authorize(request: Request, db: D1Database, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const p = url.searchParams
  const c = await client(db, p.get('client_id') ?? '')
  const redirect = p.get('redirect_uri') ?? ''
  // Without a known client and one of its own redirect URIs there is nowhere
  // safe to send an error, so say it here.
  if (!c) return page('Unknown app', '<p>This app has not registered with Accountant.</p>', 400)
  if (!c.uris.includes(redirect)) return page('Wrong address', '<p>The app asked to come back to an address it did not register.</p>', 400)
  const back = (q: Record<string, string>) => withQuery(redirect, { ...q, state: p.get('state') })
  if (p.get('response_type') !== 'code') return Response.redirect(back({ error: 'unsupported_response_type' }), 302)
  if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge'))
    return Response.redirect(back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }), 302)
  const who = await caller(request, env)
  if (!who || who.service) return page('Not yours', '<p>Only the owner of this Accountant can allow agents.</p>', 403)

  // The pending id is the only way to approve, and it appears only on this
  // page, so it doubles as the form's CSRF token.
  const id = randomToken(18)
  await db.batch([
    db.prepare(`DELETE FROM mcp_pending WHERE created_at < datetime('now', '-1 hour')`),
    db.prepare('INSERT INTO mcp_pending (id, client_id, redirect_uri, state, code_challenge) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, c.id, redirect, p.get('state'), p.get('code_challenge')),
  ])
  const name = c.name ? esc(c.name) : 'An app'
  return page(
    'Give an agent read access?',
    `<p><strong>${name}</strong> wants to read your Accountant: balances, transactions, spending, the forecast and the fun plan.</p>
<p>It cannot change anything.</p>
<form method="post" action="/oauth/authorize" style="display:inline"><input type="hidden" name="p" value="${esc(id)}">
<button style="margin:8px 8px 0 0;padding:11px 20px;border-radius:22px;border:0;background:#0f4c4f;color:#fff;font:inherit;cursor:pointer">Allow</button></form>${button(back({ error: 'access_denied' }), 'Cancel', false)}`
  )
}

// Step 2: the owner tapped Allow. Hand the client an authorization code.
export async function approve(request: Request, db: D1Database, env: AuthEnv): Promise<Response> {
  const who = await caller(request, env)
  if (!who || who.service) return page('Not yours', '<p>Only the owner of this Accountant can allow agents.</p>', 403)
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin') return page('Blocked', '<p>Approve from the page this app showed you.</p>', 403)
  const form = new URLSearchParams(await request.text())
  const p = await db
    .prepare('DELETE FROM mcp_pending WHERE id = ?1 RETURNING client_id, redirect_uri, state, code_challenge')
    .bind(form.get('p') ?? '')
    .first<{ client_id: string; redirect_uri: string; state: string | null; code_challenge: string }>()
  if (!p) return page('That request expired', '<p>Start again from the app that asked.</p>', 400)

  const authCode = randomToken(32)
  await db
    .prepare(`INSERT INTO mcp_tokens (hash, kind, client_id, redirect_uri, code_challenge, expires_at) VALUES (?1, 'code', ?2, ?3, ?4, ?5)`)
    .bind(await sha256(authCode), p.client_id, p.redirect_uri, p.code_challenge, now() + CODE_TTL)
    .run()
  return Response.redirect(withQuery(p.redirect_uri, { code: authCode, state: p.state }), 303)
}

async function issue(db: D1Database, clientId: string) {
  const access = 'acc_' + randomToken(32)
  const refresh = 'acr_' + randomToken(32)
  await db.batch([
    db.prepare('DELETE FROM mcp_tokens WHERE expires_at < ?1').bind(now()),
    db.prepare(`INSERT INTO mcp_tokens (hash, kind, client_id, expires_at) VALUES (?1, 'access', ?2, ?3)`).bind(await sha256(access), clientId, now() + ACCESS_TTL),
    db.prepare(`INSERT INTO mcp_tokens (hash, kind, client_id, expires_at) VALUES (?1, 'refresh', ?2, ?3)`).bind(await sha256(refresh), clientId, now() + REFRESH_TTL),
  ])
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'read' })
}

// Step 3: the client trades the code (or a refresh token) for tokens.
export async function token(request: Request, db: D1Database): Promise<Response> {
  const type = request.headers.get('Content-Type') ?? ''
  const raw = type.includes('application/json')
    ? ((await request.json().catch(() => ({}))) as Record<string, string>)
    : Object.fromEntries(new URLSearchParams(await request.text()))
  const clientId = raw.client_id ?? ''
  if (!(await client(db, clientId))) return oauthError('invalid_client', 'Unknown client', 401)

  if (raw.grant_type === 'authorization_code') {
    const row = await db
      .prepare(`DELETE FROM mcp_tokens WHERE hash = ?1 AND kind = 'code' RETURNING client_id, redirect_uri, code_challenge, expires_at`)
      .bind(await sha256(raw.code ?? ''))
      .first<{ client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }>()
    if (!row || row.expires_at < now() || row.client_id !== clientId) return oauthError('invalid_grant', 'The code is unknown, used or expired')
    if (raw.redirect_uri && raw.redirect_uri !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri does not match')
    if (!raw.code_verifier || (await sha256(raw.code_verifier)) !== row.code_challenge) return oauthError('invalid_grant', 'PKCE check failed')
    return issue(db, clientId)
  }

  if (raw.grant_type === 'refresh_token') {
    // One use each: the old refresh token goes as the new pair is made.
    const row = await db
      .prepare(`DELETE FROM mcp_tokens WHERE hash = ?1 AND kind = 'refresh' RETURNING client_id, expires_at`)
      .bind(await sha256(raw.refresh_token ?? ''))
      .first<{ client_id: string; expires_at: number }>()
    if (!row || row.expires_at < now() || row.client_id !== clientId) return oauthError('invalid_grant', 'The refresh token is unknown, used or expired')
    return issue(db, clientId)
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
}

// Every MCP request: a live access token, or nothing.
export async function bearerOk(request: Request, db: D1Database): Promise<boolean> {
  const t = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!t) return false
  const hash = await sha256(t)
  const row = await db.prepare(`SELECT expires_at FROM mcp_tokens WHERE hash = ?1 AND kind = 'access'`).bind(hash).first<{ expires_at: number }>()
  if (!row || row.expires_at < now()) return false
  await db.prepare(`UPDATE mcp_tokens SET last_used = datetime('now') WHERE hash = ?1`).bind(hash).run()
  return true
}

export const unauthorized = (origin: string) =>
  json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(origin)}"` })

// For settings: who has access, and taking it back.
export async function listClients(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.created_at,
              (SELECT MAX(last_used) FROM mcp_tokens t WHERE t.client_id = c.id) AS last_used
       FROM mcp_clients c
       WHERE EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.client_id = c.id AND t.kind = 'refresh' AND t.expires_at > ?1)
       ORDER BY c.created_at DESC`
    )
    .bind(now())
    .all()
  return results
}

export async function revoke(db: D1Database, clientId: string) {
  await db.prepare('DELETE FROM mcp_tokens WHERE client_id = ?1').bind(clientId).run()
}
