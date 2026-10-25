<script lang="ts">
  import { fetchAccountDetail, accounts, displayCurrency } from '../lib/stores.svelte'
  import { fmtCents, fmtAmount, convertCents } from '../lib/money'
  import { formatDate } from '$shared/lib/format'
  import { router } from '../lib/router.svelte'
  import { apiJson } from '../lib/api'
  import { toasts } from '$shared/lib/toast.svelte'
  import TxSheet from './TxSheet.svelte'
  import ImportSheet from './ImportSheet.svelte'
  import { ImportTracker } from '../lib/import-job.svelte'
  import { merchantDisplay, type AccountDetail, type Tx } from '../lib/types'

  let { id }: { id: string } = $props()

  let detail = $state<AccountDetail | null>(null)
  let failed = $state(false)
  let filterMode = $state<'all' | 'auto' | 'uncategorized'>('all')
  let sheetTx = $state<Tx | null>(null)
  let importing = $state(false)
  // A screenshot import reads on the server; this follows it even with the
  // sheet closed, and after the app was left and reopened.
  const tracker = new ImportTracker()
  $effect(() => {
    tracker.watch(id)
    return () => tracker.stop()
  })

  function load() {
    fetchAccountDetail(id).then(
      (d) => (detail = d),
      () => (failed = true)
    )
  }

  $effect(() => {
    detail = null
    failed = false
    load()
  })

  // decided automatically = merchant or category came from the
  // auto-categorizer, not a person - the list to skim for mistakes.
  const isAuto = (t: Tx) =>
    t.merchant_source === 'auto' || t.merchant_source === 'proposed' || (t.category_auto === 1 && t.category_id !== null)
  const autoCount = $derived(detail ? detail.transactions.filter(isAuto).length : 0)
  // An old-style merchant proposal nobody confirmed (from before per-row
  // auto-categorizing) - still gets the one-tap confirm.
  const isProposal = (t: Tx) => t.merchant_id !== null && t.merchant_source === 'proposed'

  // needs categorization = resolves to no category and isn't a transfer -
  // whatever neither a person nor the auto-categorizer could place.
  const needsCategory = (t: Tx) => t.category_id === null && !t.is_transfer
  const uncategorizedCount = $derived(detail ? detail.transactions.filter(needsCategory).length : 0)

  // One tap on the row's check confirms the proposal in place - no sheet.
  // Optimistic: every row sharing the key flips at once, like the server.
  let confirmingKey = $state<string | null>(null)
  async function confirmProposal(t: Tx) {
    if (!t.merchant_key || t.merchant_id === null || confirmingKey) return
    confirmingKey = t.merchant_key
    try {
      await apiJson('/api/merchants/assign', {
        method: 'POST',
        body: { merchant_key: t.merchant_key, merchant_id: t.merchant_id },
      })
      for (const x of detail!.transactions) if (x.merchant_key === t.merchant_key) x.merchant_confirmed = 1
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Confirm failed')
    } finally {
      confirmingKey = null
    }
  }

  const balance = $derived.by(() => {
    if (!detail) return 0
    const txs = detail.transactions
    return txs.length ? txs[txs.length - 1].running_cents : detail.anchor.balance_cents
  })

  const lastCheckpoint = $derived(detail?.checkpoints.at(-1) ?? null)
  // Live discrepancy of the latest checkpoint: attested balance minus what
  // this ledger sums to at that date. Zero = verified; else open mismatch.
  const ckptDiscrepancy = $derived.by(() => {
    if (!detail || !lastCheckpoint) return 0
    let sum = detail.anchor.balance_cents
    for (const t of detail.transactions) {
      if (t.date >= detail.anchor.date && t.date <= lastCheckpoint.date) sum += t.amount_cents
    }
    return lastCheckpoint.balance_cents - sum
  })
  // The green seal means "everything in this ledger is verified" - a
  // checkpoint with newer transactions after it doesn't earn it.
  const fullyReconciled = $derived(
    lastCheckpoint !== null &&
      ckptDiscrepancy === 0 &&
      (detail!.transactions.length === 0 ||
        detail!.transactions[detail!.transactions.length - 1].date <= lastCheckpoint.date)
  )

  const conv = $derived.by(() => {
    if (!detail || detail.account.currency === displayCurrency.current) return ''
    const debt = detail.account.kind === 'credit_card' || detail.account.kind === 'line_of_credit'
    const c = convertCents(debt ? -balance : balance, detail.account.currency, displayCurrency.current, accounts.fx)
    return c === null ? '' : `${fmtCents(c, displayCurrency.current)} ${displayCurrency.current}`
  })

  // Newest first for reading; running balances were computed in ledger order.
  const rows = $derived.by(() => {
    if (!detail) return []
    const all = [...detail.transactions].reverse()
    if (filterMode === 'auto') return all.filter(isAuto)
    if (filterMode === 'uncategorized') return all.filter(needsCategory)
    return all
  })
</script>

<div class="page">
  {#if failed}
    <p class="empty">Couldn't load this account. Pull back and retry.</p>
  {:else if !detail}
    <p class="empty">Loading...</p>
  {:else}
    <section class="head card">
      {#if detail.account.kind === 'credit_card' || detail.account.kind === 'line_of_credit'}
        <span class="balance num">{fmtCents(-balance, detail.account.currency)}</span>
        <span class="meta">
          {detail.account.currency} owed
          {#if conv}<span class="dot-sep">·</span> {conv}{/if}
        </span>
      {:else}
        <span class="balance num">{fmtCents(balance, detail.account.currency)}</span>
        <span class="meta">
          {detail.account.currency}
          {#if conv}<span class="dot-sep">·</span> {conv}{/if}
        </span>
      {/if}
      <div class="recon-line">
        {#if lastCheckpoint && ckptDiscrepancy !== 0}
          <span class="seal-line warn-line">Off by {fmtCents(ckptDiscrepancy, detail.account.currency)} at {formatDate(lastCheckpoint.date)} · investigating</span>
        {:else if lastCheckpoint && fullyReconciled}
          <span class="seal-line ok-line">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            Reconciled to {formatDate(lastCheckpoint.date)}
          </span>
        {:else if lastCheckpoint}
          <span class="seal-line">Reconciled to {formatDate(lastCheckpoint.date)} · new activity since</span>
        {:else}
          <span class="seal-line">Never reconciled</span>
        {/if}
        <button class="recon-btn" onclick={() => (importing = true)}>Import</button>
        <button class="recon-btn" onclick={() => router.go(`/reconcile/${id}`)}>Reconcile</button>
      </div>
    </section>

    {#if tracker.job && !importing}
      {@const j = tracker.job}
      <button class="import-bar" class:ready={j.finished} onclick={() => (importing = true)}>
        {#if j.finished}
          <span>Screenshot read · tap to review</span>
        {:else}
          <span class="spinner" aria-hidden="true"></span>
          <span>Reading screenshot · {j.done} of {j.total}</span>
        {/if}
        <span class="chev">›</span>
      </button>
    {/if}

    {#if detail.transactions.length > 0 && (autoCount > 0 || uncategorizedCount > 0)}
      <div class="filter-row">
        <button class="filter" class:on={filterMode === 'all'} onclick={() => (filterMode = 'all')}>All</button>
        {#if autoCount > 0}
          <button class="filter" class:on={filterMode === 'auto'} onclick={() => (filterMode = 'auto')}>
            Auto ({autoCount})
          </button>
        {/if}
        {#if uncategorizedCount > 0}
          <button class="filter" class:on={filterMode === 'uncategorized'} onclick={() => (filterMode = 'uncategorized')}>
            Uncategorized ({uncategorizedCount})
          </button>
        {/if}
      </div>
    {/if}

    {#if rows.length === 0}
      <p class="empty">
        {filterMode === 'auto'
          ? 'Nothing here was decided automatically.'
          : filterMode === 'uncategorized'
            ? 'Everything here has a category.'
            : 'No transactions yet. Run the ingest CLI to fill this ledger.'}
      </p>
    {:else}
      <section class="ledger card">
        {#each rows as t (t.id)}
          <div class="tx">
            <button class="tx-main" onclick={() => (sheetTx = t)}>
              <span class="left">
                <span class="date num">
                  {#if t.locked}<svg class="lock" viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z"/></svg>{/if}
                  {formatDate(t.date).slice(0, 5)}
                </span>
                <span class="desc-col">
                  <span
                    class="desc"
                    class:proposed={isProposal(t)}
                    class:unknown={t.merchant_id === null}
                  >
                    {merchantDisplay(t)}{#if isProposal(t)}<span class="q">?</span>{/if}
                  </span>
                  {#if isProposal(t)}<span class="rawline">{t.description}</span>{/if}
                  {#if t.memo}<span class="memo">{t.memo}</span>{/if}
                  {#if !t.is_transfer}
                    <span class="cat" class:missing={t.category_id === null}>{t.category_name ?? 'Uncategorized'}{#if isAuto(t)}<span class="auto"> · auto</span>{/if}</span>
                  {/if}
                </span>
              </span>
              <span class="right">
                <span class="amount num" class:pos={t.amount_cents > 0}>{fmtAmount(t.amount_cents, detail.account.currency)}</span>
                <span class="running num">{fmtCents(t.running_cents, detail.account.currency)}</span>
              </span>
            </button>
            {#if isProposal(t)}
              <button
                class="ok-btn"
                aria-label="Confirm {merchantDisplay(t)}"
                disabled={confirmingKey !== null}
                onclick={() => confirmProposal(t)}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              </button>
            {/if}
          </div>
        {/each}
      </section>
      <p class="anchor-note num">
        Opened {formatDate(detail.anchor.date)} at {fmtCents(detail.anchor.balance_cents, detail.account.currency)}
      </p>
    {/if}

    {#if importing}
      <ImportSheet
        account={detail.account}
        {tracker}
        onclose={() => {
          importing = false
          tracker.refresh()
        }}
        ondone={() => {
          importing = false
          load()
          accounts.load(true)
        }}
      />
    {/if}

    {#if sheetTx}
      <TxSheet
        tx={sheetTx}
        accountId={id}
        currency={detail.account.currency}
        onclose={() => (sheetTx = null)}
        onchanged={() => {
          sheetTx = null
          load()
        }}
      />
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 620px; margin: 0 auto; padding: 16px 16px calc(var(--safe-bottom) + 28px); }
  .empty { text-align: center; color: var(--text-secondary); padding: 40px 12px; font-size: 0.9rem; line-height: 1.5; }

  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 22px 16px 14px;
    margin-bottom: 16px;
  }
  .balance { font-size: 2.1rem; font-weight: 550; color: var(--accent-deep); line-height: 1.1; }
  .meta { font-size: 0.75rem; color: var(--text-secondary); }
  .dot-sep { opacity: 0.5; }

  .recon-line {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    width: 100%;
    justify-content: center;
  }
  .seal-line { display: inline-flex; align-items: center; gap: 5px; font-size: 0.75rem; color: var(--text-secondary); }
  .ok-line { color: var(--ok); }
  .warn-line { color: var(--warn); font-weight: 500; }
  .recon-btn {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 14px;
    background: none;
  }
  .recon-btn:active { background: var(--accent-soft); }

  .ledger { overflow: hidden; }
  .tx { display: flex; align-items: stretch; }
  .tx + .tx { border-top: 1px solid var(--border); }
  .tx-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 13px;
    flex: 1;
    min-width: 0;
    text-align: start;
  }
  .tx-main:active { background: var(--bg-hover); }
  .ok-btn {
    flex: none;
    display: flex;
    align-items: center;
    padding: 0 14px;
    color: var(--ok);
    border-inline-start: 1px solid var(--border);
  }
  .ok-btn:active { background: var(--accent-soft); }
  .ok-btn:disabled { opacity: 0.4; }
  @media (hover: hover) {
    .tx-main:hover { background: var(--bg-hover); }
    .ok-btn:hover { background: var(--accent-soft); }
    .recon-btn:hover { background: var(--accent-soft); }
    .filter:not(.on):hover { background: var(--bg-hover); }
  }

  .import-bar {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    margin-top: 12px;
    padding: 10px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-raised);
    font-size: 0.82rem;
    color: var(--text-primary);
    text-align: start;
  }
  .import-bar.ready { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-deep); font-weight: 500; }
  .import-bar span:nth-last-child(2) { flex: 1; }
  .import-bar .chev { color: var(--text-secondary); }
  .spinner {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .filter-row { display: flex; gap: 7px; margin: 14px 0 10px; }
  .filter {
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    background: var(--bg-raised);
  }
  .filter.on { background: var(--accent-deep); border-color: var(--accent-deep); color: #fff; }

  /* Merchant states: proposed = the LLM's guess, visibly provisional (amber
     text + check button); unknown = nothing recognized yet, raw text at full
     strength with an amber dot - it needs eyes, not de-emphasis. */
  .desc.proposed { color: var(--warn); }
  .desc.unknown::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    margin-inline-end: 6px;
    vertical-align: middle;
  }
  .q { opacity: 0.7; margin-inline-start: 2px; }
  /* The raw statement text under a proposal - the evidence for the guess,
     so tap-tap-tap review never needs the sheet. */
  .rawline {
    font-size: 0.72rem;
    color: var(--text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .memo { font-size: 0.73rem; color: var(--accent); font-style: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
  .cat { font-size: 0.7rem; color: var(--text-secondary); display: block; }
  .cat.missing { color: var(--warn); }
  .auto { font-style: italic; opacity: 0.75; }
  .desc-col { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .left { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
  .date { font-size: 0.72rem; color: var(--text-secondary); flex: none; display: inline-flex; align-items: center; gap: 3px; }
  .lock { color: var(--accent-light); }
  .desc {
    font-size: 0.84rem;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .desc.unknown {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .right { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex: none; }
  .amount { font-size: 0.86rem; font-weight: 500; color: var(--text-primary); }
  .running { font-size: 0.68rem; color: var(--text-secondary); }

  .anchor-note { text-align: center; font-size: 0.7rem; color: var(--text-secondary); margin-top: 10px; opacity: 0.8; }
</style>
