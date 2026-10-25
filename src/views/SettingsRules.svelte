<script lang="ts">
  // What the auto-categorizer knows about this household, in plain words:
  // the rules it reads on every run (who we are, how we file things, the
  // exceptions), and the corrections it has been shown. Category
  // descriptions live on the Categories screen. After changing rules, Re-run
  // applies them to history; people's own decisions are never touched.
  import { apiJson } from '../lib/api'
  import { toasts } from '$shared/lib/toast.svelte'
  import { formatDate } from '$shared/lib/format'
  import { fmtAmount } from '../lib/money'
  import DateField from '../ui/DateField.svelte'

  interface Rule {
    id: number
    text: string
    transaction_id: number | null
    tx_description: string | null
    tx_amount_cents: number | null
    tx_date: string | null
    tx_currency: string | null
    retired_at: string | null
    created_at: string
    use_count: number
    last_used: string | null
  }
  interface Correction {
    id: number
    field: 'merchant' | 'category'
    auto_value: string | null
    human_value: string | null
    scope: 'row' | 'all'
    description: string
    amount_cents: number
    date: string
    currency: string
  }

  let rules = $state<Rule[]>([])
  let corrections = $state<Correction[]>([])
  let queued = $state(0)
  let ready = $state(false)
  let editing = $state<number | null>(null)
  let editText = $state('')
  let newText = $state('')
  let saving = $state(false)
  let running = $state(false)
  let runLeft = $state<number | null>(null)
  let showRetired = $state(false)
  let rerunFrom = $state<string | null>(new Date().toISOString().slice(0, 8) + '01')

  const active = $derived(rules.filter((r) => !r.retired_at))
  const retired = $derived(rules.filter((r) => r.retired_at))

  const STALE_DAYS = 90
  const today = new Date().toISOString().slice(0, 10)
  const daysSince = (d: string) => Math.floor((Date.parse(today) - Date.parse(d)) / 86400000)
  function stale(r: Rule): boolean {
    const created = r.created_at.slice(0, 10)
    const ref = r.last_used ?? created
    return daysSince(ref) > STALE_DAYS
  }

  async function load() {
    const r = await apiJson<{ rules: Rule[]; corrections: Correction[]; queued: number }>('/api/rules')
    rules = r.rules
    corrections = r.corrections
    queued = r.queued
    ready = true
  }
  $effect(() => {
    load().catch((e) => toasts.error(e instanceof Error ? e.message : 'Load failed'))
  })

  async function mutate(fn: () => Promise<unknown>) {
    if (saving) return
    saving = true
    try {
      await fn()
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }

  function startEdit(r: Rule) {
    editing = editing === r.id ? null : r.id
    editText = r.text
  }
  const save = (r: Rule) =>
    mutate(async () => {
      await apiJson(`/api/rules/${r.id}`, { method: 'PATCH', body: { text: editText.trim() } })
      editing = null
    })
  const setRetired = (r: Rule, retired: boolean) =>
    mutate(async () => {
      await apiJson(`/api/rules/${r.id}`, { method: 'PATCH', body: { retired } })
      editing = null
    })
  const remove = (r: Rule) =>
    mutate(async () => {
      await apiJson(`/api/rules/${r.id}`, { method: 'DELETE' })
      editing = null
    })
  const add = () =>
    mutate(async () => {
      await apiJson('/api/rules', { method: 'POST', body: { text: newText.trim() } })
      newText = ''
    })

  // Re-run: everything back in the queue, then work it down a batch at a
  // time (each call classifies up to 100 rows) until nothing is left.
  async function rerun(from: string | null) {
    if (running) return
    running = true
    try {
      let body: Record<string, unknown> = from ? { requeue: from } : {}
      for (let i = 0; i < 40; i++) {
        const r = await apiJson<{ classify: { remaining: number; classified: number; ok: boolean; message?: string } }>(
          '/api/auto-categorize',
          { method: 'POST', body: { ...body, limit: 100 } }
        )
        body = {}
        if (!r.classify.ok) throw new Error(r.classify.message ?? 'Categorizer failed')
        runLeft = r.classify.remaining
        if (r.classify.remaining === 0 || r.classify.classified === 0) break
      }
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Re-run failed')
    } finally {
      running = false
      runLeft = null
    }
  }
</script>

<div class="page">
  <p class="intro">
    Transactions get their merchant and category automatically. These rules are what it knows about you; it
    reads them every time. Write them the way you'd explain it to a person.
  </p>

  <div class="card">
    {#each active as r (r.id)}
      {#if editing === r.id}
        <div class="editor">
          <textarea class="input" rows="3" bind:value={editText}></textarea>
          <div class="line">
            <button class="btn danger" disabled={saving} onclick={() => remove(r)}>Delete</button>
            <button class="btn" disabled={saving} onclick={() => setRetired(r, true)}>Retire</button>
            <span class="spacer"></span>
            <button class="btn primary" disabled={saving || !editText.trim() || editText.trim() === r.text} onclick={() => save(r)}>
              Save
            </button>
          </div>
        </div>
      {:else}
        <button class="rule" onclick={() => startEdit(r)}>
          {r.text}
          {#if r.tx_description}
            <span class="about">
              On {r.tx_date} · {r.tx_description} · {fmtAmount(r.tx_amount_cents ?? 0, r.tx_currency ?? 'USD')}
            </span>
          {/if}
          <span class="usage" class:stale={stale(r)}>
            {#if r.use_count > 0}
              Used on {r.use_count} · latest {formatDate(r.last_used!)}
            {:else}
              Not used yet
            {/if}
            {#if stale(r)} · nothing in {STALE_DAYS} days - still true?{/if}
          </span>
        </button>
      {/if}
    {/each}
    {#if ready && active.length === 0}<p class="hint pad">No rules yet.</p>{/if}
    {#if !ready}<p class="hint pad">Loading...</p>{/if}
    <div class="editor new">
      <textarea class="input" rows="2" placeholder="Add a rule, e.g. “Kam is a supermarket chain”" bind:value={newText}></textarea>
      {#if newText.trim()}
        <div class="line">
          <span class="spacer"></span>
          <button class="btn primary" disabled={saving} onclick={add}>Add rule</button>
        </div>
      {/if}
    </div>
  </div>

  {#if retired.length > 0}
    <button class="retired-toggle" onclick={() => (showRetired = !showRetired)}>
      Retired · {retired.length} <span class="chev">{showRetired ? '▾' : '▸'}</span>
    </button>
    {#if showRetired}
      <div class="card">
        {#each retired as r (r.id)}
          <div class="rule retired-rule">
            <span class="retired-text">{r.text}</span>
            <button class="btn" disabled={saving} onclick={() => setRetired(r, false)}>Restore</button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <p class="hint">
    Rules apply to transactions as they come in. To apply a change to ones already filed, re-run from a date -
    anything you set yourself stays as you set it.
  </p>
  <div class="run-line">
    <DateField bind:value={rerunFrom} />
    <button class="btn" disabled={running || !rerunFrom} onclick={() => rerun(rerunFrom)}>Re-run from this date</button>
    {#if running}
      <span class="hint inline">Working{runLeft !== null ? ` · ${runLeft} left` : '...'}</span>
    {:else if queued > 0}
      <button class="btn" onclick={() => rerun(null)}>Categorize {queued} waiting</button>
    {/if}
  </div>

  {#if corrections.length > 0}
    <h2 class="section-title">Corrections it learns from</h2>
    <div class="card">
      {#each corrections as c (c.id)}
        <div class="corr">
          <span class="corr-what">
            {c.field === 'merchant' ? 'Merchant' : 'Category'}
            <strong>{c.human_value ?? 'none'}</strong>{#if c.auto_value}<span class="was"> · was {c.auto_value}</span>{/if}{#if c.scope === 'all'}<span class="was"> · all similar</span>{/if}
          </span>
          <span class="corr-tx num">{formatDate(c.date)} · {c.description} · {fmtAmount(c.amount_cents, c.currency)}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 620px;
    margin: 0 auto;
    padding: 18px 16px calc(var(--safe-bottom) + 24px);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .intro { font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5; margin: 0 2px; }
  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .rule {
    display: block;
    width: 100%;
    padding: 11px 14px;
    text-align: start;
    font-size: 0.86rem;
    line-height: 1.45;
    color: var(--text-primary);
  }
  .about { display: block; margin-top: 3px; font-size: 0.72rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usage { display: block; margin-top: 3px; font-size: 0.7rem; color: var(--text-secondary); }
  .usage.stale { color: var(--warn); }
  .retired-toggle { align-self: flex-start; font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); margin: 6px 2px 0; }
  .retired-rule { display: flex; align-items: center; gap: 10px; }
  .retired-text { flex: 1; color: var(--text-secondary); }
  .rule + .rule, .editor + .rule, .rule + .editor, .editor + .editor { border-top: 1px solid var(--border); }
  .rule:active { background: var(--bg-hover); }
  .editor { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; background: var(--bg-surface); }
  .editor.new { background: none; }
  .input {
    font: inherit;
    font-size: 0.86rem;
    line-height: 1.45;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-raised);
    color: var(--text-primary);
    resize: vertical;
    width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-light); outline-offset: -1px; }
  .line { display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1; }
  .btn {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .btn:active { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.45; }
  .btn.primary { color: #fff; background: var(--accent-deep); border-color: var(--accent-deep); }
  .btn.danger { color: var(--danger); border-color: var(--danger); }
  .run-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .hint { font-size: 0.72rem; color: var(--text-secondary); line-height: 1.5; margin: 0 2px; }
  .hint.pad { padding: 10px 14px; margin: 0; }
  .hint.inline { margin: 0; }
  .section-title { font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); margin: 10px 2px 0; }
  .corr { display: flex; flex-direction: column; gap: 2px; padding: 9px 14px; }
  .corr + .corr { border-top: 1px solid var(--border); }
  .corr-what { font-size: 0.84rem; color: var(--text-primary); }
  .corr-what strong { font-weight: 600; }
  .was { color: var(--text-secondary); }
  .corr-tx { font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  @media (hover: hover) {
    .rule:hover { background: var(--bg-hover); }
    .btn:hover:not(:disabled) { background: var(--bg-hover); }
    .btn.primary:hover:not(:disabled) { background: var(--accent); }
  }
</style>
