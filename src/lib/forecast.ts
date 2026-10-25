// The forecast projection - pure math, display-currency cents in, a daily
// series out, so the Forecast screen can redraw instantly on any edit.
// Everything here is already converted: the caller turns native-currency
// burn and items into display cents with the FX table first.

export interface ProjectionItem {
  cents: number // signed: income positive, expense negative
  dayOfMonth: number | null // monthly recurring...
  date: string | null // ...or a one-off YYYY-MM-DD
  endMonth: string | null // YYYY-MM inclusive, recurring only
  endDate?: string | null // YYYY-MM-DD inclusive, recurring only (sub cancellation)
  perDay?: boolean // cents charged every day
}

export interface ProjectionPoint {
  date: string
  cents: number
}

export interface Projection {
  points: ProjectionPoint[]
  low: ProjectionPoint
  end: ProjectionPoint
  zero: ProjectionPoint | null // first day the cash touches or crosses zero
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

// A recurring item on day 31 lands on the last day of shorter months.
function landsOn(dateISO: string, item: ProjectionItem): boolean {
  if (item.perDay) return true
  if (item.date) return item.date === dateISO
  if (item.dayOfMonth == null) return false
  const month = dateISO.slice(0, 7)
  if (item.endMonth && month > item.endMonth) return false
  if (item.endDate && dateISO > item.endDate) return false
  const day = Number(dateISO.slice(8))
  const last = new Date(Number(dateISO.slice(0, 4)), Number(dateISO.slice(5, 7)), 0).getDate()
  return day === Math.min(item.dayOfMonth, last)
}

export function project(
  startCents: number,
  dailyBurnCents: number, // positive magnitude, drained every day
  items: ProjectionItem[],
  startDate: string, // YYYY-MM-DD (today); projection starts tomorrow
  horizonDays: number
): Projection {
  const points: ProjectionPoint[] = [{ date: startDate, cents: startCents }]
  let cents = startCents
  const d = new Date(startDate + 'T00:00:00Z')
  for (let i = 1; i <= horizonDays; i++) {
    d.setUTCDate(d.getUTCDate() + 1)
    const day = iso(d)
    cents -= dailyBurnCents
    for (const it of items) if (landsOn(day, it)) cents += it.cents
    points.push({ date: day, cents: Math.round(cents) })
  }
  let low = points[0]
  for (const p of points) if (p.cents < low.cents) low = p
  const zero = points.find((p) => p.cents <= 0) ?? null
  return { points, low, end: points[points.length - 1], zero }
}

// ---- the forecast's inputs, shared by the Forecast screen and the MCP ----
// Everything below turns the raw API shapes into display cents with `conv`.

export type Conv = (cents: number, currency: string) => number

export interface BurnInput {
  category_id: number
  name: string
  currency: string
  total_cents: number // signed window sum (expenses negative)
  pinned_daily_cents: number | null
  pinned_currency: string | null
}
export interface SubInput {
  merchant_id: number
  name: string
  currency: string
  monthly_cents: number
  day: number
  end_date: string | null
}
export interface ExpectedInput {
  name: string
  kind: 'income' | 'expense'
  amount_cents: number
  currency: string
  day_of_month: number | null
  date: string | null
  end_month: string | null
  per_day: number
}

// Starting cash: the cash-kind accounts you plan with (in_spending - the
// same scope as the Spending view). Debt is its own story.
export function cashStart(
  accounts: Array<{ in_spending: number; kind: string; balance_cents: number; currency: string }>,
  conv: Conv
): number {
  return accounts
    .filter((a) => a.in_spending === 1 && a.kind !== 'credit_card' && a.kind !== 'line_of_credit')
    .reduce((s, a) => s + conv(a.balance_cents, a.currency), 0)
}

// Daily burn per run-rate category: a pin replaces the measured rate
// wholesale; otherwise the window's spending / window days.
export interface BurnLine {
  category_id: number
  name: string
  daily: number // what the forecast uses: the pin, or the measured rate
  pinned: boolean
  measured: number // window total / window days
  spent: number // window total
}
export function burnLines(burn: BurnInput[], windowDays: number, conv: Conv): BurnLine[] {
  const byCat = new Map<number, { category_id: number; name: string; raw: BurnInput[] }>()
  for (const b of burn) {
    const g = byCat.get(b.category_id) ?? byCat.set(b.category_id, { category_id: b.category_id, name: b.name, raw: [] }).get(b.category_id)!
    g.raw.push(b)
  }
  const lines: BurnLine[] = []
  for (const g of byCat.values()) {
    const spent = Math.max(0, Math.round(g.raw.reduce((s, r) => s + conv(-r.total_cents, r.currency), 0)))
    const measured = Math.round(spent / windowDays)
    const pin = g.raw.find((r) => r.pinned_daily_cents != null)
    const base = { category_id: g.category_id, name: g.name, spent, measured }
    if (pin) lines.push({ ...base, daily: conv(pin.pinned_daily_cents!, pin.pinned_currency!), pinned: true })
    else lines.push({ ...base, daily: measured, pinned: false })
  }
  return lines.sort((a, b) => b.daily - a.daily)
}

// Expected income/expenses plus the derived subscriptions, as projection items.
export function baseItems(items: ExpectedInput[], subs: SubInput[], conv: Conv): ProjectionItem[] {
  const out: ProjectionItem[] = items.map((it) => ({
    cents: (it.kind === 'income' ? 1 : -1) * conv(it.amount_cents, it.currency),
    dayOfMonth: it.per_day ? null : it.day_of_month,
    date: it.per_day ? null : it.date,
    endMonth: it.end_month,
    perDay: !!it.per_day,
  }))
  // Each subscription recurs monthly at its usual day; a cancellation
  // (end_date) caps its projection.
  for (const sub of subs)
    out.push({ cents: -conv(sub.monthly_cents, sub.currency), dayOfMonth: sub.day, date: null, endMonth: null, endDate: sub.end_date })
  return out
}

export const daysUntil = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000)
