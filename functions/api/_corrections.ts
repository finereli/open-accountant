// The learning loop's write side. When a person overrides what the
// auto-categorizer decided (or fills in what it couldn't), the before and
// after go into `corrections`, which the classifier shows back to the model
// on later runs. A person changing their own earlier decision isn't a
// correction of the model, so it isn't logged.

export interface Before {
  id: number
  merchant_source: string | null
  merchant_label: string | null
  category_source: string | null
  category_name: string | null
}

export async function resolvedBefore(db: D1Database, transactionId: number): Promise<Before | null> {
  return db
    .prepare(
      `SELECT t.id, t.merchant_source,
              COALESCE(t.merchant_name, t.merchant_concept, CASE WHEN t.transfer_account_id IS NOT NULL THEN 'Transfer' END) AS merchant_label,
              t.category_source, c.name AS category_name
       FROM tx_resolved t LEFT JOIN categories c ON c.id = t.res_category_id
       WHERE t.id = ?`
    )
    .bind(transactionId)
    .first<Before>()
}

export async function logCorrection(
  db: D1Database,
  before: Before | null,
  field: 'merchant' | 'category',
  humanValue: string | null,
  scope: 'row' | 'all'
): Promise<boolean> {
  if (!before) return false
  const source = field === 'merchant' ? before.merchant_source : before.category_source
  const autoValue = field === 'merchant' ? before.merchant_label : before.category_name
  if (source === 'human') return false
  if ((autoValue ?? '').toLowerCase() === (humanValue ?? '').toLowerCase()) return false
  await db
    .prepare(
      'INSERT INTO corrections (transaction_id, field, auto_value, human_value, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(before.id, field, autoValue, humanValue, scope, new Date().toISOString())
    .run()
  return true
}

// A "why" typed next to a correction becomes a rule, verbatim, tied to the
// transaction it was written on.
export async function addRule(db: D1Database, text: string, transactionId: number | null = null): Promise<number> {
  const now = new Date().toISOString()
  const max = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM rules').first<{ s: number }>()
  const res = await db
    .prepare('INSERT INTO rules (text, sort, transaction_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(text, (max?.s ?? 0) + 1, transactionId, now, now)
    .run()
  return Number(res.meta.last_row_id)
}

export interface RuleRow {
  id: number
  text: string
  sort: number
  updated_at: string
  transaction_id: number | null
  tx_description: string | null
  tx_amount_cents: number | null
  tx_date: string | null
  tx_currency: string | null
  tx_account: string | null
  tx_merchant: string | null
  tx_category: string | null
  retired_at: string | null
  created_at: string
  use_count: number
  last_used: string | null // latest transaction date it was relied on for
}

// Rules with the transaction each was written on, resolved as it stands now
// (so the example carries what the person settled on).
export async function loadRules(db: D1Database, opts: { active?: boolean } = {}): Promise<RuleRow[]> {
  return (
    await db
      .prepare(
        `SELECT r.id, r.text, r.sort, r.updated_at, r.created_at, r.retired_at, r.transaction_id,
                (SELECT COUNT(*) FROM rule_uses u WHERE u.rule_id = r.id) AS use_count,
                (SELECT MAX(ut.date) FROM rule_uses u JOIN transactions ut ON ut.id = u.transaction_id
                 WHERE u.rule_id = r.id) AS last_used,
                t.description AS tx_description, t.amount_cents AS tx_amount_cents, t.date AS tx_date,
                ac.currency AS tx_currency, ac.display_name AS tx_account,
                COALESCE(t.merchant_name, t.merchant_concept) AS tx_merchant, c.name AS tx_category
         FROM rules r
         LEFT JOIN tx_resolved t ON t.id = r.transaction_id
         LEFT JOIN accounts ac ON ac.id = t.account_id
         LEFT JOIN categories c ON c.id = t.res_category_id
         ${opts.active ? 'WHERE r.retired_at IS NULL' : ''}
         ORDER BY r.sort, r.id`
      )
      .all<RuleRow>()
  ).results
}

const money = (cents: number, cur: string) => `${cents > 0 ? '+' : ''}${(cents / 100).toFixed(2)} ${cur}`

// One rule as the model reads it: the note, then the row it was about.
export function ruleForModel(r: RuleRow): string {
  if (r.transaction_id === null || r.tx_description === null) return r.text
  const settled = [r.tx_merchant && `merchant ${r.tx_merchant}`, r.tx_category && `category ${r.tx_category}`]
    .filter(Boolean)
    .join(', ')
  return `${r.text} [written about "${r.tx_description}" ${money(r.tx_amount_cents ?? 0, r.tx_currency ?? '')} on ${r.tx_date} in ${r.tx_account}${settled ? `, filed as ${settled}` : ''}]`
}
