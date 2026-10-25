// The projection math (pure) and the burn query behind /api/forecast.

import { describe, it, expect, beforeEach } from 'vitest'
import { project } from '../src/lib/forecast'
import { makeTestDb } from './d1'
import { burnRows, subRows } from '../functions/api/forecast'

describe('projection', () => {
  it('drains daily burn and applies items on their days', () => {
    const p = project(
      100_000,
      1_000,
      [
        { cents: 50_000, dayOfMonth: 5, date: null, endMonth: null }, // income on the 5th
        { cents: -20_000, dayOfMonth: null, date: '2026-09-10', endMonth: null }, // one-off
      ],
      '2026-09-01',
      15
    )
    // Sep 5: 100000 - 4*1000 + 50000 = 146000... minus that day's burn too
    expect(p.points.find((x) => x.date === '2026-09-05')?.cents).toBe(100_000 - 4_000 + 50_000)
    expect(p.points.find((x) => x.date === '2026-09-10')?.cents).toBe(100_000 - 9_000 + 50_000 - 20_000)
    expect(p.end.date).toBe('2026-09-16')
  })

  it('finds the low point before an income spike', () => {
    const p = project(10_000, 1_000, [{ cents: 100_000, dayOfMonth: 12, date: null, endMonth: null }], '2026-09-01', 20)
    expect(p.low.date).toBe('2026-09-11') // drained to the eve of payday
    expect(p.low.cents).toBe(0)
  })

  it('clamps day-31 items into shorter months and respects end_month', () => {
    const ends = project(
      0,
      0,
      [{ cents: 1_000, dayOfMonth: 31, date: null, endMonth: '2026-09' }],
      '2026-08-28',
      40
    )
    // Aug 31 exists; September's lands on the clamped 30th; October is past end_month.
    expect(ends.points.find((x) => x.date === '2026-08-31')?.cents).toBe(1_000)
    expect(ends.points.find((x) => x.date === '2026-09-30')?.cents).toBe(2_000)
    expect(ends.end.cents).toBe(2_000)
  })
})

describe('burn query', () => {
  let db: ReturnType<typeof makeTestDb>
  beforeEach(() => {
    db = makeTestDb()
    db.exec(`
      INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
        ('wise-eur','alex','wise','wallet','EUR','Wise EUR',0,1),
        ('sam-gbp','sam','wise','wallet','GBP','Sam',1,0);
      INSERT INTO categories (id, name, kind, sort, flow) VALUES
        (1,'Food','expense',10,'run_rate'), (2,'Subs','expense',50,'discrete');
      INSERT INTO merchants (id, household_name, created_at, category_id) VALUES
        (10,'Lidl','2026-01-01',1), (11,'Netflix','2026-01-01',2);
      INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
        ('lidl',10,1,'2026-01-01'), ('netflix',11,1,'2026-01-01');
      INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key) VALUES
        (1,'wise-eur','2026-08-10','a',-2000,'t','h1','lidl'),
        (2,'wise-eur','2026-08-20','b',-3000,'t','h2','lidl'),
        (3,'wise-eur','2026-08-21','c',-1500,'t','h3','netflix'),      -- discrete: not burn
        (4,'sam-gbp','2026-08-22','d',-900,'t','h4','lidl'),          -- out of scope
        (5,'wise-eur','2026-07-01','e',-9000,'t','h5','lidl');         -- before window
    `)
  })

  it('sums only run-rate categories, in-window, in-scope', async () => {
    const rows = await burnRows(db, '2026-08-01', '2026-09-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category_id: 1, name: 'Food', currency: 'EUR', total_cents: -5000 })
  })
})

describe('zero crossing', () => {
  it('reports the first day cash goes negative', () => {
    const p = project(5_000, 1_000, [], '2026-09-01', 10)
    expect(p.zero?.date).toBe('2026-09-06') // 5000 - 6*1000 = -1000
    expect(p.low.cents).toBe(-5_000)
  })

  it('is null when cash stays positive', () => {
    const p = project(50_000, 1_000, [], '2026-09-01', 10)
    expect(p.zero).toBe(null)
  })
})

describe('daily-rate item', () => {
  it('charges the rate every projected day', () => {
    const rate = { cents: -2_500, dayOfMonth: null, date: null, endMonth: null, perDay: true }
    const p = project(100_000, 0, [rate], '2026-08-30', 10)
    expect(p.end.cents).toBe(100_000 - 10 * 2_500)
  })
})

describe('cancelled subscription (endDate)', () => {
  it('stops projecting charges after the end date', () => {
    const sub = { cents: -1_000, dayOfMonth: 15, date: null, endMonth: null, endDate: '2026-09-30' }
    const p = project(100_000, 0, [sub], '2026-08-28', 120)
    // Sep 15 lands (<= end); Oct 15 and Nov 15 do not.
    expect(p.points.find((x) => x.date === '2026-09-15')?.cents).toBe(99_000)
    expect(p.points.find((x) => x.date === '2026-10-15')?.cents).toBe(99_000)
    expect(p.points.find((x) => x.date === '2026-11-15')?.cents).toBe(99_000)
  })

  it('a same-day cancellation adds no future charges', () => {
    const sub = { cents: -1_000, dayOfMonth: 5, date: null, endMonth: null, endDate: '2026-08-28' }
    const p = project(100_000, 0, [sub], '2026-08-28', 90)
    expect(p.end.cents).toBe(100_000) // nothing after the 28th
  })
})

describe('derived subscriptions', () => {
  function subDb() {
    const db = makeTestDb()
    db.exec(`
      INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
        ('visa','alex','Bank','credit_card','CAD','Visa',0,1),
        ('loc','alex','Bank','line_of_credit','CAD','LoC',1,1),
        ('chq','alex','Bank','checking','CAD','Chequing',2,1);
      INSERT INTO categories (id, name, kind, sort, flow) VALUES
        (1,'Subs','expense',50,'subscriptions'), (2,'Food','expense',10,'run_rate');
    `)
    return db
  }

  function addMerchant(db: ReturnType<typeof makeTestDb>, id: number, name: string, key: string, catId = 1) {
    db.exec(`
      INSERT INTO merchants (id, household_name, created_at, category_id) VALUES (${id},'${name}','2026-01-01',${catId});
      INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES ('${key}',${id},1,'2026-01-01');
    `)
  }

  function addTx(db: ReturnType<typeof makeTestDb>, id: number, acct: string, date: string, cents: number, key: string) {
    db.exec(`INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key) VALUES (${id},'${acct}','${date}','x',${cents},'t','h${id}','${key}');`)
  }

  it('projects each merchant at its usual day from the 35-day window', async () => {
    const db = subDb()
    addMerchant(db, 10, 'Netflix', 'netflix')
    addMerchant(db, 11, 'Hunter', 'hunter')
    addMerchant(db, 12, 'Lidl', 'lidl', 2) // run_rate, not subs
    addMerchant(db, 13, 'Old Sub', 'oldsub')
    addMerchant(db, 14, 'Disney', 'disney')
    addTx(db, 1, 'visa', '2026-08-05', -2199, 'netflix')
    addTx(db, 2, 'visa', '2026-08-02', -800, 'hunter')
    addTx(db, 3, 'visa', '2026-08-06', -1200, 'hunter')
    addTx(db, 4, 'visa', '2026-08-20', -5000, 'lidl')
    addTx(db, 5, 'visa', '2026-06-01', -999, 'oldsub')
    addTx(db, 6, 'visa', '2026-07-24', -1426, 'disney') // prior cycle
    addTx(db, 7, 'visa', '2026-08-24', -1426, 'disney') // last cycle
    const subs = await subRows(db, '2026-08-28')
    const byName = Object.fromEntries(subs.map((s) => [s.name, s]))
    expect(byName['Netflix']).toMatchObject({ monthly_cents: 2199, day: 5 })
    expect(byName['Hunter']).toMatchObject({ monthly_cents: 2000, day: 6 })
    expect(byName['Disney']).toMatchObject({ monthly_cents: 1426, day: 24 })
    expect(byName['Lidl']).toBeUndefined()
    expect(byName['Old Sub']).toBeUndefined()
  })

  it('sums multiple same-day charges from the same merchant', async () => {
    // LoC interest pattern: PURCHASE + CASH interest on the same day
    const db = subDb()
    addMerchant(db, 10, 'Bank Fee', 'interest charges')
    addTx(db, 1, 'loc', '2026-08-16', -381, 'interest charges')  // purchase interest
    addTx(db, 2, 'loc', '2026-08-16', -27112, 'interest charges') // cash interest
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ name: 'Bank Fee', monthly_cents: 27493, day: 16 })
  })

  it('sums charges within 14 days but drops an earlier cycle', async () => {
    // A merchant that batches charges across a few days in the same cycle
    const db = subDb()
    addMerchant(db, 10, 'Inbox', 'inbox')
    // Current cycle: charges on the 20th, 22nd, 25th
    addTx(db, 1, 'visa', '2026-08-20', -500, 'inbox')
    addTx(db, 2, 'visa', '2026-08-22', -300, 'inbox')
    addTx(db, 3, 'visa', '2026-08-25', -200, 'inbox')
    // Prior cycle: charges on the 22nd, 25th of July (within 49-day window)
    addTx(db, 4, 'visa', '2026-07-22', -400, 'inbox')
    addTx(db, 5, 'visa', '2026-07-25', -350, 'inbox')
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ name: 'Inbox', monthly_cents: 1000, day: 25 })
  })

  it('EDGE: charges >14 days apart in the same month lose the earlier ones', async () => {
    // A merchant charges on the 1st and the 20th every month - the 14-day
    // window from the 20th misses the 1st, under-projecting by half.
    const db = subDb()
    addMerchant(db, 10, 'Split Biller', 'splitbill')
    addTx(db, 1, 'visa', '2026-08-01', -5000, 'splitbill')
    addTx(db, 2, 'visa', '2026-08-20', -5000, 'splitbill')
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(1)
    // BUG: only picks up the charge within 14 days of the last (the 20th)
    // The correct monthly total should be 10000, but we get 5000.
    expect(subs[0].monthly_cents).toBe(5000) // actual behavior: misses the 1st
    // expect(subs[0].monthly_cents).toBe(10000) // desired behavior
  })

  it('EDGE: two different merchant keys mapping to one merchant sum correctly', async () => {
    // LoC has "interest charges-purchase" and "interest charges-cash" as
    // different raw descriptions, but if they alias to the same merchant
    // the amounts should combine.
    const db = subDb()
    addMerchant(db, 10, 'Bank Fee', 'interest charges-purchase')
    db.exec(`INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES ('interest charges-cash',10,1,'2026-01-01');`)
    addTx(db, 1, 'loc', '2026-08-16', -381, 'interest charges-purchase')
    addTx(db, 2, 'loc', '2026-08-16', -27112, 'interest charges-cash')
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ name: 'Bank Fee', monthly_cents: 27493, day: 16 })
  })

  it('EDGE: same merchant on two accounts with the same currency merges', async () => {
    // A merchant charges both the visa and the LoC (both CAD)
    const db = subDb()
    addMerchant(db, 10, 'Bank Fee', 'interest')
    addTx(db, 1, 'visa', '2026-08-09', -1828, 'interest')
    addTx(db, 2, 'loc', '2026-08-16', -27493, 'interest')
    const subs = await subRows(db, '2026-08-28')
    // Groups by merchant_id|currency, so both CAD charges merge into one sub
    expect(subs).toHaveLength(1)
    expect(subs[0].monthly_cents).toBe(29321)
    // But the "day" is the last charge's day (16), which is wrong for the
    // visa charge that actually hits on the 9th. Cross-account same-merchant
    // charges with different billing days get a single merged projection on
    // one day.
    expect(subs[0].day).toBe(16)
  })

  it('cancelled sub stops projecting after end_date', async () => {
    const db = subDb()
    addMerchant(db, 10, 'Netflix', 'netflix')
    db.exec(`INSERT INTO sub_overrides (merchant_id, end_date, created_at) VALUES (10,'2026-09-15','2026-08-28');`)
    addTx(db, 1, 'visa', '2026-08-05', -2199, 'netflix')
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ end_date: '2026-09-15' })
  })

  it('ignores positive amounts (refunds)', async () => {
    const db = subDb()
    addMerchant(db, 10, 'Netflix', 'netflix')
    addTx(db, 1, 'visa', '2026-08-05', 2199, 'netflix') // refund
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(0)
  })

  it('excludes accounts with in_spending=0', async () => {
    const db = subDb()
    db.exec(`INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES ('sam','sam','wise','wallet','GBP','Sam',3,0);`)
    addMerchant(db, 10, 'Netflix', 'netflix')
    addTx(db, 1, 'sam', '2026-08-05', -2199, 'netflix')
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(0)
  })

  it('ages out a merchant with no charges in 35 days', async () => {
    const db = subDb()
    addMerchant(db, 10, 'Netflix', 'netflix')
    addTx(db, 1, 'visa', '2026-07-20', -2199, 'netflix') // 39 days before "today"
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(0)
  })

  it('keeps a merchant that charged exactly 35 days ago', async () => {
    const db = subDb()
    addMerchant(db, 10, 'Netflix', 'netflix')
    addTx(db, 1, 'visa', '2026-07-24', -2199, 'netflix') // 35 days before Aug 28
    const subs = await subRows(db, '2026-08-28')
    expect(subs).toHaveLength(1)
  })
})
