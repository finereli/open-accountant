// Tracks an account's background screenshot import (see
// functions/api/import/_jobs.ts). The server does the reading; this polls
// for progress while the app is open, and again the moment it comes back
// to the foreground - each poll also restarts any strip that stalled.

import { apiJson } from './api'
import type { ReadRow } from './statement-import'

export interface ImportJob {
  id: number
  account_id: string
  total: number
  done: number
  failed: number[]
  finished: boolean
  strips: ReadRow[][] | null
}

const POLL_MS = 2500

export class ImportTracker {
  job = $state<ImportJob | null>(null)
  #accountId: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #onVisible = () => {
    if (document.visibilityState === 'visible') this.refresh()
  }

  watch(accountId: string) {
    this.stop()
    this.#accountId = accountId
    this.job = null
    document.addEventListener('visibilitychange', this.#onVisible)
    this.refresh()
  }

  stop() {
    document.removeEventListener('visibilitychange', this.#onVisible)
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#accountId = null
  }

  async refresh() {
    const acct = this.#accountId
    if (!acct) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    try {
      const r = await apiJson<{ job: ImportJob | null }>(`/api/import/jobs?account_id=${encodeURIComponent(acct)}`)
      if (this.#accountId !== acct) return
      this.job = r.job
    } catch {
      // Offline or asleep: try again on the next tick.
    }
    if (this.#accountId === acct && this.job && !this.job.finished && document.visibilityState === 'visible')
      this.#timer = setTimeout(() => this.refresh(), POLL_MS)
  }

  async start(accountId: string, strips: string[]) {
    const r = await apiJson<{ id: number; total: number }>('/api/import/jobs', {
      method: 'POST',
      body: { account_id: accountId, strips },
    })
    this.job = { id: r.id, account_id: accountId, total: r.total, done: 0, failed: [], finished: false, strips: null }
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.refresh(), POLL_MS)
  }

  async discard() {
    const j = this.job
    this.job = null
    if (j) await apiJson(`/api/import/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {})
  }
}
