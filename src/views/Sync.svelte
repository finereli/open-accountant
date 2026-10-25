<script lang="ts">
  // The sync center: every remote source fires in parallel when asked, each
  // with its own status row. A source that isn't set up says so instead of
  // failing. New sources slot into SOURCES.
  import { apiJson } from '../lib/api'
  import { accounts } from '../lib/stores.svelte'
  import { fmtCents } from '../lib/money'
  import { router } from '../lib/router.svelte'

  interface FlaggedRow {
    account_id: string
    date: string
    description: string
    amount_cents: number
  }
  interface SourceResult {
    ok: boolean
    not_configured?: boolean
    message?: string
    inserted: number
    duplicates: number
    claimed?: number
    flagged: FlaggedRow[]
    summary?: string // server-computed, when the source provides one
    relink?: Array<{ item: number; institution: string }> // banks Plaid needs a fresh login for
  }
  type SourceStatus =
    | { state: 'syncing' }
    | { state: 'done'; result: SourceResult }
    | { state: 'off'; message: string }
    | { state: 'failed'; message: string }

  interface FxState {
    fx: Record<string, number>
    fx_date: string | null
  }

  const SOURCES: Array<{ key: string; label: string; path: string }> = [
    { key: 'plaid', label: 'Banks (Plaid)', path: '/api/plaid/sync' },
    { key: 'wise', label: 'Wise', path: '/api/wise-sync' },
  ]

  let statuses = $state<Record<string, SourceStatus>>({})

  // Sync runs when asked, not on entry - the screen first shows where things
  // stand. Last-sync times come from the server (sync_state), so every
  // device sees the truth.
  let lastBySource = $state<Record<string, { synced_at: string; summary: string | null }>>({})
  let ran = $state(false)
  let fxState = $state<FxState | null>(null)
  let fxRefreshing = $state(false)

  $effect(() => {
    apiJson<{ sources: Array<{ source: string; synced_at: string; summary: string | null }> }>('/api/sync-state')
      .then((r) => {
        const map: typeof lastBySource = {}
        for (const s of r.sources) map[s.source] = s
        lastBySource = map
      })
      .catch(() => {})
    apiJson<FxState>('/api/fx-refresh').then((r) => (fxState = r)).catch(() => {})
  })

  async function runSource(key: string, path: string) {
    statuses[key] = { state: 'syncing' }
    try {
      const r = await apiJson<SourceResult>(path, { method: 'POST', body: {} })
      if (r.ok === false) {
        statuses[key] = r.not_configured
          ? { state: 'off', message: r.message ?? 'not set up' }
          : { state: 'failed', message: r.message ?? 'failed' }
      } else {
        statuses[key] = { state: 'done', result: r }
      }
    } catch (e) {
      statuses[key] = { state: 'failed', message: e instanceof Error ? e.message : 'failed' }
    }
  }

  async function refreshFx() {
    fxRefreshing = true
    try {
      fxState = await apiJson<FxState>('/api/fx-refresh', { method: 'POST', body: {} })
    } catch {}
    fxRefreshing = false
  }

  async function runAll() {
    ran = true
    await Promise.all([...SOURCES.map((s) => runSource(s.key, s.path)), refreshFx()])
    accounts.load(true)
  }

  const anyRunning = $derived(Object.values(statuses).some((s) => s.state === 'syncing'))

  // Relative, calendar-honest: "today" means the same calendar day, not
  // "within 24 hours".
  function fmtLast(iso: string): string {
    const d = new Date(iso)
    const mins = Math.round((Date.now() - d.getTime()) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    const today = new Date()
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const days = Math.round((day(today) - day(d)) / 86400000)
    if (days === 0) return 'today'
    if (days === 1) return 'yesterday'
    return `${days} days ago`
  }

  function summary(r: SourceResult): string {
    if (r.flagged.length > 0) return ''
    if (r.summary) return r.summary
    const parts: string[] = []
    if (r.inserted > 0) parts.push(`${r.inserted} new`)
    if ((r.claimed ?? 0) > 0) parts.push(`${r.claimed} matched to existing`)
    return parts.length > 0 ? parts.join(' · ') : 'up to date'
  }

  // Flagged rows are money the sync REFUSED to insert (dated before the
  // reconciled boundary) - a count alone once hid a 66.02 EUR charge, so the
  // rows themselves are one tap away.
  let showFlagged = $state<Record<string, boolean>>({})

  function flaggedLine(f: FlaggedRow): string {
    const acct = accounts.byId(f.account_id)
    const amount = fmtCents(f.amount_cents, acct?.currency ?? 'USD')
    return `${f.date} · ${amount} · ${f.description}`
  }

</script>

<div class="page">
  <section class="card">
    {#each SOURCES as s (s.key)}
      {@const st = statuses[s.key]}
      <div class="row">
        <span class="name">{s.label}</span>
        <span class="status">
          {#if !st}
            {@const last = lastBySource[s.key]}
            <span class="idle">
              {#if last}
                synced {fmtLast(last.synced_at)}{last.summary ? ` · ${last.summary}` : ''}
              {:else}
                never synced
              {/if}
            </span>
          {:else if st.state === 'syncing'}
            <span class="spinner" aria-label="Syncing"></span>
          {:else if st.state === 'done'}
            {@const text = summary(st.result)}
            {#if text}<span class="ok">{text}</span>{/if}
            {#each st.result.relink ?? [] as r (r.item)}
              <button class="auth" onclick={() => router.go(`/plaid-link/${r.item}`)}>Reconnect {r.institution}</button>
            {/each}
            {#if st.result.flagged.length > 0}
              <button
                class="flagged-toggle"
                onclick={() => (showFlagged[s.key] = !showFlagged[s.key])}
              >
                {st.result.flagged.length} flagged {showFlagged[s.key] ? '▾' : '▸'}
              </button>
            {/if}
          {:else if st.state === 'off'}
            <span class="idle">{st.message}</span>
          {:else}
            <span class="fail" title={st.message}>{st.message.slice(0, 60)}</span>
          {/if}
        </span>
      </div>
      {#if st?.state === 'done' && st.result.flagged.length > 0 && showFlagged[s.key]}
        <div class="flagged-detail">
          <p class="flagged-why">
            Not inserted: dated inside an already-reconciled period. If one of these is real, the
            account's checkpoint is stale - remove it and sync again.
          </p>
          {#each st.result.flagged as f}
            <div class="flagged-row">
              <span class="flagged-acct">{accounts.byId(f.account_id)?.display_name ?? f.account_id}</span>
              <span class="flagged-txn">{flaggedLine(f)}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/each}
  </section>

  {#if fxState?.fx_date}
    <section class="card fx-card">
      <div class="fx-header">
        <span class="name">Exchange rates</span>
        <span class="idle">{fxState.fx_date}</span>
      </div>
      <div class="fx-rates">
        {#each Object.entries(fxState.fx).filter(([k]) => k !== 'USD').sort(([a], [b]) => a.localeCompare(b)) as [cur, rate]}
          <div class="fx-row">
            <span class="fx-cur">{cur}</span>
            <span class="fx-rate">{(1 / rate).toFixed(4)}</span>
            <span class="fx-explain">per USD</span>
          </div>
        {/each}
      </div>
      {#if fxRefreshing}<span class="spinner fx-spin" aria-label="Refreshing rates"></span>{/if}
    </section>
  {/if}

  <button class="again" disabled={anyRunning} onclick={runAll}>
    {anyRunning ? 'Syncing...' : ran ? 'Sync again' : 'Start sync'}
  </button>
</div>

<style>
  .page {
    max-width: 620px;
    margin: 0 auto;
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px;
  }
  .row + .row,
  .flagged-detail + .row { border-top: 1px solid var(--border); }
  .name { font-size: 0.92rem; color: var(--text-primary); }
  .status { font-size: 0.8rem; display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; text-align: end; }
  .flagged-toggle {
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 0.76rem;
    font-weight: 500;
    color: var(--warn);
    border: 1px solid var(--warn);
    background: none;
  }
  .flagged-detail {
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .flagged-why {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--text-secondary);
  }
  .flagged-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 0.78rem;
  }
  .flagged-acct { color: var(--text-secondary); font-size: 0.72rem; }
  .flagged-txn { color: var(--text-primary); overflow-wrap: anywhere; }
  .ok { color: var(--ok); }
  .fail { color: var(--danger); }
  .idle { color: var(--text-secondary); }
  .auth {
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
    color: #fff;
    background: var(--warn);
  }
  .spinner {
    width: 15px;
    height: 15px;
    border: 2px solid var(--border);
    border-top-color: var(--accent-deep);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .again {
    align-self: center;
    padding: 9px 22px;
    border-radius: 999px;
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--accent-deep);
    border: 1px solid var(--accent);
    background: none;
  }
  .again:disabled { opacity: 0.5; }
  .fx-card { padding: 14px; }
  .fx-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .fx-rates { display: flex; flex-direction: column; gap: 4px; }
  .fx-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.84rem;
  }
  .fx-cur { font-weight: 500; width: 32px; color: var(--text-primary); }
  .fx-rate { font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .fx-explain { font-size: 0.74rem; color: var(--text-secondary); }
  .fx-spin { margin-top: 8px; }
</style>
