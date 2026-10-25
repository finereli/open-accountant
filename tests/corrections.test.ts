// The learning loop's write side: overriding an automatic pick logs a
// correction; a person revising their own decision does not; a "why"
// becomes a rule.

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { onRequestPost as setRowCategory } from '../functions/api/transactions/category'
import { onRequestPost as assign } from '../functions/api/merchants/assign'
import { onRequestPost as setMerchantCategory } from '../functions/api/merchants/category'
import { loadContext } from '../functions/api/_classify'

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('wise-eur','alex','wise','wallet','EUR','Wise EUR',0,1);
    INSERT INTO categories (id, name, kind, sort) VALUES (1,'Food','expense',10), (2,'Shopping','expense',20);
    INSERT INTO merchants (id, household_name, created_at, category_id, category_auto) VALUES
      (10,'Mercado','2026-01-01',NULL,0), (11,'Lidl','2026-01-01',1,0);
    INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES ('lidl',11,1,'x');
    INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key, auto_merchant_id, auto_category_id, auto_at) VALUES
      (1,'wise-eur','2026-08-10','Mercado Central Lisbon',-500,'t','h1','mercado central',10,2,'x'),
      (2,'wise-eur','2026-08-11','Lidl',-700,'t','h2','lidl',NULL,NULL,'x');
  `)
})

const call = (fn: PagesFunction<any>, body: unknown) =>
  fn({ env: { DB: db }, request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) } as any)
const corrections = async () => (await db.prepare('SELECT * FROM corrections ORDER BY id').all()).results as any[]
const rules = async () => (await db.prepare('SELECT text FROM rules').all()).results as any[]
const resolved = async (id: number) => (await db.prepare('SELECT * FROM tx_resolved WHERE id = ?').bind(id).first()) as any

describe('corrections', () => {
  it("logs a row category that overrides the auto pick, and keeps the why as a rule", async () => {
    const res = await call(setRowCategory, { transaction_id: 1, category_id: 1, reason: 'Mercado is a supermarket chain' })
    expect(res.status).toBe(200)
    expect(await resolved(1)).toMatchObject({ res_category_id: 1, category_source: 'human' })
    expect(await corrections()).toMatchObject([
      { transaction_id: 1, field: 'category', auto_value: 'Shopping', human_value: 'Food', scope: 'row' },
    ])
    expect(await rules()).toEqual([{ text: 'Mercado is a supermarket chain' }])
  })

  it('does not log a person revising their own decision', async () => {
    await call(setRowCategory, { transaction_id: 2, category_id: 2 })
    expect(await corrections()).toEqual([])
    expect(await resolved(2)).toMatchObject({ res_category_id: 2, category_source: 'human' })
  })

  it('clearing a row category hands it back to the automatic pick', async () => {
    await call(setRowCategory, { transaction_id: 1, category_id: 1 })
    await call(setRowCategory, { transaction_id: 1, category_id: null })
    expect(await resolved(1)).toMatchObject({ res_category_id: 2, category_source: 'auto' })
  })

  it('logs a merchant rename made from an auto-named row', async () => {
    await call(assign, { merchant_key: 'mercado central', transaction_id: 1, new_merchant: { household_name: 'Central Market' }, apply_all: true })
    expect(await corrections()).toMatchObject([{ field: 'merchant', auto_value: 'Mercado', human_value: 'Central Market', scope: 'all' }])
    expect(await resolved(1)).toMatchObject({ merchant_name: 'Central Market', merchant_source: 'human' })
  })

  it('logs a merchant-wide category set from an auto-categorized row', async () => {
    await call(setMerchantCategory, { merchant_id: 10, category_id: 1, transaction_id: 1 })
    expect(await corrections()).toMatchObject([{ field: 'category', auto_value: 'Shopping', human_value: 'Food', scope: 'all' }])
    expect(await resolved(1)).toMatchObject({ res_category_id: 1, category_source: 'human' })
  })

  it('ties a why to its transaction, and the model reads both', async () => {
    await call(setRowCategory, { transaction_id: 1, category_id: 1, reason: 'Always food at this amount' })
    expect(await db.prepare('SELECT transaction_id FROM rules').first()).toEqual({ transaction_id: 1 })
    const ctx = await loadContext(db as any)
    expect(ctx.rules).toEqual([
      'Always food at this amount [written about "Mercado Central Lisbon" -5.00 EUR on 2026-08-10 in Wise EUR, filed as merchant Mercado, category Food]',
    ])
  })
})
