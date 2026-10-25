// POST /api/plaid/link-token { item: n } - a Plaid Link token in UPDATE mode
// for the n-th linked bank (its place in PLAID_ACCESS_TOKENS). When a bank
// wants a fresh login (ITEM_LOGIN_REQUIRED) or Plaid can't read it any more,
// update mode restores it in place - same access token, same account ids -
// after the owner taps through Link on the /plaid-link/n page. Linking a NEW
// bank is a setup step (scripts/plaid-link.ts), not something the app does.

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { plaid, plaidTokens } from './_plaid'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const b = (await request.json().catch(() => ({}))) as { item?: number }
  const tokens = plaidTokens(env)
  const accessToken = tokens[b.item ?? 0]
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !accessToken) return error('Plaid is not set up for that bank', 400)

  const body = await plaid<{ link_token?: string }>(env, '/link/token/create', {
    access_token: accessToken,
    client_name: 'Accountant',
    user: { client_user_id: 'owner' },
    country_codes: (env.PLAID_COUNTRY_CODES ?? 'US').split(',').map((c) => c.trim().toUpperCase()),
    language: 'en',
  })
  if (!body.link_token) return error(body.error_message ?? 'Plaid link token failed', 400)
  return json({ link_token: body.link_token })
}
