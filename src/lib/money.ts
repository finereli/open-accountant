// Money display and conversion. Everything internal is integer cents; floats
// appear only at the display/FX boundary.

// Any ISO 4217 code. The list in use comes from the server (the accounts'
// currencies plus the home currency) - see accounts.currencies.
export type Currency = string

// Amounts are stored in hundredths, so currencies without minor units (JPY,
// KRW) still work - they just carry two unused decimal places.
const SYMBOL: Record<string, string> = {}

const nf = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nf0 = new Intl.NumberFormat('en', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

// The home currency gets its plain symbol ("$"); every other currency the
// unambiguous one ("MX$", "CA$", "€"), so pesos never read as dollars.
let HOME = 'USD'
export function setHomeCurrency(c: string) {
  if (c === HOME) return
  HOME = c
  for (const k of Object.keys(SYMBOL)) delete SYMBOL[k]
}

export function symbol(currency: string): string {
  if (!(currency in SYMBOL)) {
    let sym = currency + ' '
    try {
      const part = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: currency === HOME ? 'narrowSymbol' : 'symbol' })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value
      if (part && part !== currency) sym = part
    } catch {}
    SYMBOL[currency] = sym
  }
  return SYMBOL[currency]
}

// "-$1,234.56" - the sign leads so negative balances read instantly.
export function fmtCents(cents: number, currency: string, opts: { whole?: boolean } = {}): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents) / 100
  return `${sign}${symbol(currency)}${(opts.whole ? nf0 : nf).format(abs)}`
}

// Signed amount for ledger rows: money in gets an explicit plus.
export function fmtAmount(cents: number, currency: string): string {
  return (cents > 0 ? '+' : '') + fmtCents(cents, currency)
}

// fx maps currency -> USD rate. Cross rates go through USD.
export function convertCents(cents: number, from: string, to: string, fx: Record<string, number>): number | null {
  if (from === to) return cents
  const f = fx[from]
  const t = fx[to]
  if (!f || !t) return null
  return Math.round((cents * f) / t)
}

// "1,234.56" / "-950" / "$1,000.5" -> cents. Null when unparseable.
export function parseCents(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '').replace(/^(-?)[^\d.-]+/, '$1')
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.round(parseFloat(cleaned) * 100)
}
