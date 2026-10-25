// POST /api/merchants/assign - the one human decision of the merchant layer:
// "this raw string is that merchant." Creates the alias (confirmed), creating
// the merchant first if the request carries a new one. Because display
// resolves through the alias table, the decision propagates instantly to
// every transaction sharing the key - past and future - with no writes to
// transactions.
//
// Body: { merchant_key: string,
//         merchant_id?: number,                       -- existing merchant
//         new_merchant?: { household_name?: string, concept?: string },
//         transfer_account_id?: string,               -- counterparty is our own account
//         keep_description?: true,                    -- "reviewed, fine as is"
//         transaction_id?: number,                    -- the row the decision was made from
//         apply_all?: boolean,                        -- true: write the key alias (all rows
//                                                        sharing the key, and future ones);
//                                                        false: row-level override only
//         reason?: string }                           -- optional "why", saved as a rule
//
// Made from a row the auto-categorizer had named, it's also logged as a
// correction the classifier learns from (_corrections.ts).

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { resolvedBefore, logCorrection, addRule } from '../_corrections'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: {
    merchant_key?: string
    merchant_id?: number
    new_merchant?: { household_name?: string; concept?: string }
    transfer_account_id?: string
    keep_description?: boolean
    transaction_id?: number
    apply_all?: boolean
    reason?: string
  }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const key = body.merchant_key?.trim()
  if (!key && !body.transaction_id) return error('merchant_key or transaction_id required')

  const db = env.DB
  let merchantId = body.merchant_id
  const before = body.transaction_id ? await resolvedBefore(db, body.transaction_id) : null

  if (!merchantId && body.transfer_account_id) {
    // Transfer merchant: the counterparty is one of the household's own
    // accounts. One merchant per account, created on first use.
    const acct = await db
      .prepare('SELECT id FROM accounts WHERE id = ?')
      .bind(body.transfer_account_id)
      .first<{ id: string }>()
    if (!acct) return error('Unknown transfer account', 404)
    const existing = await db
      .prepare('SELECT id FROM merchants WHERE transfer_account_id = ?')
      .bind(acct.id)
      .first<{ id: number }>()
    if (existing) merchantId = existing.id
    else {
      const res = await db
        .prepare('INSERT INTO merchants (household_name, concept, transfer_account_id, created_at) VALUES (NULL, NULL, ?, ?)')
        .bind(acct.id, new Date().toISOString())
        .run()
      merchantId = res.meta.last_row_id as number
    }
  } else if (!merchantId && body.keep_description) {
    // The reserved keep-as-is merchant: all identity fields null, so display
    // falls through to the raw description while the key counts as reviewed.
    const existing = await db
      .prepare('SELECT id FROM merchants WHERE household_name IS NULL AND concept IS NULL AND transfer_account_id IS NULL')
      .first<{ id: number }>()
    if (existing) merchantId = existing.id
    else {
      const res = await db
        .prepare('INSERT INTO merchants (household_name, concept, created_at) VALUES (NULL, NULL, ?)')
        .bind(new Date().toISOString())
        .run()
      merchantId = res.meta.last_row_id as number
    }
  } else if (!merchantId) {
    const nm = body.new_merchant
    const name = nm?.household_name?.trim() || null
    const concept = nm?.concept?.trim() || null
    if (!name && !concept) return error('merchant_id or new_merchant (household_name/concept) required')
    const res = await db
      .prepare('INSERT INTO merchants (household_name, concept, created_at) VALUES (?, ?, ?)')
      .bind(name, concept, new Date().toISOString())
      .run()
    merchantId = res.meta.last_row_id as number
  } else {
    const exists = await db.prepare('SELECT id FROM merchants WHERE id = ?').bind(merchantId).first()
    if (!exists) return error('Unknown merchant', 404)
  }

  const picked = await db
    .prepare(
      `SELECT CASE WHEN transfer_account_id IS NOT NULL THEN 'Transfer'
                   ELSE COALESCE(household_name, concept) END AS label
       FROM merchants WHERE id = ?`
    )
    .bind(merchantId)
    .first<{ label: string | null }>()
  const scope = body.transaction_id && !body.apply_all ? 'row' : 'all'
  if (before && picked?.label) await logCorrection(db, before, 'merchant', picked.label, scope)
  const reason = body.reason?.trim()
  if (reason) await addRule(db, reason, body.transaction_id ?? null)

  // Row-level override: this one transaction only, the key alias untouched.
  if (body.transaction_id && !body.apply_all) return assignOverride(db, body.transaction_id, merchantId)
  if (!key) return error('merchant_key required')

  await db
    .prepare(
      `INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(normalized_raw) DO UPDATE SET merchant_id = excluded.merchant_id, confirmed = 1`
    )
    .bind(key, merchantId, new Date().toISOString())
    .run()

  // A key-wide apply made FROM a row that carried its own override: that
  // stale override would shadow the new alias on the very row the user is
  // looking at. Clear it - but only this row's; overrides on other rows are
  // deliberate exceptions and keep winning.
  if (body.transaction_id)
    await db
      .prepare('UPDATE transactions SET merchant_override_id = NULL WHERE id = ?')
      .bind(body.transaction_id)
      .run()

  const affected = await db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE merchant_key = ?')
    .bind(key)
    .first<{ n: number }>()

  return json({ ok: true, merchant_id: merchantId, transactions_covered: affected?.n ?? 0 })
}

async function assignOverride(db: D1Database, transactionId: number, merchantId: number): Promise<Response> {
  const res = await db
    .prepare('UPDATE transactions SET merchant_override_id = ? WHERE id = ?')
    .bind(merchantId, transactionId)
    .run()
  if ((res.meta.changes ?? 0) === 0) return error('Unknown transaction', 404)
  return json({ ok: true, merchant_id: merchantId, transactions_covered: 1, override: true })
}
