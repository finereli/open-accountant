// Shared shapes between the PWA, the Pages Functions API, and the ingest CLI.

export interface Account {
  id: string
  owner: string
  institution: string
  kind: string
  currency: string
  display_name: string
  sort: number
  in_spending: number // 1 = counted in Spending and the forecast's cash
}

export interface Checkpoint {
  id: number
  account_id: string
  date: string
  balance_cents: number
  verified_at: string
}

export interface AccountSummary extends Account {
  balance_cents: number
  tx_count: number
  last_date: string | null
  anchor_date: string
  anchor_cents: number
  checkpoint: { date: string; balance_cents: number; verified_at: string; discrepancy_cents: number } | null
}

export interface AccountsResponse {
  accounts: AccountSummary[]
  fx: Record<string, number> // currency -> USD rate
  fx_date: string | null
  home_currency: string
  currencies: string[] // home first, then every account currency
}

export interface Tx {
  id: number
  date: string
  description: string
  amount_cents: number
  running_cents: number
  balance_after_cents: number | null
  locked: number
  external_id: string | null
  source_file: string
  memo: string | null
  merchant_key: string | null
  merchant_id: number | null
  merchant_name: string | null          // household name ("Aldo")
  merchant_concept: string | null       // concept bucket ("Gas Station")
  merchant_transfer_name: string | null // own-account counterparty ("Visa")
  merchant_confirmed: number | null     // 1 human or auto, 0 old LLM proposal, null unrecognized
  merchant_override: number             // 1 = row-level assignment beat the key alias
  merchant_source: 'human' | 'auto' | 'proposed' | null
  category_source: 'human' | 'auto' | null
  is_transfer: number                   // 1 = resolves to a transfer merchant (never "uncategorized")
  category_id: number | null            // resolved (tx_resolved). null = Uncategorized
  category_name: string | null
  category_auto: number                 // 1 = picked by the auto-categorizer, not a human
  category_row: number                  // 1 = a person set this row's category on its own
}

export interface Merchant {
  id: number
  household_name: string | null
  concept: string | null
  transfer_account_id: string | null
  category_id: number | null
  small_category_id: number | null
  small_max_cents: number | null
  alias_count: number
  tx_count: number
}

export interface Category {
  id: number
  name: string
  kind: 'income' | 'expense' | 'excluded'
  sort: number
  description?: string | null
}

// One month of spending, native currencies, resolved server-side.
export interface SpendingRow {
  category_id: number | null // null = Uncategorized
  merchant_id: number | null
  label: string
  currency: string
  debt: number // 1 = row lives on a credit card / line of credit
  total_cents: number
  count: number
}

export interface SpendingResponse {
  month: string
  rows: SpendingRow[]
  categories: Category[]
}

// One transaction behind a Spending merchant line (GET /api/spending-txns).
export interface SpendingTxn {
  id: number
  date: string
  description: string
  memo: string | null
  amount_cents: number
  currency: string
  account_name: string
}

// The one display rule for merchant identity.
export const merchantDisplay = (t: Tx): string =>
  t.merchant_name ??
  (t.merchant_transfer_name ? `Transfer: ${t.merchant_transfer_name}` : null) ??
  t.merchant_concept ??
  t.description

export interface AccountDetail {
  account: Account
  anchor: { date: string; balance_cents: number; source: string | null }
  checkpoints: Checkpoint[]
  transactions: Tx[] // ascending by (date, id); running_cents computed server-side
}

export interface IngestRow {
  account_id: string
  date: string
  description: string
  amount_cents: number
  balance_after_cents?: number | null
  source_file: string
  semantic_hash: string
  external_id?: string | null
  meta?: string | null
}

export interface IngestResponse {
  inserted: number
  duplicates: number
  flagged: Array<{ account_id: string; date: string; description: string; amount_cents: number }>
  unknown_accounts: string[]
}
