// The ingest gate: dedup by semantic hash, and the verified-checkpoint
// boundary. The same-day case replays a real loss: wise-eur was reconciled
// midday Aug 25 2026, eBag charged 66.02 EUR that night, and the old
// `date <= checkpoint` gate silently dropped the charge on the next sync
// while its 0.08 correction (dated Aug 26) went in - leaving the ledger off
// by exactly the charge.

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { ingestRows, lastVerifiedDate, type IngestRowIn } from '../functions/api/_lib'

let db: ReturnType<typeof makeTestDb>

const row = (over: Partial<IngestRowIn>): IngestRowIn => ({
  account_id: 'wise-eur',
  date: '2026-08-25',
  description: 'Card transaction issued by Sumup  *Ebag.bg SOFIIA',
  amount_cents: -100,
  balance_after_cents: null,
  source_file: 'test',
  semantic_hash: 'wise:TEST',
  ...over,
})

const ledger = async () =>
  (
    await db
      .prepare('SELECT date, amount_cents, semantic_hash FROM transactions WHERE account_id = ? ORDER BY date, id')
      .bind('wise-eur')
      .all()
  ).results as Array<{ date: string; amount_cents: number; semantic_hash: string }>

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort)
    VALUES ('wise-eur', 'alex', 'wise', 'wallet', 'EUR', 'Wise EUR', 0);
    INSERT INTO ledger_anchors (account_id, date, balance_cents, source)
    VALUES ('wise-eur', '2026-01-01', 0, 'manual');
  `)
})

describe('semantic-hash dedup', () => {
  it('drops a re-sent row, inserts a new one', async () => {
    const first = await ingestRows(db, [row({ semantic_hash: 'wise:CARD-1' })])
    expect(first).toMatchObject({ inserted: 1, duplicates: 0 })

    const again = await ingestRows(db, [
      row({ semantic_hash: 'wise:CARD-1' }),
      row({ semantic_hash: 'wise:CARD-2' }),
    ])
    expect(again).toMatchObject({ inserted: 1, duplicates: 1 })
    expect(await ledger()).toHaveLength(2)
  })

  it('counts an in-payload duplicate once', async () => {
    const out = await ingestRows(db, [row({ semantic_hash: 'wise:CARD-1' }), row({ semantic_hash: 'wise:CARD-1' })])
    expect(out).toMatchObject({ inserted: 1, duplicates: 1 })
  })
})

describe('verified-checkpoint gate', () => {
  // Balance 429.38 on Aug 25, reconciled that day: the boundary the eBag
  // charge later crossed.
  beforeEach(async () => {
    await ingestRows(db, [row({ date: '2026-08-25', amount_cents: 42938, semantic_hash: 'wise:SEED' })])
    db.exec(`
      INSERT INTO reconciliation_checkpoints (account_id, date, balance_cents, computed_cents, verified_at)
      VALUES ('wise-eur', '2026-08-25', 42938, 42938, '2026-08-25T13:16:12Z');
    `)
    expect(await lastVerifiedDate(db, 'wise-eur')).toBe('2026-08-25')
  })

  it('flags a row dated strictly before the boundary', async () => {
    const out = await ingestRows(db, [row({ date: '2026-08-24', semantic_hash: 'wise:LATE-CSV' })])
    expect(out.inserted).toBe(0)
    expect(out.flagged).toHaveLength(1)
    expect(out.flagged[0]).toMatchObject({ account_id: 'wise-eur', date: '2026-08-24' })
    expect(await ledger()).toHaveLength(1)
  })

  it('inserts a row dated ON the boundary day (the lost eBag charge)', async () => {
    // A checkpoint verifies a moment, not the end of its day: money that
    // moves later the same day must land, not vanish into the flagged list.
    const out = await ingestRows(db, [row({ date: '2026-08-25', amount_cents: -6602, semantic_hash: 'wise:CARD-EBAG' })])
    expect(out).toMatchObject({ inserted: 1, duplicates: 0 })
    expect(out.flagged).toHaveLength(0)
  })

  it('replays the full eBag sync: charge + correction land, checkpoint flips to mismatch', async () => {
    const out = await ingestRows(db, [
      row({ date: '2026-08-25', amount_cents: 42938, semantic_hash: 'wise:SEED' }), // re-fetched, dups out
      row({ date: '2026-08-25', amount_cents: -6602, semantic_hash: 'wise:CARD-EBAG' }),
      row({ date: '2026-08-26', amount_cents: -8, semantic_hash: 'wise:CARD-CORRECTION' }),
    ])
    expect(out).toMatchObject({ inserted: 2, duplicates: 1 })
    expect(out.flagged).toHaveLength(0)

    // The Aug 25 checkpoint no longer matches (it recorded a midday balance),
    // so it stops being the freeze boundary - by design it stays open...
    expect(await lastVerifiedDate(db, 'wise-eur')).toBe(null)

    // ...and a later reconcile at the true balance seals everything again.
    db.exec(`
      INSERT INTO reconciliation_checkpoints (account_id, date, balance_cents, computed_cents, verified_at)
      VALUES ('wise-eur', '2026-08-26', ${42938 - 6602 - 8}, NULL, '2026-08-26T21:00:00Z');
    `)
    expect(await lastVerifiedDate(db, 'wise-eur')).toBe('2026-08-26')
  })
})

describe('unknown accounts', () => {
  it('reports them without inserting', async () => {
    const out = await ingestRows(db, [row({ account_id: 'nope' })])
    expect(out.inserted).toBe(0)
    expect(out.unknown_accounts).toEqual(['nope'])
  })
})
