// The fun allowance as the forecast sees it (PLAN.md 4a'). Pure: native
// amounts in, display cents out via the caller's converter.
//
// Each month takes its allowance - the month's own amount or the default -
// on the 1st (the current month: on the first projected day). Plan items
// draw against it: while they fit they cost nothing extra; whatever goes
// over is spent on top, so the forecast takes max(allowance, planned).

import { project, type ProjectionItem } from './forecast'

export interface AllowanceAmount {
  amount_cents: number
  currency: string
}
export interface AllowanceMonth extends AllowanceAmount {
  month: string
  locked_at: string | null
  snapshot: PlanSnapshot | null
}
export interface PlanItem {
  id: number
  month: string
  name: string
  amount_cents: number
  currency: string
  date: string | null
  active: number
}
export interface AllowanceData {
  default: AllowanceAmount | null
  months: AllowanceMonth[]
  items: PlanItem[]
}
export interface PlanSnapshot {
  taken: string
  currency: string // display currency the numbers below are in
  allowance_cents: number // display cents
  allowance: AllowanceAmount // as set
  items: Array<{ id: number; name: string; amount_cents: number; currency: string; cents: number; date: string | null }>
  daily_burn_cents: number
  month_end_cents: number | null
}

export interface MonthPlan {
  month: string
  custom: boolean // set on its own, not the default
  allowance: number // display cents
  planned: number // active items, display cents
  over: number // planned beyond the allowance
  left: number // allowance not yet planned
  spend: number // what the forecast takes: max(allowance, planned)
  items: PlanItem[]
  locked_at: string | null
  snapshot: PlanSnapshot | null
}

export type Conv = (cents: number, currency: string) => number

// YYYY-MM for `from` and each following month through `to` (inclusive).
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const end = to.slice(0, 7)
  for (;;) {
    const s = `${y}-${String(m).padStart(2, '0')}`
    if (s > end) break
    out.push(s)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

export function monthPlans(data: AllowanceData, months: string[], conv: Conv): MonthPlan[] {
  return months.map((month) => {
    const own = data.months.find((m) => m.month === month)
    const amt = own ?? data.default
    const allowance = amt ? conv(amt.amount_cents, amt.currency) : 0
    const items = data.items.filter((i) => i.month === month)
    const planned = items.filter((i) => i.active).reduce((s, i) => s + conv(i.amount_cents, i.currency), 0)
    return {
      month,
      custom: !!own,
      allowance,
      planned,
      over: Math.max(0, planned - allowance),
      left: Math.max(0, allowance - planned),
      spend: Math.max(allowance, planned),
      items,
      locked_at: own?.locked_at ?? null,
      snapshot: own?.snapshot ?? null,
    }
  })
}

// One outflow per month. `today` is the projection's start (it projects
// from tomorrow), so the current month's lands tomorrow.
export function allowanceItems(plans: MonthPlan[], today: string, extraOver = new Map<string, number>()): ProjectionItem[] {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  const tomorrow = d.toISOString().slice(0, 10)
  return plans
    .map((p) => {
      const date = p.month === today.slice(0, 7) ? tomorrow : `${p.month}-01`
      const cents = -(p.spend + (extraOver.get(p.month) ?? 0))
      return { cents, dayOfMonth: null, date: date < tomorrow ? tomorrow : date, endMonth: null }
    })
    .filter((it) => it.cents !== 0)
}

// ---- runway and locking, shared by the Forecast and Fun plan screens ----

export const RUNWAY_DAYS = 1095 // look up to three years ahead

export interface Baseline {
  start: number // starting cash, display cents
  daily: number // total daily burn, display cents
  items: ProjectionItem[] // expected items + subscriptions
  today: string
}

// Days until cash hits zero with these plans (null = not within three
// years). `override` swaps one month's plan, to price a change.
export function runwayDays(b: Baseline, plans: MonthPlan[], override?: MonthPlan): number | null {
  const ps = override ? plans.map((p) => (p.month === override.month ? override : p)) : plans
  const r = project(b.start, b.daily, [...b.items, ...allowanceItems(ps, b.today)], b.today, RUNWAY_DAYS)
  return r.zero ? Math.round((Date.parse(r.zero.date) - Date.parse(b.today)) / 86400000) : null
}

// What a month's overage costs: runway as planned vs with the month held
// to its allowance.
export function overCostDays(b: Baseline, plans: MonthPlan[], plan: MonthPlan): number {
  if (plan.over === 0) return 0
  const held = runwayDays(b, plans, { ...plan, spend: plan.allowance })
  return (held ?? RUNWAY_DAYS) - (runwayDays(b, plans) ?? RUNWAY_DAYS)
}

export const fmtRunway = (d: number | null) =>
  d === null ? '3+ years' : d < 60 ? `${d} days` : `${(d / (365 / 12)).toFixed(1)} months`

export const monthName = (m: string) =>
  new Date(m + '-01T00:00:00Z').toLocaleDateString('en', { month: 'long', timeZone: 'UTC' })

export function lastDay(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`
}

// Locking keeps the plan as it stands - allowance, items, and the baseline
// the forecast showed - for plan-vs-reality to compare against.
export function snapshotFor(b: Baseline, plans: MonthPlan[], plan: MonthPlan, data: AllowanceData, cur: string, conv: Conv): PlanSnapshot {
  const long = project(b.start, b.daily, [...b.items, ...allowanceItems(plans, b.today)], b.today, RUNWAY_DAYS)
  const set = data.months.find((m) => m.month === plan.month) ?? data.default ?? { amount_cents: 0, currency: cur }
  return {
    taken: b.today,
    currency: cur,
    allowance_cents: plan.allowance,
    allowance: { amount_cents: set.amount_cents, currency: set.currency },
    items: plan.items
      .filter((i) => i.active)
      .map((i) => ({ id: i.id, name: i.name, amount_cents: i.amount_cents, currency: i.currency, cents: conv(i.amount_cents, i.currency), date: i.date })),
    daily_burn_cents: b.daily,
    month_end_cents: long.points.find((pt) => pt.date === lastDay(plan.month))?.cents ?? null,
  }
}

// Changed since locking: a different allowance or set of items.
export function changedSinceLock(p: MonthPlan, data: AllowanceData): boolean {
  const s = p.snapshot
  if (!s) return false
  const key = (i: { id: number; amount_cents: number; currency: string }) => `${i.id}:${i.amount_cents}:${i.currency}`
  const now = p.items.filter((i) => i.active).map(key).sort().join()
  const then = s.items.map(key).sort().join()
  const own = data.months.find((m) => m.month === p.month)
  return now !== then || (!!own && (own.amount_cents !== s.allowance.amount_cents || own.currency !== s.allowance.currency))
}
