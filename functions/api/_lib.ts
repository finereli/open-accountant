// Shared server helpers for the Pages Functions API. Files starting with `_`
// are not routed.

export interface Env {
  DB: D1Database
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }
  // Access (see functions/_owner.ts)
  OWNER_EMAIL: string // who may sign in; comma-separated for a household
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  ACCESS_CLIENT_ID?: string // service token for the CLI and the server's own requests
  ACCESS_CLIENT_SECRET?: string
  DEV_AUTH_EMAIL?: string // localhost only
  HOME_CURRENCY?: string // default display currency, e.g. "USD"
  WISE_API_KEYS?: string // comma-separated Wise personal API tokens
  PLAID_CLIENT_ID?: string
  PLAID_SECRET?: string
  PLAID_ACCESS_TOKENS?: string // comma-separated, one per linked bank (Item)
  PLAID_ENV?: string // 'production' (default) | 'sandbox'
  PLAID_COUNTRY_CODES?: string // e.g. "US,CA" - for the relink flow
}

// Currencies are whatever the accounts hold, plus the home currency.
// Any ISO 4217 code works; conversion needs a rate (see fx-refresh).
export const isCurrency = (c: unknown): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c)

export const homeCurrency = (env: { HOME_CURRENCY?: string }) =>
  isCurrency(env.HOME_CURRENCY) ? env.HOME_CURRENCY : 'USD'

export async function currenciesInUse(db: D1Database, home: string): Promise<string[]> {
  const rows = (await db.prepare('SELECT DISTINCT currency FROM accounts ORDER BY currency').all()).results as Array<{ currency: string }>
  return [home, ...rows.map((r) => r.currency).filter((c) => c !== home)]
}

// "Wise biz USD" -> "wise-biz-usd", made unique. For accounts a sync creates.
export async function newAccountId(db: D1Database, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'account'
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!(await db.prepare('SELECT 1 FROM accounts WHERE id = ?').bind(id).first())) return id
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

// Latest checkpoint date per account, or null.
export async function lastCheckpointDate(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT MAX(date) AS d FROM reconciliation_checkpoints WHERE account_id = ?')
    .bind(accountId)
    .first<{ d: string | null }>()
  return row?.d ?? null
}

// Latest checkpoint date whose LIVE discrepancy is zero - the freeze
// boundary. A mismatched (attested) checkpoint doesn't freeze: its period
// must stay open for the corrections an investigation produces, and once
// they land the same computation makes it the boundary automatically.
export async function lastVerifiedDate(db: D1Database, accountId: string): Promise<string | null> {
  const rows = (
    await db
      .prepare(
        `SELECT c.date, c.balance_cents,
                COALESCE((SELECT a.balance_cents FROM ledger_anchors a WHERE a.account_id = c.account_id), 0) +
                COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                          WHERE t.account_id = c.account_id
                            AND t.date >= COALESCE((SELECT a2.date FROM ledger_anchors a2 WHERE a2.account_id = c.account_id), '0000-01-01')
                            AND t.date <= c.date), 0) AS computed
         FROM reconciliation_checkpoints c
         WHERE c.account_id = ?
         ORDER BY c.date DESC`
      )
      .bind(accountId)
      .all()
  ).results as Array<{ date: string; balance_cents: number; computed: number }>
  for (const r of rows) if (r.balance_cents === r.computed) return r.date
  return null
}

// Reduce a raw bank description to a stable merchant key. The raw string is
// never modified on the transaction - this key only feeds the alias lookup.
// Goal: the same shop yields the same key across sources and visits, so one
// human decision covers all of them. Deliberately conservative: over-cleaning
// merges strangers (expensive), under-cleaning fragments (cheap - the LLM
// proposal layer picks up the fragments).
export function merchantKey(description: string): string {
  let s = description.toLowerCase()
  // Source boilerplate prefixes: many banks wrap every card line in the same
  // words, which say nothing about who was paid. Add your bank's here when
  // its keys all start alike (tests/merchant-key.test.ts pins the behaviour).
  s = s.replace(
    /^(pos purchase|pos|opos|debit card purchase|card purchase|visa debit purchase|visa debit|contactless payment|recurring payment|correction|deposit|withdrawal)\s+/,
    ''
  )
  // Wise API boilerplate: "card transaction of 7.50 usd issued by github"
  // - the amount varies per charge, the merchant is what follows.
  s = s.replace(/^card transaction of [\d.,]+ [a-z]{3,4} issued by\s+/, '')
  // Money amounts anywhere are transaction data, never merchant identity
  // ("converted 400.00 usd to 345.06 eur" is the same "merchant" as
  // "converted 1,500.00 usd to 1,293.99 eur").
  s = s.replace(/\b\d[\d,]*[.,]\d{2}\b/g, ' ')
  // Wise appends its FX fee - transaction data, not merchant identity
  // ("disney plus london (fee: 0.07 eur)"). Amount-agnostic on purpose: the
  // global amount strip may have already eaten the digits.
  s = s.replace(/\s*\(fee:[^)]*\)$/, '')
  // Marketplaces mint a fresh order code per purchase ("Amazon* Jm0tm40n5",
  // "Ebay O*12-15003-84755") - the merchant is the marketplace. Anchored
  // narrowly (amazon must carry its ./* decoration) so "amazon prime"-style
  // names stay distinct.
  s = s.replace(/^(www\.)?amazon(\.[a-z]{2,3}(\.[a-z]{2})?)?\*\s*\S+/, 'amazon') // amazon.com* 2k4lp
  s = s.replace(/^(www\.)?amazon[.*]+\s+\S+/, 'amazon')
  s = s.replace(/^ebay\s+o\*[\d-]+/, 'ebay')
  // Wallet suffix: "corner bakery (google pay)" must match "corner bakery".
  s = s.replace(/\s*\((google|apple|samsung) pay\)\s*$/, '')
  // Wise transfer references vary per transfer - numbers, free text
  // ("with reference coaching refund"), anything. All of it is per-transfer.
  s = s.replace(/\s+with reference\b.*$/, '')
  // Phone fragments vary by download and glue themselves to names
  // ("acme cloud, in+1848", "streamco* plus su+1415").
  s = s.replace(/\+[\d-]{3,}$/, '')
  // Standalone long digit runs are branch/transit/reference numbers, never
  // the merchant ("bank transit 13300 springfield").
  s = s.replace(/\b\d{4,}\b/g, ' ')
  // Trailing number fragments ("877-9", "40293") vary by download.
  while (/\s[+\d][\d-]*$/.test(s)) s = s.replace(/\s[+\d][\d-]*$/, '')
  return s.replace(/\s+/g, ' ').trim()
}

// Record a completed sync so every device can show when a source last ran.
export async function recordSync(db: D1Database, source: string, summary: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (source, synced_at, summary) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET synced_at = excluded.synced_at, summary = excluded.summary`
    )
    .bind(source, new Date().toISOString(), summary)
    .run()
}

export interface IngestRowIn {
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

export interface IngestOutcome {
  inserted: number
  duplicates: number
  flagged: Array<{ account_id: string; date: string; description: string; amount_cents: number }>
  unknown_accounts: string[]
}

// The single write path into the ledger. Dedup and lock enforcement live
// here so no caller - CLI push, server-side Wise sync, anything later - can
// silently duplicate a transaction or rewrite locked history.
export async function ingestRows(db: D1Database, rows: IngestRowIn[]): Promise<IngestOutcome> {
  const accountIds = [...new Set(rows.map((r) => r.account_id))]
  const known = new Set(
    ((await db.prepare('SELECT id FROM accounts').all()).results as Array<{ id: string }>).map((a) => a.id)
  )
  const unknown = accountIds.filter((a) => !known.has(a))

  let inserted = 0
  let duplicates = 0
  const flagged: IngestOutcome['flagged'] = []

  for (const accountId of accountIds) {
    if (!known.has(accountId)) continue
    const accountRows = rows.filter((r) => r.account_id === accountId)

    const existing = new Set(
      (
        (await db
          .prepare('SELECT semantic_hash FROM transactions WHERE account_id = ?')
          .bind(accountId)
          .all()).results as Array<{ semantic_hash: string }>
      ).map((r) => r.semantic_hash)
    )
    const ckptDate = await lastVerifiedDate(db, accountId)

    const toInsert: IngestRowIn[] = []
    for (const r of accountRows) {
      if (existing.has(r.semantic_hash)) {
        duplicates++
      } else if (ckptDate && r.date < ckptDate) {
        // Strictly before: a checkpoint verifies a balance at a moment, not
        // the end of its day, so a transaction landing later that same day
        // must insert - flipping the checkpoint to a visible mismatch - not
        // vanish into the flagged list (a real eBag charge was lost this way:
        // reconciled at noon, charged at night, dropped on the next sync).
        flagged.push({
          account_id: r.account_id,
          date: r.date,
          description: r.description,
          amount_cents: r.amount_cents,
        })
      } else {
        existing.add(r.semantic_hash) // in-payload dupes count once
        toInsert.push(r)
      }
    }

    const stmt = db.prepare(
      `INSERT OR IGNORE INTO transactions
        (account_id, date, description, amount_cents, balance_after_cents, source_file, semantic_hash, external_id, meta, merchant_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < toInsert.length; i += 50) {
      const chunk = toInsert.slice(i, i + 50)
      const results = await db.batch(
        chunk.map((r) =>
          stmt.bind(
            r.account_id,
            r.date,
            r.description,
            r.amount_cents,
            r.balance_after_cents ?? null,
            r.source_file,
            r.semantic_hash,
            r.external_id ?? null,
            r.meta ?? null,
            merchantKey(r.description)
          )
        )
      )
      for (const res of results) inserted += res.meta.changes ?? 0
    }
  }

  return { inserted, duplicates, flagged, unknown_accounts: unknown }
}
