// Shared bits of the allowance API.

import { isCurrency } from '../_lib'
export { isCurrency }
export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

export interface ItemBody {
  month?: string
  name?: string
  amount_cents?: number
  currency?: string
  date?: string | null
  active?: boolean
}

export function validateItem(b: ItemBody, partial = false): string | null {
  if (!partial || b.month !== undefined) if (!isMonth(b.month)) return 'month must be YYYY-MM'
  if (!partial || b.name !== undefined) if (!b.name?.trim()) return 'name required'
  if (!partial || b.amount_cents !== undefined)
    if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) <= 0) return 'amount_cents must be a positive integer'
  if (!partial || b.currency !== undefined) if (!isCurrency(b.currency)) return 'currency must be a 3-letter code'
  if (b.date != null && !isDate(b.date)) return 'date must be YYYY-MM-DD'
  if (b.date != null && b.month && b.date.slice(0, 7) !== b.month) return 'date must fall in the month'
  return null
}
