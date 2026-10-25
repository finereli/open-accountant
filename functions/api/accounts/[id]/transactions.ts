// GET /api/accounts/:id/transactions - the full ledger for one account:
// transactions in ledger order (date, id) with a server-computed running
// balance, resolved merchant and category (the tx_resolved view, shared with
// /api/spending, so the ledger and the spending view never disagree),
// plus the anchor and every checkpoint.

import type { Env } from '../../_lib'
import { json, error } from '../../_lib'

// The resolved shape of one ledger row (the client's Tx type, minus the
// running balance), shared with GET /api/transactions/:id.
export const LEDGER_SELECT = `SELECT t.id, t.account_id, t.date, t.description, t.amount_cents, t.balance_after_cents, t.locked,
              t.external_id, t.source_file, t.merchant_key, t.memo,
              (t.merchant_override_id IS NOT NULL) AS merchant_override,
              CASE t.merchant_source WHEN 'human' THEN 1 WHEN 'auto' THEN 1 WHEN 'proposed' THEN 0 END AS merchant_confirmed,
              t.merchant_source, t.category_source,
              t.res_merchant_id AS merchant_id, t.merchant_name, t.merchant_concept,
              ta.display_name AS merchant_transfer_name,
              (t.transfer_account_id IS NOT NULL) AS is_transfer,
              t.res_category_id AS category_id, cat.name AS category_name,
              (t.category_source = 'auto') AS category_auto,
              t.category_confirmed AS category_row
       FROM tx_resolved t
       LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
       LEFT JOIN categories cat ON cat.id = t.res_category_id`

export async function ledgerTransactions(db: D1Database, accountId: string) {
  const txs = await db
    .prepare(`${LEDGER_SELECT} WHERE t.account_id = ? ORDER BY t.date, t.id`)
    .bind(accountId)
    .all()
  return txs.results as Array<Record<string, unknown>>
}

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = params.id as string
  const db = env.DB

  const account = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first()
  if (!account) return error('Unknown account', 404)

  const [anchor, checkpoints, txs] = await Promise.all([
    db.prepare('SELECT date, balance_cents, source FROM ledger_anchors WHERE account_id = ?').bind(id).first(),
    db
      .prepare('SELECT * FROM reconciliation_checkpoints WHERE account_id = ? ORDER BY date, id')
      .bind(id)
      .all(),
    ledgerTransactions(db, id),
  ])

  const anchorRow = (anchor as { date: string; balance_cents: number; source: string | null } | null) ?? {
    date: '0000-01-01',
    balance_cents: 0,
    source: null,
  }

  let running = anchorRow.balance_cents
  const transactions = txs.map((t) => {
    running += t.amount_cents as number
    return { ...t, running_cents: running }
  })

  return json({ account, anchor: anchorRow, checkpoints: checkpoints.results, transactions })
}
