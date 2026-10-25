// GET /api/accounts - every account with its computed balance (anchor + sum
// of transactions since the anchor), latest checkpoint, the FX table for the
// dashboard's converted total, and the currencies in use.
// Accounts themselves are created with SQL at setup (see README); Wise
// sync adds its own wallets.

import type { Env } from './_lib'
import { json, homeCurrency, currenciesInUse } from './_lib'

export async function accountsData(db: D1Database, home = 'USD') {
  const [accounts, checkpoints, fxRows] = await Promise.all([
    db
      .prepare(
        `SELECT a.id, a.owner, a.institution, a.kind, a.currency, a.display_name, a.sort, a.in_spending,
                COALESCE(an.date, '0000-01-01') AS anchor_date,
                COALESCE(an.balance_cents, 0) AS anchor_cents,
                COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                          WHERE t.account_id = a.id AND t.date >= COALESCE(an.date, '0000-01-01')), 0) AS delta_cents,
                COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id), 0) AS tx_count,
                (SELECT MAX(t.date) FROM transactions t WHERE t.account_id = a.id) AS last_date
         FROM accounts a
         LEFT JOIN ledger_anchors an ON an.account_id = a.id
         ORDER BY a.sort`
      )
      .all(),
    db
      .prepare(
        `SELECT c.account_id, c.date, c.balance_cents, c.verified_at,
                COALESCE((SELECT a.balance_cents FROM ledger_anchors a WHERE a.account_id = c.account_id), 0) +
                COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                          WHERE t.account_id = c.account_id
                            AND t.date >= COALESCE((SELECT a2.date FROM ledger_anchors a2 WHERE a2.account_id = c.account_id), '0000-01-01')
                            AND t.date <= c.date), 0) AS computed_now
         FROM reconciliation_checkpoints c
         WHERE c.id IN (SELECT id FROM reconciliation_checkpoints c2
                        WHERE c2.account_id = c.account_id
                        ORDER BY c2.date DESC, c2.id DESC LIMIT 1)`
      )
      .all(),
    db
      .prepare(
        `SELECT from_currency, rate, date FROM fx_rates
         WHERE to_currency = 'USD' AND date = (SELECT MAX(date) FROM fx_rates WHERE to_currency = 'USD')`
      )
      .all(),
  ])

  const ckptByAccount = new Map<string, Record<string, unknown>>()
  for (const c of checkpoints.results as Array<Record<string, unknown>>) {
    ckptByAccount.set(c.account_id as string, {
      date: c.date,
      balance_cents: c.balance_cents,
      verified_at: c.verified_at,
      // Live: attested balance minus what the ledger sums to at that date.
      // Zero = verified (frozen); anything else = open mismatch to chase.
      discrepancy_cents: (c.balance_cents as number) - (c.computed_now as number),
    })
  }

  const fx: Record<string, number> = { USD: 1 } // rates are to USD, so USD is always 1
  let fxDate: string | null = null
  for (const r of fxRows.results as Array<{ from_currency: string; rate: number; date: string }>) {
    fx[r.from_currency] = r.rate
    fxDate = r.date
  }

  const out = (accounts.results as Array<Record<string, unknown>>).map((a) => ({
    ...a,
    balance_cents: (a.anchor_cents as number) + (a.delta_cents as number),
    checkpoint: ckptByAccount.get(a.id as string) ?? null,
  }))

  return { accounts: out, fx, fx_date: fxDate, home_currency: home, currencies: await currenciesInUse(db, home) }
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => json(await accountsData(env.DB, homeCurrency(env)))
