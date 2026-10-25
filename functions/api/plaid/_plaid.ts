// Plaid plumbing shared by the sync, the relink flow and scripts/plaid-link.ts.
// Credentials are Pages secrets; nothing here stores them.

export interface PlaidEnv {
  PLAID_CLIENT_ID?: string
  PLAID_SECRET?: string
  PLAID_ACCESS_TOKENS?: string
  PLAID_ENV?: string
  PLAID_COUNTRY_CODES?: string
}

export const plaidBase = (env: PlaidEnv) =>
  env.PLAID_ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com'

export const plaidTokens = (env: PlaidEnv) =>
  (env.PLAID_ACCESS_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean)

export const plaidConfigured = (env: PlaidEnv) => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET && plaidTokens(env).length)

// POST a Plaid endpoint with the client credentials. Plaid answers errors as
// JSON with error_code, which callers read rather than throw on.
export async function plaid<T>(env: PlaidEnv, path: string, body: Record<string, unknown>): Promise<T & { error_code?: string; error_message?: string }> {
  const r = await fetch(plaidBase(env) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  })
  return r.json() as Promise<T & { error_code?: string; error_message?: string }>
}

// Plaid's account type/subtype -> the ledger's kind. Null = not a ledger
// account (investments, brokerage): those stay out.
export function kindFor(type: string, subtype: string | null): string | null {
  const sub = (subtype ?? '').toLowerCase()
  if (type === 'depository') return sub === 'savings' || sub === 'money market' || sub === 'cd' ? 'savings' : 'checking'
  if (type === 'credit') return sub === 'line of credit' ? 'line_of_credit' : 'credit_card'
  if (type === 'loan') return 'line_of_credit'
  return null
}
