<script lang="ts">
  // Enter the balance the institution shows for a date; compare against the
  // computed running balance; lock on match (or deliberately, on mismatch).
  import { fetchAccountDetail, accounts } from '../lib/stores.svelte'
  import { fmtCents, parseCents } from '../lib/money'
  import { formatDate, localDateStr } from '$shared/lib/format'
  import { apiJson } from '../lib/api'
  import { toasts } from '$shared/lib/toast.svelte'
  import { router } from '../lib/router.svelte'
  import type { AccountDetail } from '../lib/types'
  import DateField from '../ui/DateField.svelte'

  let { id }: { id: string } = $props()

  let detail = $state<AccountDetail | null>(null)
  let date = $state(localDateStr())
  let entered = $state('')
  let saving = $state(false)

  let anchorInput = $state('')
  let savingAnchor = $state(false)

  $effect(() => {
    detail = null
    fetchAccountDetail(id).then((d) => {
      detail = d
      anchorInput = (d.anchor.balance_cents / 100).toFixed(2)
    })
  })

  const computed = $derived.by(() => {
    if (!detail) return 0
    let sum = detail.anchor.balance_cents
    for (const t of detail.transactions) {
      if (t.date >= detail.anchor.date && t.date <= date) sum += t.amount_cents
    }
    return sum
  })

  const enteredCents = $derived(parseCents(entered))
  const discrepancy = $derived(enteredCents === null ? null : enteredCents - computed)
  const canLock = $derived(enteredCents !== null && !saving && !!detail)
  const hasCheckpoints = $derived((detail?.checkpoints.length ?? 0) > 0)
  // The button says what it will do: a match reconciles, a mismatch is
  // recorded as an open investigation. No confirm step - both are safe.
  const mismatch = $derived(discrepancy !== null && discrepancy !== 0)

  async function lock() {
    if (enteredCents === null || !detail) return
    saving = true
    try {
      await apiJson('/api/checkpoints', {
        method: 'POST',
        body: { account_id: id, date, balance_cents: enteredCents },
      })
      accounts.load(true)
      // Pop back to the account we came from. go() would PUSH, leaving
      // account -> reconcile -> account on the stack and trapping the back
      // button in a reconcile/account ping-pong.
      router.back(`/account/${id}`)
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Lock failed')
    } finally {
      saving = false
    }
  }

  // The Visa/LoC/Wise exports carry no balance column, so their starting
  // balance can't be derived - but while it has never been deliberately set,
  // it can be solved for: whatever discrepancy the entered balance shows is
  // exactly what the anchor must absorb. Once the anchor HAS a source
  // (derived, manual, or a previous absorb), a discrepancy stops being an
  // anchor problem and starts being a ledger problem - missing or duplicate
  // transactions - so the absorb path is closed and the mismatch is surfaced.
  const anchorUnset = $derived(detail !== null && detail.anchor.source === null)

  async function absorbIntoAnchor() {
    if (discrepancy === null || discrepancy === 0 || !detail || !anchorUnset) return
    const cents = detail.anchor.balance_cents + discrepancy
    savingAnchor = true
    try {
      await apiJson(`/api/anchors/${id}`, {
        method: 'PUT',
        body: { date: detail.anchor.date, balance_cents: cents, source: 'absorbed' },
      })
      detail = { ...detail, anchor: { ...detail.anchor, balance_cents: cents, source: 'absorbed' } }
      anchorInput = (cents / 100).toFixed(2)
      accounts.load(true)
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      savingAnchor = false
    }
  }

  async function saveAnchor() {
    const cents = parseCents(anchorInput)
    if (cents === null || !detail) return
    savingAnchor = true
    try {
      await apiJson(`/api/anchors/${id}`, {
        method: 'PUT',
        body: { date: detail.anchor.date, balance_cents: cents },
      })
      detail = { ...detail, anchor: { ...detail.anchor, balance_cents: cents } }
      accounts.load(true)
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      savingAnchor = false
    }
  }
</script>

<div class="page">
  {#if !detail}
    <p class="empty">Loading...</p>
  {:else}
    <section class="card form">
      <h2>{detail.account.display_name}</h2>

      <div class="field">
        <span>Balance date</span>
        <DateField bind:value={date} max={localDateStr()} min={detail.anchor.date} />
      </div>

      <label class="field">
        <span>Balance at {detail.account.institution || 'the bank'}</span>
        <input
          type="text"
          inputmode="decimal"
          placeholder="0.00"
          bind:value={entered}
        />
      </label>

      <div class="compare num">
        <div class="line">
          <span>Ledger says</span>
          <span>{fmtCents(computed, detail.account.currency)}</span>
        </div>
        {#if enteredCents !== null}
          <div class="line">
            <span>You see</span>
            <span>{fmtCents(enteredCents, detail.account.currency)}</span>
          </div>
          <div class="line result" class:match={discrepancy === 0} class:off={discrepancy !== 0}>
            {#if discrepancy === 0}
              <span>Match</span>
              <span>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              </span>
            {:else}
              <span>Off by</span>
              <span>{fmtCents(discrepancy ?? 0, detail.account.currency)}</span>
            {/if}
          </div>
        {/if}
      </div>

      {#if discrepancy !== null && discrepancy !== 0 && !hasCheckpoints}
        {#if anchorUnset}
          <button class="absorb-btn" disabled={savingAnchor} onclick={absorbIntoAnchor}>
            {savingAnchor ? 'Adjusting...' : 'Set starting balance so the ledger matches'}
          </button>
          <p class="hint">Moves the {fmtCents(discrepancy, detail.account.currency)} difference into the starting balance. Right when the ledger has every transaction and only the opening number was unknown.</p>
        {:else}
          <p class="hint mismatch-note">The starting balance is already set ({detail.anchor.source}), so this difference points at the ledger itself: transactions are likely missing or duplicated. Compare recent entries against the institution before locking anything.</p>
        {/if}
      {/if}

      <button class="lock-btn" class:warn={mismatch} disabled={!canLock} onclick={lock}>
        {#if saving}
          Saving...
        {:else if mismatch}
          Tag for investigation
        {:else}
          Reconcile up to {formatDate(date)}
        {/if}
      </button>
      <p class="hint">
        A matching balance reconciles the period. A mismatch is recorded as-is: the account shows
        "off by" until the missing transactions are found, and the flag clears itself the moment
        the numbers meet.
      </p>
    </section>

    <section class="card form">
      <h2>Starting balance</h2>
      <p class="hint top">
        The balance at the start of {formatDate(detail.anchor.date)}, before any imported transactions.
        {#if detail.anchor.source === 'derived'}Derived from the bank's own balance column.
        {:else if detail.anchor.source === 'absorbed'}Set by reconciling against a balance you entered.
        {:else if detail.anchor.source === 'manual'}Entered by hand.
        {:else}Not set yet.{/if}
      </p>
      {#if hasCheckpoints}
        <p class="locked-note num">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z"/></svg>
          {fmtCents(detail.anchor.balance_cents, detail.account.currency)} - locked by a checkpoint
        </p>
      {:else}
        <div class="anchor-row">
          <input type="text" inputmode="decimal" bind:value={anchorInput} />
          <button class="save-btn" disabled={savingAnchor} onclick={saveAnchor}>{savingAnchor ? 'Saving...' : 'Save'}</button>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page { max-width: 620px; margin: 0 auto; padding: 16px 16px calc(var(--safe-bottom) + 28px); display: flex; flex-direction: column; gap: 16px; }
  .empty { text-align: center; color: var(--text-secondary); padding: 40px 12px; font-size: 0.9rem; }

  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 15px;
  }
  h2 { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }

  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .field span { font-size: 0.72rem; color: var(--text-secondary); letter-spacing: 0.02em; }
  input {
    font: inherit;
    font-variant-numeric: tabular-nums;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-surface);
    color: var(--text-primary);
    width: 100%;
  }
  input:focus { outline: 2px solid var(--accent-light); outline-offset: -1px; border-color: var(--accent-light); }

  .compare { border-top: 1px solid var(--border); padding-top: 10px; margin-bottom: 14px; }
  .line { display: flex; justify-content: space-between; font-size: 0.84rem; color: var(--text-secondary); padding: 3px 0; }
  .line span:last-child { color: var(--text-primary); font-weight: 500; }
  .result { margin-top: 4px; padding-top: 7px; border-top: 1px dashed var(--border); font-weight: 500; }
  .result.match, .result.match span { color: var(--ok); }
  .result.off, .result.off span:last-child { color: var(--danger); }

  .absorb-btn {
    width: 100%;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--bg-surface);
    border: 1px solid var(--accent);
    color: var(--accent-deep);
    font-size: 0.9rem;
    font-weight: 500;
    margin-bottom: 4px;
  }
  .absorb-btn:disabled { opacity: 0.45; }
  .mismatch-note { color: var(--danger); margin-bottom: 12px; }

  .lock-btn {
    width: 100%;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--accent-deep);
    color: #fff;
    font-size: 0.9rem;
    font-weight: 500;
    transition: background 0.15s;
  }
  .lock-btn:disabled { opacity: 0.45; }
  .lock-btn.warn { background: var(--danger); }
  .hint { font-size: 0.7rem; color: var(--text-secondary); margin-top: 8px; line-height: 1.45; }
  .hint.top { margin: -6px 0 10px; }

  .anchor-row { display: flex; gap: 8px; }
  .save-btn {
    padding: 0 18px;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 500;
    flex: none;
  }
  .save-btn:disabled { opacity: 0.45; }
  .locked-note { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-secondary); }
</style>
