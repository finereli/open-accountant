// The fun allowance in the forecast: per-month amounts, items drawing
// against them, and only the overage costing anything extra.

import { describe, it, expect } from 'vitest'
import { monthPlans, allowanceItems, monthsBetween, type AllowanceData } from '../src/lib/allowance'

const conv = (c: number, cur: string) => (cur === 'USD' ? Math.round(c * 0.9) : c) // to EUR

const data: AllowanceData = {
  default: { amount_cents: 40000, currency: 'EUR' },
  months: [{ month: '2026-10', amount_cents: 20000, currency: 'EUR', locked_at: null, snapshot: null }],
  items: [
    { id: 1, month: '2026-10', name: 'Dinner', amount_cents: 8000, currency: 'EUR', date: null, active: 1 },
    { id: 2, month: '2026-10', name: 'Course', amount_cents: 20000, currency: 'USD', date: null, active: 1 },
    { id: 3, month: '2026-10', name: 'Maybe', amount_cents: 50000, currency: 'EUR', date: null, active: 0 },
    { id: 4, month: '2026-11', name: 'Concert', amount_cents: 6000, currency: 'EUR', date: '2026-11-14', active: 1 },
  ],
}

describe('monthsBetween', () => {
  it('walks months across a year end', () => {
    expect(monthsBetween('2026-11-17', '2027-02-03')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })
})

describe('monthPlans', () => {
  it('uses the month amount or the default, and counts only active items', () => {
    const [oct, nov, dec] = monthPlans(data, ['2026-10', '2026-11', '2026-12'], conv)
    expect(oct).toMatchObject({ custom: true, allowance: 20000, planned: 26000, over: 6000, left: 0, spend: 26000 })
    expect(nov).toMatchObject({ custom: false, allowance: 40000, planned: 6000, over: 0, left: 34000, spend: 40000 })
    expect(dec).toMatchObject({ allowance: 40000, planned: 0, spend: 40000 })
  })
})

describe('allowanceItems', () => {
  it("lands the current month tomorrow and later months on the 1st", () => {
    const plans = monthPlans(data, ['2026-10', '2026-11'], conv)
    expect(allowanceItems(plans, '2026-10-17')).toEqual([
      { cents: -26000, dayOfMonth: null, date: '2026-10-18', endMonth: null },
      { cents: -40000, dayOfMonth: null, date: '2026-11-01', endMonth: null },
    ])
  })
  it('lands tomorrow even when today is the last day of the month', () => {
    const plans = monthPlans({ ...data, items: [] }, ['2026-10', '2026-11'], conv)
    expect(allowanceItems(plans, '2026-10-31').map((i) => i.date)).toEqual(['2026-11-01', '2026-11-01'])
  })
})
