// Screenshot import: a bank app's transaction list, read by a vision model in
// overlapping strips, merged back into one list, then verified by the
// running balance the bank prints under each amount. The chain is what makes
// a machine reading trustworthy: every row's amount must turn the balance of
// the row before it into its own balance, so a single misread digit breaks
// the chain exactly where it happened instead of slipping into the ledger.

export interface ReadRow {
  date: string | null // YYYY-MM-DD; null = no date header above it in its strip
  description: string
  amount_cents: number // signed: negative = money out
  balance_cents: number | null // the bank's balance after this row, when shown
}

// Strips arrive top to bottom, rows within each strip top to bottom (newest
// first, the way bank apps list them). Neighbouring strips overlap, so the
// head of each strip repeats the tail of the one before; those repeats are
// dropped. A row with no date inherits the date of the row above it - it sat
// under a header that scrolled into the previous strip.
export function mergeStrips(strips: ReadRow[][]): ReadRow[] {
  const out: ReadRow[] = []
  const TAIL = 8 // overlap never repeats more rows than this
  for (const strip of strips) {
    const tail = out.slice(-TAIL)
    let i = 0
    // Skip this strip's leading rows while they repeat the previous tail.
    while (i < strip.length && tail.some((t) => sameRow(t, strip[i]))) i++
    for (; i < strip.length; i++) {
      const r = strip[i]
      out.push({ ...r, date: r.date ?? out[out.length - 1]?.date ?? null })
    }
  }
  return out
}

function sameRow(a: ReadRow, b: ReadRow): boolean {
  if (a.amount_cents !== b.amount_cents) return false
  // The balance pins a row down uniquely; without one fall back to text.
  if (a.balance_cents !== null && b.balance_cents !== null) return a.balance_cents === b.balance_cents
  return a.description === b.description
}

// Per row (same order as given, newest first): 'ok' when the next-older row's
// balance plus this row's amount equals this row's balance; 'break' when it
// doesn't; 'oldest' for the last row, which has nothing below it to check
// against; 'none' when balances aren't shown at all.
export type ChainStatus = 'ok' | 'break' | 'oldest' | 'none'

export function checkChain(rows: ReadRow[]): ChainStatus[] {
  return rows.map((r, i) => {
    const older = rows[i + 1]
    if (r.balance_cents === null) return 'none'
    if (!older) return 'oldest'
    if (older.balance_cents === null) return 'none'
    return older.balance_cents + r.amount_cents === r.balance_cents ? 'ok' : 'break'
  })
}

// How much a break is off by: the bank's balance at row i minus what the
// older row's balance plus row i's amount comes to. A gap equal to some
// charge's amount usually means that row is missing from the screenshot
// (cut off, or lost where a scrolling capture was stitched).
export function breakGap(rows: ReadRow[], i: number): number | null {
  const r = rows[i]
  const older = rows[i + 1]
  if (!older || r.balance_cents === null || older.balance_cents === null) return null
  return r.balance_cents - (older.balance_cents + r.amount_cents)
}

// Which number to offer for editing at row i. A break on both sides of a
// row is the signature of its balance being misread - fixing that one
// number heals both. A break on one side means the amount was misread or a
// row is missing; only the amount is offered, because editing a balance
// there just moves the break to the next row up.
export function editableField(chain: ChainStatus[], i: number): 'amount' | 'balance' | null {
  const below = chain[i] === 'break'
  const above = i > 0 && chain[i - 1] === 'break'
  if (below && above) return 'balance'
  // The row below has breaks on both sides: its balance is the suspect, so
  // this break is that one's other half, not this row's amount.
  if (below && chain[i + 1] === 'break') return null
  if (below) return 'amount'
  return null
}

// A row next to a break can't be trusted. It blocks the import only if
// it's being imported - breaks among rows the ledger already has don't
// matter, nothing is written for them.
export function touchesBreak(chain: ChainStatus[], i: number): boolean {
  return chain[i] === 'break' || (i > 0 && chain[i - 1] === 'break')
}
