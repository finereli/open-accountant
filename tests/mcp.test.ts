// The MCP end to end: an agent registers, the owner approves on the
// /oauth/authorize page (behind Cloudflare Access - stood in for here by a
// real RS256 Access JWT), the agent trades the code with PKCE, and the
// read-only tools answer. Someone who isn't an owner can't approve.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { register, authorize, approve, token, bearerOk } from '../functions/_mcp-auth'
import { mcpRequest, toolNames } from '../functions/_mcp'
import { installAccessKeys, accessJwt, accessEnv, OWNER } from './access-token'

let db: ReturnType<typeof makeTestDb>
const ORIGIN = 'https://accountant.example.com'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString('base64url')
const sha = async (s: string) => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

beforeAll(installAccessKeys)
beforeEach(async () => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('eur','alex','Wise','wallet','EUR','Wise EUR',0,1), ('visa','alex','Bank','credit_card','CAD','Visa',1,1);
    INSERT INTO fx_rates VALUES ('2026-10-16','EUR','USD',1.1), ('2026-10-16','CAD','USD',0.7);
    INSERT INTO categories (id, name, kind, sort, flow) VALUES (1,'Food','expense',1,'run_rate');
    INSERT INTO merchants (id, household_name, created_at, category_id) VALUES (1,'Mercado','x',1);
    INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_override_id)
      VALUES (1,'eur',date('now','-2 days'),'Mercado Central Lisbon',-2500,'t','h1',1), (2,'eur',date('now','-40 days'),'Salary',500000,'t','h2',NULL);
    INSERT INTO allowance_months (month, amount_cents, currency) VALUES ('default', 40000, 'EUR');
  `)
})

async function connect(as: string) {
  const who = { 'Cf-Access-Jwt-Assertion': await accessJwt({ email: as }) }
  const reg = await (await register(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }) }), db as any)).json() as any
  const verifier = 'v'.repeat(50)
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 's1', code_challenge: await sha(verifier), code_challenge_method: 'S256' })
  const page = await authorize(new Request(`${ORIGIN}/oauth/authorize?${q}`, { headers: who }), db as any, accessEnv)
  const html = await page.text()
  const pending = html.match(/name="p" value="([^"]+)"/)?.[1]
  if (!pending) return { reg, verifier, loc: null, status: page.status }
  const back = await approve(
    new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { ...who, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ p: pending }) }),
    db as any,
    accessEnv
  )
  return { reg, verifier, loc: new URL(back.headers.get('Location')!), status: back.status }
}

describe('MCP authorization', () => {
  it('lets the owner approve an agent, which then gets tokens with PKCE', async () => {
    const { reg, verifier, loc: loc_ } = await connect(OWNER)
    const loc = loc_!
    expect(loc.origin + loc.pathname).toBe(REDIRECT)
    expect(loc.searchParams.get('state')).toBe('s1')
    const code = loc.searchParams.get('code')!
    const ex = (verifier_: string, code_: string) =>
      token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: code_, client_id: reg.client_id, code_verifier: verifier_, redirect_uri: REDIRECT }) }), db as any)
    expect((await ex('wrong', code)).status).toBe(400)
    // A failed PKCE check spends the code too.
    expect((await ex(verifier, code)).status).toBe(400)
    const again = await connect(OWNER)
    const ok = (await (await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: again.loc!.searchParams.get('code')!, client_id: again.reg.client_id, code_verifier: again.verifier, redirect_uri: REDIRECT }) }), db as any)).json()) as any
    expect(ok).toMatchObject({ token_type: 'Bearer', scope: 'read' })
    // Refresh tokens rotate: one use each.
    const refresh = (t: string) => token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t, client_id: again.reg.client_id }) }), db as any)
    expect((await refresh(ok.refresh_token)).status).toBe(200)
    expect((await refresh(ok.refresh_token)).status).toBe(400)
  })

  it('shows the Allow page to no one but an owner', async () => {
    const { loc, status } = await connect('someone@else.com')
    expect(loc).toBeNull()
    expect(status).toBe(403)
  })

  it('refuses an approval posted from another site', async () => {
    const who = { 'Cf-Access-Jwt-Assertion': await accessJwt({ email: OWNER }) }
    const res = await approve(new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { ...who, 'Sec-Fetch-Site': 'cross-site' }, body: 'p=x' }), db as any, accessEnv)
    expect(res.status).toBe(403)
  })
})

describe('MCP tools', () => {
  async function authed() {
    const { reg, verifier, loc } = await connect(OWNER)
    const tok = (await (await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: loc!.searchParams.get('code')!, client_id: reg.client_id, code_verifier: verifier, redirect_uri: REDIRECT }) }), db as any)).json()) as any
    return tok.access_token as string
  }
  const call = async (method: string, params: unknown = {}) =>
    (await (await mcpRequest(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), db as any)).json()) as any

  it('needs a live access token', async () => {
    const t = await authed()
    expect(await bearerOk(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${t}` } }), db as any)).toBe(true)
    expect(await bearerOk(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: 'Bearer nope' } }), db as any)).toBe(false)
  })

  it('lists read-only tools and every one of them answers', async () => {
    const list = await call('tools/list')
    expect(list.result.tools.map((t: any) => t.name)).toEqual(toolNames)
    expect(list.result.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true)
    for (const name of toolNames) {
      const r = await call('tools/call', { name, arguments: {} })
      expect(r.result.isError ?? false, `${name}: ${r.result.content[0].text}`).toBe(false)
    }
  })

  it('reports balances, spending and the forecast in the asked currency', async () => {
    const ov = (await call('tools/call', { name: 'get_overview', arguments: { currency: 'EUR' } })).result.structuredContent
    expect(ov.accounts.find((a: any) => a.id === 'eur').balance).toBe(4975)
    const tx = (await call('tools/call', { name: 'list_transactions', arguments: { merchant: 'mercado' } })).result.structuredContent
    expect(tx.items).toMatchObject([{ merchant: 'Mercado', category: 'Food', amount: -25, currency: 'EUR' }])
    const fc = (await call('tools/call', { name: 'get_forecast', arguments: { window_days: 30, currency: 'EUR' } })).result.structuredContent
    expect(fc.starting_cash).toBe(4975)
    expect(fc.burn_by_category[0]).toMatchObject({ category: 'Food', measured_per_day: 0.83 })
    expect(fc.fun_allowance[1]).toMatchObject({ allowance: 400 })
  })
})
