// Bank CSV formats, described as data. Every bank exports something
// slightly different; instead of a parser per bank, ingest.config.json says
// for each kind of file which account it feeds and which columns mean what.
// See ingest.config.example.json and the README.
//
// Dedup: sha256 of account|date|amount, with an occurrence index appended so
// two genuinely identical same-day purchases both survive. The description is
// deliberately NOT part of the key: banks rename lines between downloads,
// and a renamed description must still dedup against the row an earlier
// download already delivered. Statement screenshots imported in the app hash
// the same way, so the two never double each other. Occurrence indexing
// assumes a download that covers a day carries all of that day's rows -
// true for every export we've seen.

import { createHash } from 'node:crypto'
import { parseCsv } from './csv'
import type { IngestRow } from '../src/lib/types'

export interface CsvFormat {
  name: string
  file: string // regex matched against the file name (case-insensitive)
  account: string // accounts.id the rows go to
  header?: string[] // optional: the first columns of the header row, to confirm the layout
  skip_rows?: number // lines before the header (some banks put a preamble on top)
  date: { column: string; format: string } // format: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, DD.MM.YYYY, ...
  description: string | string[] // column(s), joined with a space
  amount?: string // one signed column...
  debit?: string // ...or money out and money in in two columns
  credit?: string
  negate?: boolean // flip signs: card exports often show a charge as positive
  balance?: string // the running balance after the row, when the bank gives one
  decimal?: '.' | ',' // decimal separator (default '.')
  only?: { column: string; equals: string } // keep only matching rows (e.g. Status = Posted)
}

export interface ParseResult {
  rows: IngestRow[]
  skipped: Record<string, number> // reason -> count
}

function skip(sk: Record<string, number>, reason: string) {
  sk[reason] = (sk[reason] ?? 0) + 1
}

// "$1,234.56" / "-950" / "(12.00)" / "12.00-" / "1.234,56" (decimal ',') ->
// integer cents, decimally exact (no float rounding on the parse path -
// this is a ledger). Null when it isn't a number; '' is null too.
export function parseAmount(raw: string, decimal: '.' | ',' = '.'): number | null {
  let s = raw.trim()
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  if (s.endsWith('-')) {
    neg = !neg
    s = s.slice(0, -1)
  }
  s = s.replace(/[^\d.,-]/g, '') // currency symbols, spaces, codes
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  }
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  const m = s.match(/^(\d+)(?:\.(\d{1,10}))?$/)
  if (!m) return null
  const frac = (m[2] ?? '').padEnd(2, '0')
  let cents = parseInt(m[1], 10) * 100 + parseInt(frac.slice(0, 2), 10)
  if (frac.length > 2 && parseInt(frac[2], 10) >= 5) cents += 1 // half-up past 2 places
  return neg ? -cents : cents
}

// Date by a pattern of YYYY / YY / MM / DD with any separators; MM and DD
// accept one digit too ("3/7/2026"). Returns YYYY-MM-DD or null.
export function parseDate(raw: string, format: string): string | null {
  const s = raw.trim().split(/[ T]/)[0] // drop a time part
  const order = format.match(/YYYY|YY|MM|DD/g)
  if (!order || order.length !== 3) return null
  const parts = s.split(/[^\d]+/).filter(Boolean)
  if (parts.length !== 3) return null
  let y = 0, m = 0, d = 0
  order.forEach((tok, i) => {
    const n = parseInt(parts[i], 10)
    if (tok === 'YYYY') y = n
    else if (tok === 'YY') y = 2000 + n
    else if (tok === 'MM') m = n
    else d = n
  })
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null // Feb 30
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function matchesFile(f: CsvFormat, fileName: string): boolean {
  return new RegExp(f.file, 'i').test(fileName)
}

export function parseWithFormat(text: string, f: CsvFormat, sourceFile: string, since: string): ParseResult {
  const lines = parseCsv(text).slice(f.skip_rows ?? 0)
  const skipped: Record<string, number> = {}
  const rows: IngestRow[] = []
  if (lines.length === 0) return { rows, skipped }

  const header = lines[0].map((h) => h.trim())
  if (f.header && !f.header.every((c, i) => header[i] === c))
    throw new Error(`${sourceFile}: header doesn't match format "${f.name}" (got ${header.join(', ')})`)
  const col = (name: string | undefined) => {
    if (name === undefined) return -1
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`${sourceFile}: no column "${name}" (format "${f.name}"; columns: ${header.join(', ')})`)
    return i
  }
  const iDate = col(f.date.column)
  const iDesc = (Array.isArray(f.description) ? f.description : [f.description]).map(col)
  const iAmount = col(f.amount)
  const iDebit = col(f.debit)
  const iCredit = col(f.credit)
  const iBalance = col(f.balance)
  const iOnly = col(f.only?.column)
  if (iAmount < 0 && iDebit < 0 && iCredit < 0) throw new Error(`format "${f.name}": give amount, or debit and credit`)

  const seen = new Map<string, number>() // occurrence index per semantic key
  for (const cells of lines.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '')
    if (cells.every((c) => !c.trim())) continue
    if (iOnly >= 0 && cell(iOnly).toLowerCase() !== f.only!.equals.toLowerCase()) {
      skip(skipped, `${f.only!.column} not ${f.only!.equals}`)
      continue
    }
    const date = parseDate(cell(iDate), f.date.format)
    if (!date) {
      skip(skipped, 'bad date')
      continue
    }
    if (date < since) {
      skip(skipped, `before ${since}`)
      continue
    }

    let amount: number | null
    if (iAmount >= 0) {
      amount = parseAmount(cell(iAmount), f.decimal)
    } else {
      // Debit/credit columns: one of the two is filled. Banks disagree on
      // whether debits carry a minus, so take magnitudes and set the sign.
      const out = parseAmount(cell(iDebit), f.decimal)
      const inn = parseAmount(cell(iCredit), f.decimal)
      amount = out !== null && out !== 0 ? -Math.abs(out) : inn !== null ? Math.abs(inn) : out
    }
    if (amount === null) {
      skip(skipped, 'bad amount')
      continue
    }
    if (f.negate) amount = -amount

    const description = iDesc.map(cell).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    const key = `${f.account}|${date}|${amount}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    rows.push({
      account_id: f.account,
      date,
      description,
      amount_cents: amount,
      balance_after_cents: iBalance >= 0 ? parseAmount(cell(iBalance), f.decimal) : null,
      source_file: sourceFile,
      semantic_hash: createHash('sha256').update(n > 1 ? `${key}#${n}` : key).digest('hex'),
      external_id: null,
    })
  }
  return { rows, skipped }
}
