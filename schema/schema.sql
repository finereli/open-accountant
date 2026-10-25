-- Accountant schema (D1/SQLite). Money is integer minor units (cents, agorot)
-- so running balances never drift. Dates are YYYY-MM-DD strings.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '', -- whose account ('alex', 'sam'); groups the drawer
  institution TEXT NOT NULL DEFAULT '', -- 'Chase', 'Wise', ...; groups the dashboard
  kind TEXT NOT NULL,             -- 'checking' | 'savings' | 'wallet' | 'cash' | 'credit_card' | 'line_of_credit'
                                  -- (the last two are debt: shown apart, kept out of cash)
  currency TEXT NOT NULL,         -- ISO 4217 code: 'USD', 'EUR', ...
  display_name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  in_spending INTEGER NOT NULL DEFAULT 1, -- 0 = ledger only: out of Spending and the forecast's cash
  external_ref TEXT UNIQUE        -- which feed fills it: 'plaid:<account_id>', 'wise:<profile>:<CUR>';
                                  -- NULL = CSVs and screenshots only
);

-- Spending categories. A transaction's category is resolved at query time
-- (see tx_resolved): a person's choice for the row, else the merchant's
-- human-set category, else the auto-categorizer's pick for the row. kind
-- drives the Spending view:
-- income sums at the top, expense in the body, excluded is visible but
-- counts nowhere (self-transfer merchants awaiting real leg-linking).
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'expense',   -- 'income' | 'expense' | 'excluded'
  sort INTEGER NOT NULL DEFAULT 0,
  flow TEXT NOT NULL DEFAULT 'discrete',  -- forecast role: 'run_rate' (averages
                                          -- into daily burn) | 'discrete'
                                          -- (expected items) | 'subscriptions'
                                          -- (each merchant auto-projects
                                          -- monthly at its usual day/amount)
                                          -- | 'off' (ignored, e.g. Reimbursable)
  pinned_daily_cents INTEGER,             -- run-rate override: when you know better
  pinned_currency TEXT,                   -- than the trailing measurement
  description TEXT                        -- what belongs here, in plain words; the
                                          -- auto-categorizer reads it on every run
);

-- The forecast's expected money: recurring monthly items (day_of_month) or
-- one-offs (date), in their own currency, optionally ending (end_month,
-- YYYY-MM inclusive). account_id records where the money lands or leaves -
-- unused by the overall cash curve today, the hook for per-account
-- forecasts later.
CREATE TABLE IF NOT EXISTS expected_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- 'income' | 'expense'
  amount_cents INTEGER NOT NULL,          -- positive magnitude
  currency TEXT NOT NULL,
  -- Three shapes:
  --   monthly:    day_of_month set (optional end_month cap)
  --   one-off:    date set, per_day = 0
  --   daily rate: per_day = 1 - amount_cents is charged PER DAY. date and
  --               end_date are OPTIONAL bounds (null start = from today,
  --               null end = for the whole horizon). Models an ongoing
  --               average daily cost - e.g. accommodation while travelling.
  day_of_month INTEGER,                   -- monthly recurring (1-28 recommended)
  date TEXT,                              -- one-off date, or optional daily-rate start
  end_month TEXT,                         -- optional YYYY-MM, inclusive (monthly)
  end_date TEXT,                          -- optional daily-rate end (YYYY-MM-DD, inclusive)
  per_day INTEGER NOT NULL DEFAULT 0,     -- 1 = amount_cents is a per-day rate
  account_id TEXT REFERENCES accounts(id),
  category_id INTEGER REFERENCES categories(id),
  created_at TEXT NOT NULL
);

-- A manual override on a derived subscription: right now only a cancellation
-- (end_date). The merchant's monthly projection stops after end_date and the
-- Forecast shows the sub as cancelled; deleting the row returns the sub to
-- its pure-derived state. The one place the forecast lets a human contradict
-- what history measures.
CREATE TABLE IF NOT EXISTS sub_overrides (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id),
  end_date TEXT NOT NULL,          -- YYYY-MM-DD, inclusive: no charge projects after it
  created_at TEXT NOT NULL
);

-- Merchant identity is a lookup, never a mutation: transactions keep their
-- raw descriptions forever; display resolves merchant_key -> alias ->
-- merchant. Three merchant types, three sources of truth:
--   named:    household_name set - a specific shop ("Aldo" - what the household
--             calls it, unrecoverable from any data) OR a generalized bucket
--             ("Gas Station" - one-off places deliberately not itemized).
--             Buckets are just generalized merchants: same column, same
--             lookup, added at will. Open world; lookup + LLM + human taps.
--             (concept is a legacy column, folded into household_name.)
--   transfer: transfer_account_id set - the counterparty is one of the
--             household's own accounts. Derived from the accounts table,
--             displayed "Transfer: {account name}", excluded from spending
--             analysis later. Human-assigned only; the LLM never proposes.
-- All three fields null = the reserved keep-as-is merchant (reviewed,
-- description stands). Display: name ?? transfer ?? concept ?? description.
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_name TEXT,
  concept TEXT,
  transfer_account_id TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),        -- null = Uncategorized
  small_category_id INTEGER REFERENCES categories(id),  -- price gate: purchases
  small_max_cents INTEGER,                              -- up to this go there instead
  category_auto INTEGER NOT NULL DEFAULT 0              -- 1 = category picked by the auto-categorizer, not a human
);

-- normalized_raw is the cleaned+normalized description (see merchantKey in
-- functions/api/_lib.ts). confirmed=1 rows are human decisions - the learned
-- alias table, deterministic forever. confirmed=0 rows are LLM proposals,
-- shown as provisional until a human confirms or corrects.
CREATE TABLE IF NOT EXISTS merchant_aliases (
  normalized_raw TEXT PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,          -- signed: positive = money in
  balance_after_cents INTEGER,            -- from the institution, when it gives one
  source_file TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,            -- dedup key (see cli/parsers)
  external_id TEXT,                       -- the source's own id (Wise); null for CSVs
  merchant_key TEXT,                      -- cleaned description; joins merchant_aliases
  merchant_override_id INTEGER REFERENCES merchants(id),
                                          -- row-level assignment that BEATS the key alias.
                                          -- For degenerate keys ("free interac e-transfer")
                                          -- where the bank names no counterparty and one key
                                          -- spans many real senders. Human-set, always final.
  payee_id INTEGER,                       -- unused legacy column (kept: D1 rows carry it)
  category_id INTEGER,                    -- a person's category for THIS row (with
  category_confirmed INTEGER NOT NULL DEFAULT 0, -- category_confirmed=1); beats everything
  auto_merchant_id INTEGER REFERENCES merchants(id),   -- the auto-categorizer's merchant
  auto_category_id INTEGER REFERENCES categories(id),  -- and category for this row; only
  auto_at TEXT,                           -- shown where no person decided. auto_at = when it
                                          -- last looked (NULL = not yet: the queue)
  memo TEXT,                               -- optional per-transaction note ("birthday gift")
  locked INTEGER NOT NULL DEFAULT 0,      -- set when covered by a checkpoint
  meta TEXT                               -- full source row as JSON (Wise carries a lot)
);

CREATE INDEX IF NOT EXISTS idx_tx_auto_at ON transactions(auto_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup ON transactions(account_id, semantic_hash);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date);

CREATE TABLE IF NOT EXISTS reconciliation_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,         -- the number seen at the institution
  computed_cents INTEGER,                 -- what the ledger said at lock time
  verified_at TEXT NOT NULL               -- ISO timestamp
);
-- A checkpoint's CURRENT discrepancy is always derived live:
-- balance_cents - (anchor + sum of transactions <= date). Zero = verified,
-- the period is frozen. Nonzero = attested-with-mismatch: the institution's
-- number is recorded as ground truth, the account is flagged, and the period
-- stays OPEN so corrections can land; when they do and the numbers meet, the
-- freeze engages by itself. Freezing known-wrong history would block the
-- very corrections an investigation produces.

CREATE INDEX IF NOT EXISTS idx_ckpt_account ON reconciliation_checkpoints(account_id, date);

-- When each remote source last completed a sync, and what it did. Server-side
-- so every device sees the truth, not its own localStorage's guess.
CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,        -- 'wise', or any source you add
  synced_at TEXT NOT NULL,        -- ISO timestamp
  summary TEXT                    -- e.g. '3 new · 2 matched'
);

-- Plaid's sync cursor per linked bank (Item). The access tokens themselves
-- are a Pages secret (PLAID_ACCESS_TOKENS), never stored here.
CREATE TABLE IF NOT EXISTS plaid_state (
  item_id TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  date TEXT NOT NULL,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (date, from_currency, to_currency)
);

-- Starting balance per account: the balance at the START of `date`
-- (i.e. the 2026-01-01 anchor is the closing balance of Dec 31, 2025).
CREATE TABLE IF NOT EXISTS ledger_anchors (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  date TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  source TEXT           -- 'derived' | 'manual' | 'absorbed'; NULL = never deliberately set.
                        -- A sourced anchor that later disagrees with reconciliation means
                        -- MISSING/DUPLICATE TRANSACTIONS - surface that, never silently re-absorb.
);

-- Plain-language rules the auto-categorizer reads on every run, in order:
-- who the household is, how they think about money, the exceptions
-- ("AliExpress orders are for the kids"). Edited on the Rules screen.
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  -- The row a "why" was written on: a note like "at this amount" only makes
  -- sense next to the transaction it was about, so the model sees both.
  transaction_id INTEGER REFERENCES transactions(id),
  retired_at TEXT,      -- retired: kept for the record, no longer read by the model
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Which rules the model said it relied on for each auto pick - how the Rules
-- screen knows a rule is still earning its place. Rewritten each time the row
-- is classified.
CREATE TABLE IF NOT EXISTS rule_uses (
  rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  PRIMARY KEY (rule_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS rule_uses_tx ON rule_uses(transaction_id);

-- Every time a person changes what the auto-categorizer decided, the before
-- and after - the examples it learns from (shown back to it on later runs)
-- and the raw material for new rules.
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  field TEXT NOT NULL,                    -- 'merchant' | 'category'
  auto_value TEXT,                        -- what it had picked (name), NULL = nothing
  human_value TEXT,                       -- what the person chose (name)
  scope TEXT NOT NULL DEFAULT 'row',      -- 'row' | 'all' (every row with this description)
  created_at TEXT NOT NULL
);

-- The one place merchant and category are resolved. Every screen and report
-- reads through here, so they can never disagree.
--   merchant: row override (human) > confirmed key alias (human)
--             > auto pick > unconfirmed key alias (old LLM proposal)
--   category: transfer merchants have none; else the row's human category
--             > the merchant's human category (price gate applied)
--             > the row's auto pick > the merchant's auto category
DROP VIEW IF EXISTS tx_resolved;
CREATE VIEW tx_resolved AS
SELECT b.*,
       m.household_name AS merchant_name,
       m.concept AS merchant_concept,
       m.transfer_account_id AS transfer_account_id,
       CASE
         WHEN m.transfer_account_id IS NOT NULL THEN NULL
         WHEN b.category_confirmed = 1 THEN b.category_id
         WHEN m.category_id IS NOT NULL AND m.category_auto = 0 THEN
           CASE WHEN m.small_category_id IS NOT NULL AND m.small_max_cents IS NOT NULL
                     AND ABS(b.amount_cents) <= m.small_max_cents
                THEN m.small_category_id ELSE m.category_id END
         WHEN b.auto_category_id IS NOT NULL THEN b.auto_category_id
         ELSE m.category_id
       END AS res_category_id,
       CASE
         WHEN m.transfer_account_id IS NOT NULL THEN NULL
         WHEN b.category_confirmed = 1 THEN 'human'
         WHEN m.category_id IS NOT NULL AND m.category_auto = 0 THEN 'human'
         WHEN b.auto_category_id IS NOT NULL THEN 'auto'
         WHEN m.category_id IS NOT NULL THEN 'auto'
       END AS category_source
FROM (
  SELECT t.*,
         COALESCE(t.merchant_override_id,
                  CASE WHEN a.confirmed = 1 THEN a.merchant_id END,
                  t.auto_merchant_id,
                  a.merchant_id) AS res_merchant_id,
         CASE
           WHEN t.merchant_override_id IS NOT NULL OR a.confirmed = 1 THEN 'human'
           WHEN t.auto_merchant_id IS NOT NULL THEN 'auto'
           WHEN a.merchant_id IS NOT NULL THEN 'proposed'
         END AS merchant_source
  FROM transactions t
  LEFT JOIN merchant_aliases a ON a.normalized_raw = t.merchant_key
) b
LEFT JOIN merchants m ON m.id = b.res_merchant_id;

-- Screenshot imports read in the background: the phone uploads the strips
-- and can leave the app; the server reads them and keeps each result here
-- until the import is reviewed (then the job is deleted). A strip stuck in
-- 'working' past its claim is retried by the next poll.
CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_strips (
  job_id INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  image TEXT,                               -- data URL; cleared once read
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | working | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  rows TEXT,                                -- JSON ReadRow[] once done
  PRIMARY KEY (job_id, idx)
);

-- The fun allowance: first-class, not an expected expense.
-- month = 'YYYY-MM' for a month set on its own, or 'default' for every
-- other month. The forecast takes each month's allowance on its 1st (the
-- current month's on the next projected day). locked_at/snapshot: the
-- month's plan as it was locked - what plan-vs-reality compares against.
CREATE TABLE IF NOT EXISTS allowance_months (
  month TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  locked_at TEXT,
  snapshot TEXT
);

-- Things the allowance is meant for in a month: a dinner out, a course, a
-- day trip. Toggled on/off while tinkering; inside the allowance they cost
-- nothing extra, beyond it the overage reaches the forecast.
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,                 -- YYYY-MM
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,       -- positive
  currency TEXT NOT NULL,
  date TEXT,                           -- YYYY-MM-DD, or NULL = sometime that month
  active INTEGER NOT NULL DEFAULT 1,   -- toggled into the plan
  created_at TEXT NOT NULL
);

-- MCP (read-only tools at /mcp) for Claude and other agents: OAuth 2.1 the
-- way the MCP spec asks - dynamic client registration, authorization code
-- with PKCE, rotating refresh tokens. The owner approves a client by signing
-- in through Cloudflare Access as OWNER_EMAIL. Tokens are stored hashed.
CREATE TABLE IF NOT EXISTS mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  redirect_uris TEXT NOT NULL,     -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mcp_pending (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
  hash TEXT PRIMARY KEY,           -- sha256 of the token, base64url
  kind TEXT NOT NULL,              -- code | access | refresh
  client_id TEXT NOT NULL,
  redirect_uri TEXT,
  code_challenge TEXT,
  expires_at INTEGER NOT NULL,     -- epoch seconds
  last_used TEXT
);
