<script lang="ts">
  import { accounts, displayCurrency } from '../lib/stores.svelte'
  import { convertCents, fmtCents } from '../lib/money'
  import { formatDate } from '$shared/lib/format'
  import { router } from '../lib/router.svelte'
  import type { AccountSummary } from '../lib/types'

  const cur = $derived(displayCurrency.current)


  // Cash is what you plan with; debt is context. The headline sums only
  // cash-kind accounts, and debt lives in its own quiet section below.
  const isDebt = (a: AccountSummary) => a.kind === 'credit_card' || a.kind === 'line_of_credit'

  const total = $derived.by(() => {
    let sum = 0
    for (const a of accounts.list) {
      if (isDebt(a)) continue
      const c = convertCents(a.balance_cents, a.currency, cur, accounts.fx)
      if (c !== null) sum += c
    }
    return sum
  })

  const debtTotal = $derived.by(() => {
    let sum = 0
    for (const a of accounts.list) {
      if (!isDebt(a)) continue
      const c = convertCents(a.balance_cents, a.currency, cur, accounts.fx)
      if (c !== null) sum += -c
    }
    return sum
  })

  // Dormant = holding nothing right now (no data, or a zero balance). They
  // stay reachable but collapsed - the dashboard is for money that exists.
  const isDormant = (a: AccountSummary) => a.balance_cents === 0

  const groups = $derived.by(() => {
    // One group per institution, split by owner when there's more than one
    // person, in account order. Debt and dormant accounts live below.
    const owners = new Set(accounts.list.map((a) => a.owner || ''))
    const titleOf = (a: AccountSummary) =>
      [owners.size > 1 ? a.owner : '', a.institution || 'Accounts'].filter(Boolean).join(' · ')
    const titles = [...new Set(accounts.list.map(titleOf))]
    return titles
      .map((t) => ({ title: t, items: accounts.list.filter((a) => titleOf(a) === t && !isDebt(a) && !isDormant(a)) }))
      .filter((g) => g.items.length > 0)
  })

  const debtAccounts = $derived(accounts.list.filter((a) => isDebt(a) && !isDormant(a)))
  const dormantAccounts = $derived(accounts.list.filter(isDormant))
  let dormantOpen = $state(false)

  function converted(a: AccountSummary): string {
    if (a.currency === cur) return ''
    const c = convertCents(a.balance_cents, a.currency, cur, accounts.fx)
    return c === null ? '' : fmtCents(c, cur)
  }

  const hasData = (a: AccountSummary) => a.tx_count > 0 || a.anchor_cents !== 0
</script>

<div class="page">
  {#if accounts.loading}
    <p class="loading">Loading accounts...</p>
  {:else}
    <section class="total-block">
      <span class="label">Cash, in {cur}</span>
      <span class="figure num">{fmtCents(total, cur)}</span>
      <div class="pills" role="group" aria-label="Display currency">
        {#each accounts.currencies as c}
          <button class="pill" class:on={c === cur} onclick={() => displayCurrency.set(c)}>{c}</button>
        {/each}
      </div>
      <button class="sync" onclick={() => router.go('/sync')}>Sync</button>
    </section>

    {#each groups as g}
      <section class="group">
        <h2>{g.title}</h2>
        <div class="card">
          {#each g.items as a (a.id)}
            <button class="row" class:dim={!hasData(a)} onclick={() => router.go(`/account/${a.id}`)}>
              <span class="who">
                <span class="name">{a.display_name}</span>
                <span class="sub">
                  {#if a.checkpoint && a.checkpoint.discrepancy_cents !== 0}
                    <span class="mismatch">off by {fmtCents(a.checkpoint.discrepancy_cents, a.currency)} since {formatDate(a.checkpoint.date)}</span>
                  {:else if a.checkpoint && (!a.last_date || a.last_date <= a.checkpoint.date)}
                    <svg class="seal" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    {formatDate(a.checkpoint.date)}
                  {:else if a.checkpoint}
                    reconciled to {formatDate(a.checkpoint.date)} · new since
                  {:else if hasData(a)}
                    not reconciled
                  {:else}
                    no data
                  {/if}
                </span>
              </span>
              <span class="money">
                <span class="native num">{fmtCents(a.balance_cents, a.currency)}</span>
                {#if converted(a)}<span class="conv num">{converted(a)}</span>{/if}
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/each}

    {#if debtAccounts.length > 0}
      <section class="group debt">
        <h2>Debt <span class="debt-total num">{fmtCents(debtTotal, cur)}</span></h2>
        <div class="card">
          {#each debtAccounts as a (a.id)}
            <button class="row dim" onclick={() => router.go(`/account/${a.id}`)}>
              <span class="who">
                <span class="name">{a.display_name}</span>
                <span class="sub">
                  {#if a.checkpoint && a.checkpoint.discrepancy_cents !== 0}
                    <span class="mismatch">off by {fmtCents(a.checkpoint.discrepancy_cents, a.currency)} since {formatDate(a.checkpoint.date)}</span>
                  {:else if a.checkpoint && (!a.last_date || a.last_date <= a.checkpoint.date)}
                    <svg class="seal" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    {formatDate(a.checkpoint.date)}
                  {:else if a.checkpoint}
                    reconciled to {formatDate(a.checkpoint.date)} · new since
                  {:else}
                    not reconciled
                  {/if}
                </span>
              </span>
              <span class="money">
                <span class="native num">{fmtCents(-a.balance_cents, a.currency)}</span>
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if dormantAccounts.length > 0}
      <section class="group dormant">
        <button class="dormant-toggle" onclick={() => (dormantOpen = !dormantOpen)}>
          <svg class="chev" class:open={dormantOpen} viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
          Dormant ({dormantAccounts.length})
        </button>
        {#if dormantOpen}
          <div class="card">
            {#each dormantAccounts as a (a.id)}
              <button class="row dim" onclick={() => router.go(`/account/${a.id}`)}>
                <span class="who">
                  <span class="name">{a.display_name}</span>
                  <span class="sub">{a.tx_count > 0 ? `${a.tx_count} transactions` : 'no data'}</span>
                </span>
                <span class="money">
                  <span class="native num">{fmtCents(0, a.currency)}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if accounts.fxDate}
      <p class="fx-note">Rates from {formatDate(accounts.fxDate)}</p>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 620px; margin: 0 auto; padding: 18px 16px calc(var(--safe-bottom) + 28px); }
  .loading { text-align: center; color: var(--text-secondary); padding: 48px 0; font-size: 0.9rem; }

  .total-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 22px 0 26px;
  }
  .label {
    font-size: 0.72rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .figure {
    font-size: 2.6rem;
    font-weight: 550;
    color: var(--accent-deep);
    line-height: 1.1;
  }
  .pills { display: flex; gap: 6px; margin-top: 10px; }
  .pill {
    padding: 5px 14px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    background: var(--bg-raised);
    transition: background 0.15s, color 0.15s;
  }
  .pill.on { background: var(--accent-deep); border-color: var(--accent-deep); color: #fff; }

  .sync {
    margin-top: 12px;
    padding: 6px 16px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--accent-deep);
    border: 1px solid var(--accent);
    background: none;
  }
  .sync:disabled { opacity: 0.5; }

  .group { margin-bottom: 18px; }
  h2 {
    font-size: 0.72rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-secondary);
    font-weight: 600;
    margin: 0 4px 7px;
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
    width: 100%;
    padding: 13px 14px;
    text-align: start;
  }
  .row + .row { border-top: 1px solid var(--border); }
  .row:active { background: var(--bg-hover); }
  @media (hover: hover) {
    .row:hover { background: var(--bg-hover); }
  }
  .row.dim .name, .row.dim .native { color: var(--text-secondary); opacity: 0.7; }

  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .name { font-size: 0.92rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { display: inline-flex; align-items: center; gap: 4px; font-size: 0.7rem; color: var(--text-secondary); }
  .seal { color: var(--ok); }
  .mismatch { color: var(--warn, #b45309); font-weight: 500; }

  .money { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; }
  .native { font-size: 0.95rem; font-weight: 550; color: var(--text-primary); }
  .conv { font-size: 0.7rem; color: var(--text-secondary); }

  .fx-note { text-align: center; font-size: 0.68rem; color: var(--text-secondary); opacity: 0.7; margin-top: 6px; }

  /* Debt is context, not the headline: smaller, quieter, positive numbers. */
  .debt { margin-top: 28px; }
  .debt h2 { display: flex; justify-content: space-between; align-items: baseline; }
  .debt-total { font-size: 0.72rem; font-weight: 500; color: var(--text-secondary); text-transform: none; letter-spacing: 0; }
  .debt .name { font-size: 0.84rem; color: var(--text-secondary); }
  .debt .native { font-size: 0.86rem; font-weight: 500; color: var(--text-secondary); }

  .dormant { margin-top: 18px; }
  .dormant-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.72rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-secondary);
    font-weight: 600;
    padding: 4px;
    margin-bottom: 7px;
  }
  .chev { transition: transform 0.15s; }
  .chev.open { transform: rotate(90deg); }
  .dormant .name { font-size: 0.84rem; color: var(--text-secondary); }
  .dormant .native { font-size: 0.84rem; color: var(--text-secondary); opacity: 0.6; }
</style>
