// Automatic categorization, so the ledger needs as little hand-sorting as
// possible. Runs after every sync and screenshot import, and on demand via
// POST /api/auto-categorize. Two steps:
//
// 1. Transfers - deterministic, no AI. Wise-to-Wise legs pair exactly, by
//    the reference Wise stamps on both. Otherwise, a row whose description reads like
//    money moving between the household's own accounts, and that isn't
//    already a transfer, is paired with an opposite movement on another
//    account (both legs transfer-shaped, within 4 days, amounts equal - or
//    within 4% across currencies). Both legs get a row-level override to the
//    "Transfer: <other account>" merchant. An e-transfer is the classic case:
//    one bank description covers money in and out from anyone, so no alias
//    can be right; the pairing is what identifies it.
//
// 2. Merchant and category per transaction - the classifier (_classify.ts)
//    names the merchant and picks the category for every row still in its
//    queue, from the whole row plus the household's rules.
//
// Human decisions are final throughout: rows with a manual override and
// merchants with a category are never touched.

import type { Env } from './_lib'
import { classifyPending } from './_classify'

// Descriptions that read like money moving between own accounts. Matching
// one is necessary but never sufficient: the other leg must exist too.
export const TRANSFERISH =
  /interac e-?transfer|sent money to|received money from|miscellaneous payment wise|topped up account|crd\.? card bill payment|payment from - \*|customer transfer (cr|dr)\.|cash advance to|debit memo|online (banking )?transfer|transfer (to|from) (chequing|checking|savings)|payment - thank you|autopay|payment to\b.*\b(visa|mastercard|amex|card|credit)|converted [\d.,]+ [a-z]{3} to|moved [\d.,]+ [a-z]{3} (to|from)/i

const DAY = 86400000
const WINDOW_DAYS = 4
const FX_TOLERANCE = 0.04

interface Row {
  id: number
  account_id: string
  currency: string
  date: string
  amount_cents: number
  description: string
  overridden: number // 1 = a human assigned this row
  transfer_to: string | null // resolved merchant is a transfer to this account
  excluded: number // resolved category is an excluded kind
  merchant_name: string | null
  categorized_by_human: number // resolved merchant has a category a person chose
  ref: string | null // Wise's reference: both legs of a Wise-to-Wise transfer carry the same one
}

export interface TransferPair {
  from_id: number // the row that wasn't a transfer yet
  to_id: number // its other leg
  from_account: string
  to_account: string
}

export async function findTransfers(db: D1Database, since: string): Promise<TransferPair[]> {
  const rows = (
    await db
      .prepare(
        `SELECT t.id, t.account_id, ac.currency, t.date, t.amount_cents, t.description,
                (t.merchant_override_id IS NOT NULL) AS overridden,
                m.transfer_account_id AS transfer_to,
                COALESCE(c.kind = 'excluded', 0) AS excluded,
                COALESCE(m.household_name, m.concept) AS merchant_name,
                (m.category_id IS NOT NULL AND m.category_auto = 0) AS categorized_by_human,
                CASE WHEN json_valid(t.meta) THEN json_extract(t.meta, '$.referenceNumber') END AS ref
         FROM transactions t
         JOIN accounts ac ON ac.id = t.account_id
         LEFT JOIN merchant_aliases a ON a.normalized_raw = t.merchant_key
         LEFT JOIN merchants m ON m.id = COALESCE(t.merchant_override_id, a.merchant_id)
         LEFT JOIN categories c ON c.id = m.category_id
         WHERE t.date >= date(?, '-5 days')
         ORDER BY t.date, t.id`
      )
      .bind(since)
      .all<Row>()
  ).results
  const fx = Object.fromEntries(
    (
      await db
        .prepare(
          `SELECT from_currency, rate FROM fx_rates
           WHERE to_currency = 'USD' AND date = (SELECT MAX(date) FROM fx_rates WHERE to_currency = 'USD')`
        )
        .all<{ from_currency: string; rate: number }>()
    ).results.map((r) => [r.from_currency, r.rate])
  )

  const transferShaped = (r: Row) => TRANSFERISH.test(r.description) || r.transfer_to !== null || r.excluded === 1
  // Needs fixing: transfer-shaped text, not already treated as a transfer,
  // and not resting on a merchant a person named and categorized ("Alex
  // Smith" -> Food is a decision) - unless that merchant is just the
  // channel itself ("Interac E-Transfer"), which says nothing about who.
  const genericMerchant = (r: Row) =>
    r.merchant_name === null || !r.categorized_by_human || TRANSFERISH.test(r.merchant_name)
  // A leg already filed as excluded ("Alex Smith" in Transfers) is money
  // moving too - it just doesn't say where; linking it says that.
  const needsPair = (r: Row) =>
    r.date >= since &&
    !r.overridden &&
    r.transfer_to === null &&
    TRANSFERISH.test(r.description) &&
    (r.excluded === 1 || genericMerchant(r))
  // May become (or already is) a transfer to `other`: not a row a person
  // assigned to something else, not someone's deliberate spending/income
  // merchant ("Alex Smith" -> Food).
  const linkable = (r: Row, other: string) =>
    r.transfer_to === other ||
    (r.transfer_to === null && !r.overridden && (r.excluded === 1 || genericMerchant(r)))

  // How far apart two legs are: null when they can't be the same money.
  const distance = (a: Row, b: Row): number | null => {
    if (a.account_id === b.account_id || Math.sign(a.amount_cents) === Math.sign(b.amount_cents)) return null
    const days = Math.abs(Date.parse(a.date) - Date.parse(b.date)) / DAY
    if (days > WINDOW_DAYS) return null
    let rel: number
    if (a.currency === b.currency) {
      if (Math.abs(a.amount_cents) !== Math.abs(b.amount_cents)) return null
      rel = 0
    } else {
      if (!fx[a.currency] || !fx[b.currency]) return null
      const aInB = (Math.abs(a.amount_cents) * fx[a.currency]) / fx[b.currency]
      rel = Math.abs(aInB - Math.abs(b.amount_cents)) / Math.abs(b.amount_cents)
      if (rel > FX_TOLERANCE) return null
    }
    return days + rel * 100
  }

  const used = new Set<number>()
  const pairs: TransferPair[] = []

  // Exact first: Wise gives both legs of a transfer between Wise balances
  // the same reference (TRANSFER-123...), whatever the currencies. Fee rows
  // carry their own, so a reference shared by exactly two rows is one
  // transfer - no amounts or dates to judge.
  const byRef = new Map<string, Row[]>()
  for (const r of rows) if (r.ref?.startsWith('TRANSFER-')) byRef.set(r.ref, [...(byRef.get(r.ref) ?? []), r])
  for (const legs of byRef.values()) {
    if (legs.length !== 2) continue
    const [a, b] = legs
    if (a.account_id === b.account_id || Math.sign(a.amount_cents) === Math.sign(b.amount_cents)) continue
    if (a.date < since && b.date < since) continue
    if (a.transfer_to === b.account_id && b.transfer_to === a.account_id) continue
    if (!linkable(a, b.account_id) || !linkable(b, a.account_id)) continue
    used.add(a.id)
    used.add(b.id)
    pairs.push({ from_id: a.id, to_id: b.id, from_account: a.account_id, to_account: b.account_id })
  }

  // Candidate other legs for `r`, best first. A leg already marked as a
  // transfer to some OTHER account belongs to that transfer, not this one.
  const ranked = (r: Row) =>
    rows
      .filter((o) => o.id !== r.id && !used.has(o.id) && transferShaped(o) && linkable(o, r.account_id))
      .map((o) => ({ o, d: distance(r, o) }))
      .filter((x): x is { o: Row; d: number } => x.d !== null)
      .sort((x, y) => x.d - y.d)
  // Two equally good partners: can't tell which is the real other leg.
  const clear = (opts: Array<{ d: number }>) => opts.length === 1 || opts[1].d - opts[0].d >= 0.5

  for (const r of rows.filter(needsPair)) {
    if (used.has(r.id)) continue
    const options = ranked(r)
    if (options.length === 0 || !clear(options)) continue
    const o = options[0].o
    // And the same from the other side: if o fits another row as well as
    // this one, which of them is its partner is a guess.
    if (!linkable(r, o.account_id) || !clear(ranked(o))) continue
    used.add(r.id)
    used.add(o.id)
    pairs.push({ from_id: r.id, to_id: o.id, from_account: r.account_id, to_account: o.account_id })
  }
  return pairs
}

// One merchant per own account, created on first use - same as a human
// picking "Transfer: <account>" in the merchant sheet.
async function transferMerchantId(db: D1Database, accountId: string): Promise<number> {
  const existing = await db
    .prepare('SELECT id FROM merchants WHERE transfer_account_id = ?')
    .bind(accountId)
    .first<{ id: number }>()
  if (existing) return existing.id
  const res = await db
    .prepare('INSERT INTO merchants (household_name, concept, transfer_account_id, created_at) VALUES (NULL, NULL, ?, ?)')
    .bind(accountId, new Date().toISOString())
    .run()
  return Number(res.meta.last_row_id)
}

export async function applyTransfers(db: D1Database, pairs: TransferPair[]): Promise<number> {
  let changed = 0
  for (const p of pairs) {
    // Each leg points at the OTHER account. Only rows without a human
    // override are written; an already-correct leg is left as it is.
    for (const [rowId, other] of [
      [p.from_id, p.to_account],
      [p.to_id, p.from_account],
    ] as const) {
      const mid = await transferMerchantId(db, other)
      const res = await db
        .prepare('UPDATE transactions SET merchant_override_id = ? WHERE id = ? AND merchant_override_id IS NULL')
        .bind(mid, rowId)
        .run()
      changed += res.meta.changes ?? 0
    }
  }
  return changed
}

// Transfers first, so paired rows leave the classifier's queue as decided.
export async function runAutoCategorize(env: Env, opts: { days?: number; limit?: number; parallel?: number } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 120) * DAY).toISOString().slice(0, 10)
  const pairs = await findTransfers(env.DB, since)
  const transferRows = await applyTransfers(env.DB, pairs)
  const classify = await classifyPending(env, { limit: opts.limit ?? 50, parallel: opts.parallel })
  return { transfer_pairs: pairs.length, transfer_rows: transferRows, classify }
}
