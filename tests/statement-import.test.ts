// Screenshot import: strips merge back into one list, the running balance
// catches misreads, rows the ledger already has are recognized (including
// runs of identical daily charges), and new rows hash so Plaid/CSV dedup
// against them later.

import { describe, it, expect } from 'vitest'
import { mergeStrips, checkChain, breakGap, editableField, touchesBreak, type ReadRow } from '../src/lib/statement-import'
import { parseModelRows } from '../functions/api/import/_vision'
import { matchLedger } from '../functions/api/import/preview'
import { buildRows } from '../functions/api/import/commit'
import { makeTestDb } from './d1'

const r = (date: string | null, amount: number, balance: number | null, description = 'x'): ReadRow => ({
  date,
  description,
  amount_cents: Math.round(amount * 100),
  balance_cents: balance === null ? null : Math.round(balance * 100),
})

describe('mergeStrips', () => {
  it('drops the overlap and carries dates across strip boundaries', () => {
    const merged = mergeStrips([
      [r('2026-09-28', -42.09, 308.32), r('2026-09-28', -8.72, 350.41), r('2026-09-28', 280.05, 359.13)],
      // Next strip starts inside Sep 28 (header scrolled away) and repeats two rows.
      [r(null, -8.72, 350.41), r(null, 280.05, 359.13), r(null, -15.67, 79.08), r('2026-09-26', -8.38, 94.75)],
    ])
    expect(merged.map((m) => [m.date, m.amount_cents])).toEqual([
      ['2026-09-28', -4209],
      ['2026-09-28', -872],
      ['2026-09-28', 28005],
      ['2026-09-28', -1567],
      ['2026-09-26', -838],
    ])
  })

  it('keeps identical charges that are genuinely separate rows (different balances)', () => {
    const merged = mergeStrips([
      [r('2026-09-28', -8.38, 200.45), r('2026-09-28', -8.38, 208.83)],
      [r(null, -8.38, 208.83), r(null, -8.38, 217.21)],
    ])
    expect(merged.map((m) => m.balance_cents)).toEqual([20045, 20883, 21721])
  })
})

describe('checkChain', () => {
  it('passes a consistent list and pinpoints a misread amount', () => {
    const good = [r('d', -8.72, 350.41), r('d', 280.05, 359.13), r('d', -15.67, 79.08)]
    expect(checkChain(good)).toEqual(['ok', 'ok', 'oldest'])
    const misread = [r('d', -8.72, 350.41), r('d', 280.50, 359.13), r('d', -15.67, 79.08)]
    expect(checkChain(misread)).toEqual(['ok', 'break', 'oldest'])
  })

  it('reports none when the bank shows no balances', () => {
    expect(checkChain([r('d', -1, null), r('d', -2, null)])).toEqual(['none', 'none'])
  })
})

describe('parseModelRows', () => {
  it('reads fenced JSON, joins type and detail, and converts to cents', () => {
    const rows = parseModelRows('```json\n{"rows":[{"date":"2026-09-28","type":"POS Purchase","detail":"Opos 6.01 Cloudflare +1888","amount":-8.72,"balance":350.41},{"date":null,"type":"Deposit","detail":"Free Interac E-transfer","amount":280.05,"balance":null}]}\n```')
    expect(rows).toEqual([
      { date: '2026-09-28', description: 'POS Purchase Opos 6.01 Cloudflare +1888', amount_cents: -872, balance_cents: 35041 },
      { date: null, description: 'Deposit Free Interac E-transfer', amount_cents: 28005, balance_cents: null },
    ])
  })
})

function ledgerDb() {
  const db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort) VALUES
      ('chq','alex','Bank','checking','CAD','Chequing',0);
    INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash) VALUES
      (1,'chq','2026-09-15','Opos Freedom',-5040,'plaid','h1'),
      (2,'chq','2026-09-23','Westland',-166,'plaid','h2'),
      (3,'chq','2026-09-25','Plaid dates run ahead',-3240,'plaid','h3');
  `)
  return db
}

describe('matchLedger', () => {
  it('matches existing rows once each, exact dates first, Plaid dates up to 4 days ahead', async () => {
    const db = ledgerDb()
    const rows = [
      // newest first, as read
      { date: '2026-09-24', amount_cents: -166 }, // same amount a day after the ledger's -1.66: NEW
      { date: '2026-09-23', amount_cents: -166 }, // exact date: the ledger's row 2
      { date: '2026-09-22', amount_cents: -3240 }, // ledger has it dated Sep 25 (Plaid ahead): row 3
      { date: '2026-09-15', amount_cents: -5040 }, // the later of two identical Freedom charges: NEW
      { date: '2026-09-15', amount_cents: -5040 }, // the earlier one (lower on screen): row 1
    ]
    expect(await matchLedger(db, 'chq', rows)).toEqual([null, 2, 3, null, 1])
  })
})

describe('buildRows', () => {
  it('numbers a second same-day identical charge past the one already in the ledger', async () => {
    const db = ledgerDb()
    const { createHash } = await import('node:crypto')
    const h = (s: string) => createHash('sha256').update(s).digest('hex')
    db.exec(`UPDATE transactions SET semantic_hash = '${h('chq|2026-09-15|-5040')}' WHERE id = 1`)
    const rows = await buildRows(
      db,
      'chq',
      [{ date: '2026-09-15', description: 'POS Purchase Opos Freedom Mobile 877-9', amount_cents: -5040, balance_cents: 45296 }],
      'screenshot:test'
    )
    expect(rows[0].semantic_hash).toBe(h('chq|2026-09-15|-5040#2'))
    expect(rows[0]).toMatchObject({ balance_after_cents: 45296, external_id: null, source_file: 'screenshot:test' })
  })
})

describe('breaks: what to edit, what blocks', () => {
  // newest first: 359.13 <- +280.05 <- 79.08 <- -15.67 <- 94.75
  const ok = () => [r('d', 280.05, 359.13), r('d', -15.67, 79.08), r('d', -33.59, 94.75), r('d', -8.38, 128.34)]

  it('a missing row breaks one pair: offer the amount, report the gap', () => {
    const rows = ok()
    rows.splice(1, 1) // the -15.67 row lost in a stitched capture
    const chain = checkChain(rows)
    expect(chain).toEqual(['break', 'ok', 'oldest'])
    expect(breakGap(rows, 0)).toBe(-1567) // exactly the missing row's amount
    expect(editableField(chain, 0)).toBe('amount')
    expect(editableField(chain, 1)).toBe(null) // editing here would only move the break
  })

  it('a misread balance breaks both sides of its row: offer only that balance', () => {
    const rows = ok()
    rows[1] = r('d', -15.67, 97.08) // 79.08 read as 97.08
    const chain = checkChain(rows)
    expect(chain).toEqual(['break', 'break', 'ok', 'oldest'])
    expect(editableField(chain, 1)).toBe('balance')
    expect(editableField(chain, 0)).toBe(null)
  })

  it('a row next to a break is suspect either side of it', () => {
    const chain = checkChain([r('d', 1, 10), r('d', 1, 5), r('d', 1, 4)])
    expect([0, 1, 2].map((i) => touchesBreak(chain, i))).toEqual([true, true, false])
  })
})

describe('parseModelRows on an empty strip', () => {
  it('treats prose with no JSON as a strip without rows', () => {
    expect(parseModelRows('There are no transactions in this image.')).toEqual([])
    expect(parseModelRows('{"rows":[]}')).toEqual([])
  })
})
