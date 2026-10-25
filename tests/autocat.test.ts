// Automatic transfer pairing (and the parsing guard on model category
// picks). Replays the Oct 7 2026 case: 1,406.02 USD sent from Wise Biz
// arrived in a chequing account as a $2,000.00 CAD Interac deposit, which the
// catch-all e-transfer alias had filed under Canada as an "expense".

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { findTransfers, applyTransfers } from '../functions/api/_autocat'

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('chq','alex','Bank','checking','CAD','Chequing',0,1),
      ('biz','alex','wise','wallet','USD','Wise Biz USD',1,0);
    INSERT INTO fx_rates (date, from_currency, to_currency, rate) VALUES
      ('2026-10-01','USD','USD',1.0), ('2026-10-01','CAD','USD',0.7052);
    INSERT INTO categories (id, name, kind, sort, flow) VALUES
      (9,'Canada','expense',10,'discrete'), (12,'Transfers','excluded',90,'off'), (2,'Food','expense',5,'run_rate');
    INSERT INTO merchants (id, household_name, created_at, category_id) VALUES
      (151,'Interac E-Transfer','2026-01-01',9), (101,'Alex Smith','2026-01-01',12), (50,'Jordan Lee','2026-01-01',2);
    INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
      ('free interac e-transfer',151,1,'2026-01-01'), ('sent money to alex smith',101,1,'2026-01-01');
  `)
})

const tx = (id: number, acct: string, date: string, cents: number, desc: string, key: string, override = 'NULL') =>
  db.exec(`INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key, merchant_override_id)
           VALUES (${id}, '${acct}', '${date}', '${desc}', ${cents}, 't', 'h${id}', '${key}', ${override})`)

describe('findTransfers', () => {
  it('pairs a cross-currency e-transfer with the Wise send that funded it', async () => {
    tx(1, 'biz', '2026-10-07', -140602, 'Sent money to Alex Smith (fee: 5.33 USD)', 'sent money to alex smith')
    tx(2, 'chq', '2026-10-07', 200000, 'Deposit Free Interac E-transfer', 'free interac e-transfer')
    const pairs = await findTransfers(db, '2026-09-01')
    expect(pairs).toEqual([{ from_id: 1, to_id: 2, from_account: 'biz', to_account: 'chq' }])

    await applyTransfers(db, pairs)
    const rows = (
      await db
        .prepare(
          `SELECT t.id, m.transfer_account_id AS to_acct FROM transactions t
           JOIN merchants m ON m.id = t.merchant_override_id ORDER BY t.id`
        )
        .all()
    ).results
    // Each leg now names the other account.
    expect(rows).toEqual([
      { id: 1, to_acct: 'chq' },
      { id: 2, to_acct: 'biz' },
    ])
  })

  it('leaves an e-transfer alone when no other account has the matching leg', async () => {
    tx(1, 'chq', '2026-09-28', 28005, 'Deposit Free Interac E-transfer', 'free interac e-transfer')
    tx(2, 'biz', '2026-09-27', -50000, 'Sent money to Alex Smith', 'sent money to alex smith') // wrong amount
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })

  it('never touches a row a human assigned', async () => {
    tx(1, 'biz', '2026-10-07', -140602, 'Sent money to Alex Smith', 'sent money to alex smith')
    tx(2, 'chq', '2026-10-07', 200000, 'Deposit Free Interac E-transfer', 'free interac e-transfer', '50') // Jordan
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })

  it('skips when two other legs fit equally well', async () => {
    tx(1, 'chq', '2026-10-07', 200000, 'Deposit Free Interac E-transfer', 'free interac e-transfer')
    tx(2, 'biz', '2026-10-06', -140602, 'Sent money to Alex Smith', 'sent money to alex smith')
    tx(3, 'biz', '2026-10-08', -140602, 'Sent money to Alex Smith', 'sent money to alex smith')
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })

  it('does not pair with an ordinary purchase that happens to match', async () => {
    tx(1, 'chq', '2026-10-07', 200000, 'Deposit Free Interac E-transfer', 'free interac e-transfer')
    tx(2, 'biz', '2026-10-07', -140602, 'Card transaction of 1,406.02 USD issued by Apple', 'apple')
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })
})

describe('findTransfers respects existing decisions', () => {
  it('leaves a row on a merchant a person named and categorized', async () => {
    db.exec(`INSERT INTO merchants (id, household_name, created_at, category_id) VALUES (60,'Sam Smith','2026-01-01',2);
             INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES ('received money from sam smith',60,1,'2026-01-01');`)
    tx(1, 'biz', '2026-09-05', 14000, 'Received money from Sam Smith with reference', 'received money from sam smith')
    tx(2, 'chq', '2026-09-06', -19852, 'Miscellaneous Payment Wise Canada', 'miscellaneous payment wise canada')
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })

  it('does not claim a leg that is already a transfer to a different account', async () => {
    db.exec(`INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
               ('gbp','alex','wise','wallet','USD','Wise GBP',2,1);
             INSERT INTO merchants (id, transfer_account_id, created_at) VALUES (70,'gbp','2026-01-01');
             INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES ('miscellaneous payment wise canada',70,1,'2026-01-01');`)
    tx(1, 'chq', '2026-09-08', -19852, 'Miscellaneous Payment Wise Canada', 'miscellaneous payment wise canada')
    tx(2, 'biz', '2026-09-05', 14000, 'Sent money to Alex Smith', 'nothing-aliased')
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })
})

describe('findTransfers by Wise reference', () => {
  beforeEach(() => {
    db.exec(`
      INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
        ('eur','alex','wise','wallet','EUR','Wise EUR',2,1),
        ('y-eur','sam','wise','wallet','EUR','Sam EUR',3,1);
      INSERT INTO merchants (id, household_name, created_at, category_id) VALUES (60,'Sam Smith','2026-01-01',2);
      INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
        ('received money from alex smith',101,1,'2026-01-01'), ('sent money to sam smith',60,1,'2026-01-01');
    `)
  })
  const wise = (id: number, acct: string, date: string, cents: number, desc: string, key: string, ref: string) =>
    db.exec(`INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key, meta)
             VALUES (${id}, '${acct}', '${date}', '${desc}', ${cents}, 't', 'h${id}', '${key}', '{"referenceNumber":"${ref}"}')`)

  it('pairs the two legs that share a reference, across currencies, even on a filed merchant', async () => {
    wise(1, 'biz', '2026-10-02', -99711, 'Sent money to Alex Smith (fee: 2.89 USD)', 'sent money to alex smith', 'TRANSFER-1000000001')
    wise(2, 'eur', '2026-10-02', 88711, 'Received money from Alex Smith with reference ', 'received money from alex smith', 'TRANSFER-1000000001')
    // A fee row with its own reference stays out of it.
    wise(3, 'biz', '2026-10-02', -289, 'Wise Charges for: TRANSFER-1000000001', 'wise charges for', 'BALANCE-1')
    expect(await findTransfers(db, '2026-09-01')).toEqual([{ from_id: 1, to_id: 2, from_account: 'biz', to_account: 'eur' }])
  })

  it("does not turn money sent to Sam (filed as Food) into a transfer", async () => {
    wise(1, 'eur', '2026-10-02', -5000, 'Sent money to Sam Smith', 'sent money to sam smith', 'TRANSFER-1')
    wise(2, 'y-eur', '2026-10-02', 5000, 'Received money from Alex Smith with reference ', 'received money from alex smith', 'TRANSFER-1')
    expect(await findTransfers(db, '2026-09-01')).toEqual([])
  })

  it('links the other half when one leg is already a transfer to it', async () => {
    db.exec(`INSERT INTO merchants (id, household_name, created_at, transfer_account_id) VALUES (113, NULL, '2026-01-01', 'biz')`)
    tx(1, 'biz', '2026-10-07', -140602, 'Sent money to Alex Smith (fee: 5.33 USD)', 'sent money to alex smith')
    tx(2, 'chq', '2026-10-07', 200000, 'Deposit Free Interac E-transfer', 'free interac e-transfer', '113')
    const pairs = await findTransfers(db, '2026-09-01')
    expect(pairs).toEqual([{ from_id: 1, to_id: 2, from_account: 'biz', to_account: 'chq' }])
    expect(await applyTransfers(db, pairs)).toBe(1)
  })
})
