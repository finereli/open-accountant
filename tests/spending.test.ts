// Category resolution in the spending query: category comes from the
// merchant (override beats alias), price gates split by amount, transfer
// merchants and non-spending accounts stay out, and everything unresolved
// lands in Uncategorized (category_id null).

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { spendingRows } from '../functions/api/spending'
import { spendingTxns } from '../functions/api/spending-txns'

let db: ReturnType<typeof makeTestDb>

const tx = (id: number, account: string, key: string | null, cents: number, override = 'NULL') => `
  INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key, merchant_override_id)
  VALUES (${id}, '${account}', '2026-08-10', 'tx ${id}', ${cents}, 'test', 'h${id}', ${key ? `'${key}'` : 'NULL'}, ${override});`

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('wise-eur','alex','wise','wallet','EUR','Wise EUR',0,1),
      ('sam-wise-gbp','sam','wise','wallet','GBP','Sam GBP',1,0);
    INSERT INTO categories (id, name, kind, sort) VALUES
      (1,'Food','expense',10), (2,'Coffee','expense',11), (3,'Shopping','expense',60);
    INSERT INTO merchants (id, household_name, created_at, category_id, small_category_id, small_max_cents) VALUES
      (10,'Lidl','2026-01-01',1,NULL,NULL),
      (11,'Minimarket','2026-01-01',1,2,500),
      (12,'Amazon','2026-01-01',3,NULL,NULL);
    INSERT INTO merchants (id, household_name, transfer_account_id, created_at) VALUES
      (13,NULL,'wise-eur','2026-01-01');
    INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
      ('lidl porto',10,1,'2026-01-01'),
      ('minimarket x',11,1,'2026-01-01'),
      ('topped up account',13,1,'2026-01-01');
  `)
})

const rows = () => spendingRows(db, '2026-08-01', '2026-09-01', null, null)

describe('spending resolution', () => {
  it('groups by the merchant category', async () => {
    db.exec(tx(1, 'wise-eur', 'lidl porto', -2000) + tx(2, 'wise-eur', 'lidl porto', -3000))
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ category_id: 1, label: 'Lidl', total_cents: -5000, count: 2 })
  })

  it('splits a gated merchant by amount', async () => {
    db.exec(tx(1, 'wise-eur', 'minimarket x', -300) + tx(2, 'wise-eur', 'minimarket x', -4200))
    const r = await rows()
    expect(r.find((x) => x.category_id === 2)?.total_cents).toBe(-300) // small -> Coffee
    expect(r.find((x) => x.category_id === 1)?.total_cents).toBe(-4200) // big -> Food
  })

  it('excludes transfer merchants and non-spending accounts', async () => {
    db.exec(
      tx(1, 'wise-eur', 'topped up account', 100000) + // transfer merchant
        tx(2, 'sam-wise-gbp', 'lidl porto', -900) + // in_spending = 0
        tx(3, 'wise-eur', 'lidl porto', -1000)
    )
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0].total_cents).toBe(-1000)
  })

  it('sends unresolved rows to Uncategorized with their key as label', async () => {
    db.exec(tx(1, 'wise-eur', 'mystery shop', -700))
    const r = await rows()
    expect(r[0]).toMatchObject({ category_id: null, merchant_id: null, label: 'mystery shop' })
  })

  it('lets a row override beat the key alias', async () => {
    db.exec(tx(1, 'wise-eur', 'lidl porto', -2500, '12')) // overridden to Amazon
    const r = await rows()
    expect(r[0]).toMatchObject({ category_id: 3, label: 'Amazon' })
  })
})

describe('debt flows', () => {
  beforeEach(() => {
    db.exec(`
      INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
        ('checking','alex','Bank','checking','CAD','Chequing',2,1),
        ('loc','alex','Bank','line_of_credit','CAD','Bank LoC',3,1);
      INSERT INTO categories (id, name, kind, sort) VALUES (90,'Debt Repay','excluded',890), (91,'Debt Borrow','excluded',891);
      INSERT INTO merchants (id, household_name, transfer_account_id, created_at) VALUES
        (20,NULL,'loc','2026-01-01'),        -- counterparty is the LoC
        (21,NULL,'checking','2026-01-01');   -- counterparty is checking
      INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
        ('debit memo',20,1,'2026-01-01'),
        ('payment from',21,1,'2026-01-01'),
        ('cash advance to',21,1,'2026-01-01');
    `)
  })
  const flows = () => spendingRows(db, '2026-08-01', '2026-09-01', 90, 91)

  it('shows the cash-side legs as Debt Repay / Debt Borrow', async () => {
    db.exec(
      tx(1, 'checking', 'debit memo', -10000) + // payment toward the LoC
        tx(2, 'loc', 'payment from', 10000) + // its debt-side twin: hidden
        tx(3, 'loc', 'cash advance to', -235600) + // debt-side of an advance: hidden
        tx(4, 'checking', 'debit memo', 235600) // cash arriving from the LoC
    )
    const r = await flows()
    expect(r).toHaveLength(2)
    expect(r.find((x) => x.category_id === 90)).toMatchObject({ total_cents: -10000, label: 'To Bank LoC' })
    expect(r.find((x) => x.category_id === 91)).toMatchObject({ total_cents: 235600, label: 'From Bank LoC' })
  })

  it('keeps cash-to-cash transfers hidden', async () => {
    db.exec(tx(1, 'checking', 'topped up account', -50000)) // to wise-eur (wallet)
    expect(await flows()).toHaveLength(0)
  })

  it('hides all transfer legs when the debt categories are absent', async () => {
    db.exec(tx(1, 'checking', 'debit memo', -10000))
    expect(await rows()).toHaveLength(0)
  })
})

describe('spending drill-down', () => {
  it('lists a merchant line transactions, override included', async () => {
    db.exec(
      tx(1, 'wise-eur', 'lidl porto', -2000) +
        tx(2, 'wise-eur', 'minimarket x', -900, '10') + // overridden onto Lidl
        tx(3, 'wise-eur', 'minimarket x', -300)
    )
    const lidl = await spendingTxns(db, '2026-08-01', '2026-09-01', 10, null)
    expect(lidl.map((t) => t.id).sort()).toEqual([1, 2])
  })

  it('lists unmerchanted rows by their key label', async () => {
    db.exec(tx(1, 'wise-eur', 'mystery shop', -700) + tx(2, 'wise-eur', 'lidl porto', -100))
    const r = await spendingTxns(db, '2026-08-01', '2026-09-01', null, 'mystery shop')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 1, account_name: 'Wise EUR', currency: 'EUR' })
  })
})
