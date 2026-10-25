// The merchant key: the same shop must yield the same key across sources and
// visits (so one decision covers them all), without merging strangers.

import { describe, it, expect } from 'vitest'
import { merchantKey } from '../functions/api/_lib'

describe('merchantKey', () => {
  it('drops card boilerplate that says nothing about who was paid', () => {
    expect(merchantKey('POS Purchase Corner Bakery')).toBe('corner bakery')
    expect(merchantKey('Visa Debit Purchase Corner Bakery')).toBe('corner bakery')
    expect(merchantKey('Card transaction of 7.50 USD issued by Github')).toBe('github')
  })
  it('ignores amounts, fees, wallet suffixes and per-transfer references', () => {
    expect(merchantKey('Converted 400.00 USD to 345.06 EUR')).toBe(merchantKey('Converted 1,500.00 USD to 1,293.99 EUR'))
    expect(merchantKey('Disney Plus London (fee: 0.07 EUR)')).toBe('disney plus london')
    expect(merchantKey('Corner Bakery (Google Pay)')).toBe('corner bakery')
    expect(merchantKey('Received money from Alex Smith with reference April invoice')).toBe('received money from alex smith')
  })
  it('folds marketplace order codes and trailing reference numbers', () => {
    expect(merchantKey('Amazon* Jm0tm40n5')).toBe('amazon')
    expect(merchantKey('AMAZON.COM* 2K4LP')).toBe('amazon')
    expect(merchantKey('Ebay O*12-15003-84755')).toBe('ebay')
    expect(merchantKey('Acme Cloud, IN+1848')).toBe('acme cloud, in')
    expect(merchantKey('Bank Transit 13300 Springfield')).toBe('bank transit springfield')
  })
  it('keeps distinct names distinct', () => {
    expect(merchantKey('Amazon Prime')).toBe('amazon prime')
    expect(merchantKey('Café Lumière')).toBe('café lumière')
    expect(merchantKey('Магнит Москва')).toBe('магнит москва')
  })
})
