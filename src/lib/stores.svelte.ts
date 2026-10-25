// Dashboard data: accounts with balances plus FX, loaded once after auth and
// refreshed after mutations (reconcile, anchor edit). Account detail is a
// per-entity fetch - transaction lists are the heavy payload.

import { apiJson } from './api'
import { auth } from './auth.svelte'
import type { AccountsResponse, AccountSummary, AccountDetail } from './types'
import { setHomeCurrency, type Currency } from './money'

const CUR_KEY = 'accountant.cur.v1'

class Accounts {
  list = $state<AccountSummary[]>([])
  fx = $state<Record<string, number>>({})
  fxDate = $state<string | null>(null)
  // The currencies the app offers: home first, then each account's.
  currencies = $state<Currency[]>([])
  home = $state<Currency>('USD')
  loading = $state(true)
  #loaded = false

  async load(force = false) {
    if (this.#loaded && !force) return
    try {
      const res = await apiJson<AccountsResponse>('/api/accounts')
      this.list = res.accounts
      this.fx = res.fx
      this.fxDate = res.fx_date
      this.currencies = res.currencies
      this.home = res.home_currency
      setHomeCurrency(res.home_currency)
      displayCurrency.adopt(res.home_currency, res.currencies)
      this.#loaded = true
      this.loading = false
    } catch {
      // Keep loading=true on failure: a spinner, not a fake-empty list.
      if (!this.#loaded) this.loading = true
    }
  }

  byId(id: string): AccountSummary | undefined {
    return this.list.find((a) => a.id === id)
  }

  reset() {
    this.list = []
    this.#loaded = false
    this.loading = true
  }
}

export const accounts = new Accounts()

class DisplayCurrency {
  current = $state<Currency>(read() ?? 'USD')

  // Once the server says what's in use: keep a remembered pick that's still
  // offered, else fall back to the home currency.
  adopt(home: Currency, offered: Currency[]) {
    const saved = read()
    this.current = saved && offered.includes(saved) ? saved : home
  }

  set(c: Currency) {
    this.current = c
    try {
      localStorage.setItem(CUR_KEY, c)
    } catch {}
  }
}

function read(): Currency | null {
  try {
    const v = localStorage.getItem(CUR_KEY)
    return v && /^[A-Z]{3}$/.test(v) ? v : null
  } catch {
    return null
  }
}

export const displayCurrency = new DisplayCurrency()

export function fetchAccountDetail(id: string): Promise<AccountDetail> {
  return apiJson<AccountDetail>(`/api/accounts/${id}/transactions`)
}

// Load once signed in (always, behind Access).
$effect.root(() => {
  $effect(() => {
    if (auth.signedIn) accounts.load(true)
    else accounts.reset()
  })
})
