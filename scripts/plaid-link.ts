// Link a bank through Plaid - a one-time setup step, run on a desktop.
//
//   npm run plaid:link
//
// Starts a page on http://localhost:8790, opens Plaid Link there, and after
// you log in to your bank prints the new access token and its accounts. Add
// the token to the PLAID_ACCESS_TOKENS secret (comma-separated, one per
// bank) and the next sync creates the accounts. See README -> Plaid.
//
// Reads PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV and PLAID_COUNTRY_CODES from
// the environment or .dev.vars. Banks that log in through OAuth open in a
// popup, which works on desktop browsers without a redirect URI.

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
function setting(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  const devVars = join(root, '.dev.vars')
  if (!existsSync(devVars)) return undefined
  return readFileSync(devVars, 'utf8').match(new RegExp(`^${name}=["']?([^"'\\s]+)`, 'm'))?.[1]
}

const clientId = setting('PLAID_CLIENT_ID')
const secret = setting('PLAID_SECRET')
const env = setting('PLAID_ENV') ?? 'production'
const countries = (setting('PLAID_COUNTRY_CODES') ?? 'US').split(',').map((c) => c.trim().toUpperCase())
if (!clientId || !secret) {
  console.error('Set PLAID_CLIENT_ID and PLAID_SECRET (environment or .dev.vars) first.')
  process.exit(1)
}
const base = env === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com'

async function plaid(path: string, body: Record<string, unknown>) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  })
  const out = (await r.json()) as Record<string, any>
  if (out.error_code) throw new Error(`${path}: ${out.error_code} - ${out.error_message}`)
  return out
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Link a bank</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px">
<h1 style="font-size:1.3rem">Link a bank through Plaid</h1>
<p id="msg">Opening Plaid Link...</p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
  const msg = (t) => (document.getElementById('msg').textContent = t)
  fetch('/token').then((r) => r.json()).then(({ link_token, error }) => {
    if (error) return msg(error)
    Plaid.create({
      token: link_token,
      onSuccess: (public_token) =>
        fetch('/exchange', { method: 'POST', body: public_token }).then((r) => r.text()).then(msg),
      onExit: (err) => err && msg(err.display_message || err.error_message || 'Closed without linking.'),
    }).open()
  })
</script>`

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/token') {
      const out = await plaid('/link/token/create', {
        client_name: 'Accountant',
        user: { client_user_id: 'owner' },
        products: ['transactions'],
        transactions: { days_requested: 730 },
        country_codes: countries,
        language: 'en',
      })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ link_token: out.link_token }))
    } else if (req.url === '/exchange' && req.method === 'POST') {
      let publicToken = ''
      for await (const chunk of req) publicToken += chunk
      const { access_token, item_id } = await plaid('/item/public_token/exchange', { public_token: publicToken })
      const { accounts, item } = await plaid('/accounts/get', { access_token })
      console.log(`\nLinked ${item.institution_name ?? 'a bank'} (item ${item_id}).\n`)
      console.log('Accounts (each becomes a ledger account on the next sync,')
      console.log('or point an existing one at it: UPDATE accounts SET external_ref = ... ):')
      for (const a of accounts) console.log(`  plaid:${a.account_id}  ${a.name}${a.mask ? ' ' + a.mask : ''}  (${a.type}/${a.subtype}, ${a.balances.iso_currency_code})`)
      console.log(`\nAccess token - add it to PLAID_ACCESS_TOKENS (comma-separated), never commit it:\n\n  ${access_token}\n`)
      res.writeHead(200).end('Linked. The access token and accounts are in your terminal - you can close this tab.')
      setTimeout(() => process.exit(0), 500)
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE)
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    console.error(m)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: m }))
  }
})

server.listen(8790, '127.0.0.1', () => console.log(`Open http://localhost:8790 to link a bank (${env}, ${countries.join(',')}).`))
