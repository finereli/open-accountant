// The Plaid sync summary: "up to date" must mean Plaid genuinely had
// nothing, never a stand-in for "something came back but got filtered out
// silently". This was the root of a real staleness bug - a bank looked
// synced (summary: "up to date") while the ledger was weeks behind, with no
// visible signal of why.

import { describe, it, expect } from 'vitest'
import { summaryLine } from '../functions/api/plaid/sync'

const base = { inserted: 0, claimed: 0, fetched: 0, skippedPending: 0, skippedUnmapped: 0, alreadySynced: 0 }

describe('summaryLine', () => {
  it('is "up to date" only when Plaid fetched nothing', () => {
    expect(summaryLine(base)).toBe('up to date')
  })

  it('leads with new/matched when the sync actually wrote something', () => {
    expect(summaryLine({ ...base, inserted: 3, fetched: 3 })).toBe('3 new')
    expect(summaryLine({ ...base, claimed: 2, fetched: 2 })).toBe('2 matched')
    expect(summaryLine({ ...base, inserted: 1, claimed: 1, fetched: 2 })).toBe('1 new · 1 matched')
  })

  it('explains a fetch that produced zero writes instead of calling it up to date', () => {
    expect(summaryLine({ ...base, fetched: 4, skippedPending: 4 })).toBe('4 pending')
    expect(summaryLine({ ...base, fetched: 2, skippedUnmapped: 2 })).toBe('2 unmapped')
    // A stuck cursor re-walks the same window every run: everything comes
    // back "already synced" and nothing new ever lands.
    expect(summaryLine({ ...base, fetched: 10, alreadySynced: 10 })).toBe('10 re-fetched')
  })

  describe("Plaid's own bank refresh", () => {
    const now = new Date('2026-09-29T19:00:00Z')

    it('stays quiet when the bank was read recently', () => {
      expect(summaryLine({ ...base, now, lastBankRead: '2026-09-29T10:00:00Z' })).toBe('up to date')
    })

    it('replaces "up to date" when Plaid has not read the bank in days', () => {
      expect(summaryLine({ ...base, now, lastBankRead: '2026-09-09T08:00:00Z' })).toBe(
        'Plaid last read the bank 2026-09-09'
      )
    })

    it('says the refresh is failing when failures are newer than the last success', () => {
      expect(
        summaryLine({ ...base, now, lastBankRead: '2026-09-09T08:00:00Z', lastBankFail: '2026-09-29T06:00:00Z' })
      ).toBe("Plaid can't read the bank - last success 2026-09-09, failing since 2026-09-29")
    })

    it('keeps the counts alongside a stale warning', () => {
      expect(summaryLine({ ...base, now, inserted: 2, fetched: 2, lastBankRead: '2026-09-20T08:00:00Z' })).toBe(
        '2 new · Plaid last read the bank 2026-09-20'
      )
    })
  })
})
