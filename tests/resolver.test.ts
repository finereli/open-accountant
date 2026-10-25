// The tx_resolved view: who wins when a person and the auto-categorizer
// disagree. People always win; among automatic sources the per-row pick
// beats the older merchant-level guesses.

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('wise-eur','alex','wise','wallet','EUR','Wise EUR',0,1);
    INSERT INTO categories (id, name, kind, sort) VALUES
      (1,'Food','expense',10), (2,'Transport','expense',20), (3,'Shopping','expense',30), (4,'Travel','expense',40);
    INSERT INTO merchants (id, household_name, created_at, category_id, category_auto) VALUES
      (10,'Lidl','2026-01-01',1,0),          -- a person filed Lidl under Food
      (11,'Gas Station','2026-01-01',2,0),
      (12,'Kiosk','2026-01-01',3,1),          -- merchant category guessed by the old pass
      (13,'Proposed','2026-01-01',NULL,0),
      (14,'Auto Shop','2026-01-01',NULL,0);
    INSERT INTO merchants (id, household_name, transfer_account_id, created_at) VALUES (15,NULL,'wise-eur','2026-01-01');
    INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
      ('lidl',10,1,'x'), ('kiosk',12,1,'x'), ('maybe',13,0,'x'), ('topup',15,1,'x');
  `)
})

const add = (id: number, key: string | null, extra = '') =>
  db.exec(`INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key${
    extra ? ', ' + extra.split('=')[0] : ''
  }) VALUES (${id}, 'wise-eur', '2026-08-10', 'd', -500, 't', 'h${id}', ${key ? `'${key}'` : 'NULL'}${
    extra ? ', ' + extra.split('=')[1] : ''
  })`)
const set = (sql: string) => db.exec(sql)
const row = async (id: number) =>
  (await db.prepare('SELECT * FROM tx_resolved WHERE id = ?').bind(id).first()) as Record<string, unknown>

describe('tx_resolved', () => {
  it('uses the human merchant and its category', async () => {
    add(1, 'lidl')
    expect(await row(1)).toMatchObject({ res_merchant_id: 10, merchant_source: 'human', res_category_id: 1, category_source: 'human' })
  })

  it('auto merchant beats an unconfirmed proposal but not a confirmed alias', async () => {
    add(1, 'maybe')
    add(2, 'lidl')
    set('UPDATE transactions SET auto_merchant_id = 14')
    expect(await row(1)).toMatchObject({ res_merchant_id: 14, merchant_source: 'auto' })
    expect(await row(2)).toMatchObject({ res_merchant_id: 10, merchant_source: 'human' })
  })

  it('falls back to the unconfirmed proposal when nothing else decided', async () => {
    add(1, 'maybe')
    expect(await row(1)).toMatchObject({ res_merchant_id: 13, merchant_source: 'proposed', res_category_id: null })
  })

  it("keeps the merchant's human category over the row's auto pick", async () => {
    add(1, 'lidl')
    set('UPDATE transactions SET auto_category_id = 3')
    expect(await row(1)).toMatchObject({ res_category_id: 1, category_source: 'human' })
  })

  it("lets the row's auto pick beat the merchant's auto category", async () => {
    add(1, 'kiosk')
    set('UPDATE transactions SET auto_category_id = 1')
    expect(await row(1)).toMatchObject({ res_category_id: 1, category_source: 'auto' })
  })

  it("uses the merchant's auto category when the row has no pick", async () => {
    add(1, 'kiosk')
    expect(await row(1)).toMatchObject({ res_category_id: 3, category_source: 'auto' })
  })

  it("puts a person's row category above everything", async () => {
    add(1, 'lidl')
    set('UPDATE transactions SET auto_category_id = 3, category_id = 4, category_confirmed = 1')
    expect(await row(1)).toMatchObject({ res_category_id: 4, category_source: 'human' })
  })

  it('gives auto merchants with no category the auto category', async () => {
    add(1, null)
    set('UPDATE transactions SET auto_merchant_id = 14, auto_category_id = 3')
    expect(await row(1)).toMatchObject({ res_merchant_id: 14, res_category_id: 3, category_source: 'auto' })
  })

  it("a merchant's human category applies even when the classifier picked the merchant", async () => {
    add(1, null)
    set('UPDATE transactions SET auto_merchant_id = 11, auto_category_id = 4') // Gas Station is Transport by a person
    expect(await row(1)).toMatchObject({ res_merchant_id: 11, res_category_id: 2, category_source: 'human' })
  })

  it('gives transfers no category, whatever else is set', async () => {
    add(1, 'topup')
    set('UPDATE transactions SET auto_category_id = 3, category_id = 4, category_confirmed = 1')
    expect(await row(1)).toMatchObject({ transfer_account_id: 'wise-eur', res_category_id: null, category_source: null })
  })

  it('a row override beats the alias, and its merchant category applies', async () => {
    add(1, 'lidl', 'merchant_override_id=11')
    expect(await row(1)).toMatchObject({ res_merchant_id: 11, merchant_source: 'human', res_category_id: 2 })
  })
})
