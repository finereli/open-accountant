// The auto-categorizer: one model call names the merchant AND picks the
// category for each transaction, independently, from everything the row
// carries - description, amount, currency, date, account, the bank's own
// hints (Plaid's merchant/category, Wise's card merchant and recipient) and
// how often the same description recurs. It writes only the auto_* columns;
// what people decided lives elsewhere and always wins (see tx_resolved in
// schema.sql), so a run can never undo a decision.
//
// What it knows about THIS household comes from data, not code:
//   - rules: plain-language lines the household maintains on the Rules screen
//   - category descriptions (Categories screen)
//   - the merchant names already in use, so names stay consistent
//   - recent corrections - each time a person overrode a pick
// Measured on one household's 589 human-labelled rows: categories 46% with
// bare category names, 68% with descriptions + history, 78% with six rules
// on top. A bigger model scored the same 78%: what limits it is information,
// so improving it means writing rules, not switching models.
//
// Runs behind transfer pairing after every sync/import, and in bulk through
// POST /api/auto-categorize.

import type { Env } from './_lib'
import { loadRules, ruleForModel } from './_corrections'

const MODEL = '@cf/qwen/qwen3.8-27b'
const BATCH = 25

export interface ClassifyRow {
  id: number
  account_name: string
  currency: string
  date: string
  amount_cents: number
  description: string
  merchant_key: string | null
  meta: string | null
  known_merchant: string | null // a person already named this row's merchant
}

export interface ClassifyContext {
  rules: string[]
  ruleIds?: number[] // parallel to rules: lets the model cite which ones it used
  accounts: string[] // the household's own accounts, by display name
  categories: Array<{ name: string; description: string | null }>
  merchants: string[] // names already in use
  corrections: string[] // one line each, newest first
}

export interface Pick {
  id: number
  merchant: string | null
  category: string | null
  rules?: number[] // rule ids the model says it relied on
}

// The bank's own reading of the row, from the source JSON kept in meta.
export function bankHints(meta: string | null): Record<string, string> {
  const h: Record<string, string> = {}
  if (!meta) return h
  let m: Record<string, any>
  try {
    m = JSON.parse(meta)
  } catch {
    return h
  }
  if (m.personal_finance_category !== undefined) {
    // Plaid
    if (m.merchant_name) h.bank_merchant = m.merchant_name
    const cp = (m.counterparties ?? []).find((c: any) => c?.name)
    if (cp && cp.name !== m.merchant_name) h.counterparty = cp.name
    if (m.merchant_category_code) h.mcc = String(m.merchant_category_code)
    if (m.personal_finance_category?.detailed) h.bank_category = m.personal_finance_category.detailed
    if (m.location?.city) h.city = m.location.city
  } else if (m.details) {
    // Wise
    const d = m.details
    if (d.type) h.kind = d.type
    if (d.recipient?.name) h.recipient = d.recipient.name
    if (d.senderName) h.sender = d.senderName
    if (d.paymentReference) h.reference = String(d.paymentReference)
    if (d.merchant?.name) h.card_merchant = d.merchant.name
    if (d.merchant?.city) h.city = d.merchant.city
    if (d.merchant?.country) h.country = d.merchant.country
    if (d.merchant?.category ?? d.category) h.bank_category = d.merchant?.category ?? d.category
    if (d.amount?.currency && m.amount?.currency && d.amount.currency !== m.amount.currency)
      h.original_amount = `${d.amount.value} ${d.amount.currency}`
  }
  return h
}

const money = (cents: number, cur: string) => `${cents > 0 ? '+' : ''}${(cents / 100).toFixed(2)} ${cur}`
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function itemFor(
  r: ClassifyRow,
  history: { n: number; months: number; first: string; last: string } | undefined,
  sameMonth: number[] | undefined
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: r.id,
    date: `${r.date} ${WEEKDAY[new Date(r.date + 'T00:00:00Z').getUTCDay()]}`,
    account: r.account_name,
    amount: money(r.amount_cents, r.currency),
    description: r.description,
    ...bankHints(r.meta),
  }
  if (history && history.n >= 2)
    item.history = `${history.n} times in ${history.months} months (${history.first.slice(0, 7)}..${history.last.slice(0, 7)})`
  if (sameMonth && sameMonth.length > 1) item.same_month = sameMonth.map((c) => money(c, r.currency)).join(', ')
  if (r.known_merchant) item.merchant_is = r.known_merchant
  return item
}

export function buildPrompt(ctx: ClassifyContext, items: Array<Record<string, unknown>>): string {
  const cats = ctx.categories.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n')
  return `You name and categorize a household's bank transactions.

${ctx.rules.length ? `ABOUT THE HOUSEHOLD AND ITS RULES (these override everything below):\n${ctx.rules.map((r, i) => (ctx.ruleIds ? `- [R${ctx.ruleIds[i]}] ${r}` : `- ${r}`)).join('\n')}\n` : ''}
Their own accounts: ${ctx.accounts.join(', ')}.

CATEGORIES (name: what belongs there):
${cats}

MERCHANT NAMES ALREADY IN USE (reuse one when it is the same business):
${ctx.merchants.join(', ') || '(none yet)'}

How to name the merchant:
- The name people would say: the brand or person, without legal suffixes (Inc, LLC, Ltd, GmbH, SA, SRL, BV, Pty and their local equivalents), store numbers, cities or reference codes.
- Descriptions can be in any language or script, abbreviated, truncated or transliterated. Name the business the way the household would say it, and reuse a name already in use when it is the same place.
- Look past payment processors and app stores (Square "SQ *", Toast "TST*", Stripe, SumUp, Paddle, Gumroad, PayPal, Google *, Apple) to the business actually paid.
- A small one-off local place that is not a chain gets its type instead of its name: Restaurant, Cafe, Bakery, Street Vendor, Convenience Store, Groceries, Gas Station, Parking, ATM, Hotel, Taxi, Pharmacy.
- A fee row ("Wise Charges for: ...", monthly account fees, service charges) is "Bank Fee" - never the bank's or provider's name, and never the purchase or transfer it was charged on.
- Paying off a credit card or line of credit ("payment - thank you", "card bill payment", "autopay") and cash advances are "Transfer" - never the bank's name.
- Money sent to or received from a person is that person's name, unless it is the account holder themselves or one of the household's own accounts.
- Money between the household's own accounts is "Transfer" (category Transfers, Debt Repay or Debt Borrow); interest is "Interest"; currency conversions are "Currency Conversion".
- When merchant_is is given, a person already named the merchant: use that name.
${ctx.corrections.length ? `\nCORRECTIONS THE HOUSEHOLD MADE TO EARLIER PICKS (learn from them):\n${ctx.corrections.join('\n')}\n` : ''}
TRANSACTIONS (JSON lines; amounts are signed, + is money in; other fields are the bank's own hints; history = how often this exact description appears; same_month = other amounts with this description that month):
${items.map((i) => JSON.stringify(i)).join('\n')}

Answer with a JSON array only, one entry per transaction: [{"id": <id>, "merchant": "<name>", "category": "<category name>"${ctx.ruleIds ? ', "rules": [<numbers of the rules above that decided this row, e.g. 9 for [R9]; [] if none>]' : ''}}, ...]`
}

export function parsePicks(text: string, ids: Set<number>): Pick[] {
  const s = text.indexOf('[')
  const e = text.lastIndexOf(']')
  if (s < 0 || e <= s) return []
  let arr: unknown
  try {
    arr = JSON.parse(text.slice(s, e + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: Pick[] = []
  for (const x of arr as Array<Record<string, unknown>>) {
    if (!x || typeof x.id !== 'number' || !ids.has(x.id)) continue
    const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 60 ? v.trim() : null)
    const rules = Array.isArray(x.rules)
      ? [...new Set(x.rules.map((v) => (typeof v === 'string' ? Number(v.replace(/^R/i, '')) : v)))].filter(
          (v): v is number => typeof v === 'number' && Number.isInteger(v)
        )
      : undefined
    out.push({ id: x.id, merchant: str(x.merchant), category: str(x.category), rules })
  }
  return out
}

function responseText(out: unknown): string {
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: string } }> }
  if (typeof o.response === 'string') return o.response
  if (o.response !== undefined) return JSON.stringify(o.response)
  return o.choices?.[0]?.message?.content ?? ''
}

export async function loadContext(db: D1Database): Promise<ClassifyContext> {
  const [rules, accounts, categories, merchants, corrections] = await Promise.all([
    loadRules(db, { active: true }),
    db.prepare('SELECT display_name FROM accounts ORDER BY sort').all<{ display_name: string }>(),
    db.prepare('SELECT name, description FROM categories ORDER BY sort, id').all<{ name: string; description: string | null }>(),
    db
      .prepare(
        `SELECT DISTINCT m.household_name AS name FROM merchants m
         WHERE m.household_name IS NOT NULL AND m.transfer_account_id IS NULL
           AND m.id IN (SELECT res_merchant_id FROM tx_resolved WHERE res_merchant_id IS NOT NULL)
         ORDER BY m.household_name COLLATE NOCASE`
      )
      .all<{ name: string }>(),
    db
      .prepare(
        `SELECT c.field, c.auto_value, c.human_value, t.description, t.amount_cents, t.date, ac.currency
         FROM corrections c JOIN transactions t ON t.id = c.transaction_id JOIN accounts ac ON ac.id = t.account_id
         ORDER BY c.id DESC LIMIT 40`
      )
      .all<{
        field: string
        auto_value: string | null
        human_value: string | null
        description: string
        amount_cents: number
        date: string
        currency: string
      }>(),
  ])
  return {
    rules: rules.map(ruleForModel),
    ruleIds: rules.map((r) => r.id),
    accounts: accounts.results.map((a) => a.display_name),
    categories: categories.results,
    merchants: merchants.results.map((m) => m.name),
    corrections: corrections.results.map(
      (c) =>
        `- "${c.description}" ${money(c.amount_cents, c.currency)} on ${c.date}: ${c.field} is ${c.human_value ?? 'none'}${
          c.auto_value ? ` (not ${c.auto_value})` : ''
        }`
    ),
  }
}

// Get-or-create, case-insensitively, so casing wobbles never mint twins.
// Batches run in parallel, so the cache holds the pending lookup itself:
// two batches naming the same new place share one insert.
function merchantIdFor(db: D1Database, name: string, cache: Map<string, Promise<number | null>>): Promise<number | null> {
  // Own-account movement is identified by transfer pairing, not by name.
  if (/^transfer\b/i.test(name)) return Promise.resolve(null)
  const k = name.toLowerCase()
  if (!cache.has(k)) cache.set(k, lookupOrCreate(db, name))
  return cache.get(k)!
}

async function lookupOrCreate(db: D1Database, name: string): Promise<number> {
  const existing = await db
    .prepare('SELECT id FROM merchants WHERE household_name = ? COLLATE NOCASE AND transfer_account_id IS NULL ORDER BY id LIMIT 1')
    .bind(name)
    .first<{ id: number }>()
  let id: number
  if (existing) id = existing.id
  else {
    const res = await db
      .prepare('INSERT INTO merchants (household_name, created_at) VALUES (?, ?)')
      .bind(name, new Date().toISOString())
      .run()
    id = Number(res.meta.last_row_id)
  }
  return id
}

export interface ClassifyResult {
  ok: boolean
  message?: string
  skipped: number // fully decided by people: nothing to guess
  classified: number
  failed: number
  remaining: number
}

// Classifies up to `limit` rows from the queue (auto_at IS NULL), `parallel`
// model calls at a time. A batch whose answer doesn't parse is left in the
// queue for the next run.
export async function classifyPending(
  env: Env,
  opts: { limit?: number; parallel?: number } = {}
): Promise<ClassifyResult> {
  const db = env.DB
  const now = new Date().toISOString()
  const limit = opts.limit ?? 100
  const parallel = opts.parallel ?? 4

  // Rows a person fully decided (merchant and category, or a transfer) have
  // nothing left to guess: take them off the queue without a model call.
  const skip = await db
    .prepare(
      `UPDATE transactions SET auto_at = ?
       WHERE auto_at IS NULL AND id IN (
         SELECT id FROM tx_resolved
         WHERE merchant_source = 'human' AND (transfer_account_id IS NOT NULL OR category_source = 'human'))`
    )
    .bind(now)
    .run()
  const skipped = skip.meta.changes ?? 0

  const rows = (
    await db
      .prepare(
        `SELECT t.id, ac.display_name AS account_name, ac.currency, t.date, t.amount_cents, t.description,
                t.merchant_key, t.meta,
                CASE WHEN t.merchant_source = 'human' THEN COALESCE(t.merchant_name, t.merchant_concept) END AS known_merchant
         FROM tx_resolved t JOIN accounts ac ON ac.id = t.account_id
         WHERE t.auto_at IS NULL
         ORDER BY t.date DESC, t.id DESC LIMIT ?`
      )
      .bind(limit)
      .all<ClassifyRow>()
  ).results
  const remainingBefore = await db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE auto_at IS NULL')
    .first<{ n: number }>()
  if (rows.length === 0) return { ok: true, skipped, classified: 0, failed: 0, remaining: 0 }
  if (!env.AI || typeof env.AI.run !== 'function')
    return { ok: false, message: 'AI binding not attached', skipped, classified: 0, failed: 0, remaining: remainingBefore?.n ?? 0 }

  const ctx = await loadContext(db)
  const validRule = new Set(ctx.ruleIds ?? [])
  const catId = new Map(
    (await db.prepare('SELECT id, name FROM categories').all<{ id: number; name: string }>()).results.map((c) => [
      c.name.toLowerCase(),
      c.id,
    ])
  )

  // Recurrence: how often each description shows up, and its other amounts
  // in the same month (for rules like "the second $49 each month is ...").
  const keys = [...new Set(rows.map((r) => r.merchant_key).filter((k): k is string => !!k))]
  const history = new Map<string, { n: number; months: number; first: string; last: string }>()
  const monthly = new Map<string, number[]>()
  for (let i = 0; i < keys.length; i += 80) {
    const chunk = keys.slice(i, i + 80)
    const ph = chunk.map(() => '?').join(',')
    const h = await db
      .prepare(
        `SELECT merchant_key AS k, COUNT(*) AS n, COUNT(DISTINCT substr(date, 1, 7)) AS months,
                MIN(date) AS first, MAX(date) AS last
         FROM transactions WHERE merchant_key IN (${ph}) GROUP BY merchant_key`
      )
      .bind(...chunk)
      .all<{ k: string; n: number; months: number; first: string; last: string }>()
    for (const x of h.results) history.set(x.k, x)
    const m = await db
      .prepare(
        `SELECT merchant_key AS k, account_id || substr(date, 1, 7) AS bucket, amount_cents
         FROM transactions WHERE merchant_key IN (${ph}) ORDER BY date, id`
      )
      .bind(...chunk)
      .all<{ k: string; bucket: string; amount_cents: number }>()
    for (const x of m.results) {
      const key = `${x.k}|${x.bucket}`
      ;(monthly.get(key) ?? monthly.set(key, []).get(key)!).push(x.amount_cents)
    }
  }
  const accountIdOf = new Map(
    (await db.prepare('SELECT id, display_name FROM accounts').all<{ id: string; display_name: string }>()).results.map(
      (a) => [a.display_name, a.id]
    )
  )

  const batches: ClassifyRow[][] = []
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH))

  const cache = new Map<string, Promise<number | null>>()
  let classified = 0
  let failed = 0
  const runBatch = async (batch: ClassifyRow[]) => {
    const items = batch.map((r) =>
      itemFor(
        r,
        r.merchant_key ? history.get(r.merchant_key) : undefined,
        r.merchant_key ? monthly.get(`${r.merchant_key}|${accountIdOf.get(r.account_name)}${r.date.slice(0, 7)}`) : undefined
      )
    )
    let text = ''
    try {
      text = responseText(
        await env.AI.run(MODEL, {
          messages: [{ role: 'user', content: buildPrompt(ctx, items) }],
          max_tokens: 4000,
          temperature: 0,
          // Qwen reasons at length by default (minutes, then out of tokens);
          // this task doesn't need it.
          chat_template_kwargs: { enable_thinking: false },
        })
      )
    } catch {
      failed += batch.length
      return
    }
    const picks = parsePicks(text, new Set(batch.map((r) => r.id)))
    for (const p of picks) {
      const mid = p.merchant ? await merchantIdFor(db, p.merchant, cache) : null
      const cid = p.category ? (catId.get(p.category.toLowerCase()) ?? null) : null
      await db
        .prepare('UPDATE transactions SET auto_merchant_id = ?, auto_category_id = ?, auto_at = ? WHERE id = ?')
        .bind(mid, cid, now, p.id)
        .run()
      await db.prepare('DELETE FROM rule_uses WHERE transaction_id = ?').bind(p.id).run()
      for (const rid of p.rules ?? [])
        if (validRule.has(rid))
          await db.prepare('INSERT OR IGNORE INTO rule_uses (rule_id, transaction_id) VALUES (?, ?)').bind(rid, p.id).run()
      classified++
    }
    failed += batch.length - picks.length
  }
  for (let i = 0; i < batches.length; i += parallel) await Promise.all(batches.slice(i, i + parallel).map(runBatch))

  const remaining = await db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE auto_at IS NULL')
    .first<{ n: number }>()
  return { ok: true, skipped, classified, failed, remaining: remaining?.n ?? 0 }
}

// Put rows back in the queue - after rules or descriptions change, so the
// new understanding applies to history too. Human decisions are untouched.
export async function requeue(db: D1Database, since?: string): Promise<number> {
  const res = await db
    .prepare('UPDATE transactions SET auto_at = NULL WHERE (? IS NULL OR date >= ?)')
    .bind(since ?? null, since ?? null)
    .run()
  return res.meta.changes ?? 0
}
