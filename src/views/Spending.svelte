<script lang="ts">
  // One month of income and spending per category, across every in-spending
  // account, converted to the display currency. Categories expand to their
  // merchant breakdown; a merchant row expands to category chips, so this
  // screen doubles as the category editor - Uncategorized is the extraction
  // worklist, pinned last with its transaction count.
  import { apiJson } from '../lib/api'
  import { accounts, displayCurrency } from '../lib/stores.svelte'
  import { convertCents, fmtCents } from '../lib/money'
  import { toasts } from '$shared/lib/toast.svelte'
  import { formatDate } from '$shared/lib/format'
  import type { SpendingResponse, SpendingRow, SpendingTxn, Category } from '../lib/types'

  const cur = $derived(displayCurrency.current)

  const now = new Date()
  const CURRENT = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  // The earliest month any ledger covers.
  const FIRST = $derived(
    accounts.list.reduce((m, a) => (a.anchor_date > '0000-01-01' && a.anchor_date.slice(0, 7) < m ? a.anchor_date.slice(0, 7) : m), CURRENT)
  )
  let month = $state(CURRENT)
  let data = $state<SpendingResponse | null>(null)
  let expanded = $state<Record<string, boolean>>({})
  // The expanded merchant line: primary content is its transactions; the
  // category switch hides behind a button (moving is rarer than looking).
  let openMerchant = $state<string | null>(null)
  let txns = $state<Record<string, SpendingTxn[]>>({})
  let showChips = $state(false)
  let newCat = $state('')
  let saving = $state(false)

  $effect(() => {
    const m = month
    apiJson<SpendingResponse>(`/api/spending?month=${m}`)
      .then((r) => {
        if (month === m) data = r
      })
      .catch((e) => toasts.error(e instanceof Error ? e.message : 'Load failed'))
  })

  function shift(delta: number) {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (next >= FIRST && next <= CURRENT) {
      data = null
      expanded = {}
      openMerchant = null
      showChips = false
      txns = {}
      month = next
    }
  }

  // Categories are per transaction, so one merchant can show up under
  // several categories: a line is (category, merchant).
  const mkey = (g: { key: string }, m: { merchant_id: number | null; label: string }) =>
    `${g.key}|${m.merchant_id === null ? `d:${m.label}` : `m:${m.merchant_id}`}`

  async function toggleMerchant(g: { key: string; category: Category | null }, m: { merchant_id: number | null; label: string }) {
    const key = mkey(g, m)
    showChips = false
    if (openMerchant === key) {
      openMerchant = null
      return
    }
    openMerchant = key
    if (!txns[key]) {
      const q =
        (m.merchant_id !== null ? `merchant_id=${m.merchant_id}` : `label=${encodeURIComponent(m.label)}`) +
        `&category_id=${g.category?.id ?? 'none'}`
      try {
        const r = await apiJson<{ transactions: SpendingTxn[] }>(`/api/spending-txns?month=${month}&${q}`)
        txns[key] = r.transactions
      } catch (e) {
        toasts.error(e instanceof Error ? e.message : 'Load failed')
      }
    }
  }
  const monthLabel = $derived(
    new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1).toLocaleDateString('en', {
      month: 'long',
      year: 'numeric',
    })
  )

  const conv = (r: SpendingRow) => convertCents(r.total_cents, r.currency, cur, accounts.fx) ?? 0

  // Expenses are the norm on this screen, so they stay plain text with a
  // minus; money in (income, refunds, repayments) gets a + and a calm blue.
  const acc = (cents: number, c: string) => (cents > 0 ? '+' : '') + fmtCents(cents, c)

  interface CatGroup {
    key: string
    category: Category | null // null = Uncategorized
    total: number
    count: number
    merchants: Array<{ merchant_id: number | null; label: string; total: number; count: number }>
  }

  // Debt-flow categories feed the summary blocks, not the category list.
  const isDebtFlow = (c: Category | null) => c?.name === 'Debt Repay' || c?.name === 'Debt Borrow'

  const groups = $derived.by((): { income: CatGroup[]; expense: CatGroup[]; excluded: CatGroup[] } => {
    if (!data) return { income: [], expense: [], excluded: [] }
    const byCat = new Map<string, CatGroup>()
    const catById = new Map(data.categories.map((c) => [c.id, c]))
    for (const r of data.rows) {
      const cat = r.category_id === null ? null : (catById.get(r.category_id) ?? null)
      const key = cat ? String(cat.id) : 'uncat'
      let g = byCat.get(key)
      if (!g) byCat.set(key, (g = { key, category: cat, total: 0, count: 0, merchants: [] }))
      const c = conv(r)
      g.total += c
      g.count += r.count
      // One merchant can arrive as several rows (per currency); merge.
      const mkey = r.merchant_id === null ? `d:${r.label}` : `m:${r.merchant_id}`
      const existing = g.merchants.find((m) => (m.merchant_id === null ? `d:${m.label}` : `m:${m.merchant_id}`) === mkey)
      if (existing) {
        existing.total += c
        existing.count += r.count
      } else {
        g.merchants.push({ merchant_id: r.merchant_id, label: r.label, total: c, count: r.count })
      }
    }
    for (const g of byCat.values()) g.merchants.sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    const all = [...byCat.values()]
    const bySort = (a: CatGroup, b: CatGroup) => (a.category?.sort ?? 0) - (b.category?.sort ?? 0)
    const income = all.filter((g) => g.category?.kind === 'income').sort(bySort)
    const excluded = all.filter((g) => g.category?.kind === 'excluded' && !isDebtFlow(g.category)).sort(bySort)
    const expense = all
      .filter((g) => g.category !== null && g.category.kind === 'expense')
      .sort(bySort)
      .concat(all.filter((g) => g.category === null)) // Uncategorized pinned last
    return { income, expense, excluded }
  })

  // The two-section footer: cash movement (income / expenses / net over cash
  // accounts) and debt (new debt taken on, repaid, net change). Debt-account
  // activity counts as new debt, not cash expense; the repay/borrow transfer
  // legs bridge the two. Positive debt net = debt grew.
  const summary = $derived.by(() => {
    if (!data) return null
    const catById = new Map(data.categories.map((c) => [c.id, c]))
    let income = 0
    let expense = 0
    let charges = 0
    let borrowed = 0
    let repaid = 0
    for (const r of data.rows) {
      const c = r.category_id === null ? null : (catById.get(r.category_id) ?? null)
      const v = conv(r)
      if (c?.name === 'Debt Repay') repaid += -v
      else if (c?.name === 'Debt Borrow') borrowed += v
      else if (c?.kind === 'excluded') continue // Transfers: pure movement
      else if (r.debt) charges += v
      else if (c?.kind === 'income') income += v
      else expense += v
    }
    const newDebt = -charges + borrowed
    return { income, expense, cashNet: income + expense, newDebt, repaid, debtNet: newDebt - repaid }
  })

  const pickableCats = $derived(data?.categories.filter((c) => c.kind !== 'excluded') ?? [])

  async function assign(merchantId: number, categoryId: number | null) {
    if (saving) return
    saving = true
    try {
      await apiJson('/api/merchants/category', {
        method: 'POST',
        body: { merchant_id: merchantId, category_id: categoryId },
      })
      showChips = false
      openMerchant = null
      txns = {}
      data = await apiJson<SpendingResponse>(`/api/spending?month=${month}`)
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Move failed')
    } finally {
      saving = false
    }
  }

  async function createAndAssign(merchantId: number) {
    const name = newCat.trim()
    if (!name || saving) return
    saving = true
    try {
      const r = await apiJson<{ id: number }>('/api/categories', { method: 'POST', body: { name } })
      newCat = ''
      saving = false
      await assign(merchantId, r.id)
    } catch (e) {
      saving = false
      toasts.error(e instanceof Error ? e.message : 'Create failed')
    }
  }
</script>

{#snippet catBlock(g: CatGroup, muted: boolean)}
  <div class="cat" class:muted>
    <button class="cat-row" onclick={() => (expanded[g.key] = !expanded[g.key])}>
      <span class="cat-name">{g.category?.name ?? 'Uncategorized'}</span>
      {#if g.category === null}<span class="cat-count num">{g.count} txns</span>{/if}
      <span class="cat-total num" class:pos={g.total > 0}>{acc(g.total, cur)}</span>
    </button>
    {#if expanded[g.key]}
      <div class="merchants">
        {#each g.merchants as m (mkey(g, m))}
          <button class="m-row" onclick={() => toggleMerchant(g, m)}>
            <span class="m-label">{m.label}</span>
            <span class="m-count num">{m.count}</span>
            <span class="m-total num" class:pos={m.total > 0}>{acc(m.total, cur)}</span>
          </button>
          {#if openMerchant === mkey(g, m)}
            <div class="txn-list">
              {#each txns[mkey(g, m)] ?? [] as t (t.id)}
                <div class="txn-row">
                  <div class="txn-main">
                    <span class="txn-desc">{t.description}</span>
                    <span class="txn-amt num" class:pos={t.amount_cents > 0}>{acc(t.amount_cents, t.currency)}</span>
                  </div>
                  <span class="txn-facts num">
                    {formatDate(t.date)} · {t.account_name}{t.memo ? ` · ${t.memo}` : ''}
                  </span>
                </div>
              {:else}
                <span class="txn-facts">Loading...</span>
              {/each}
              {#if m.merchant_id !== null}
                <button class="chips-toggle" onclick={() => (showChips = !showChips)}>
                  {showChips ? 'Hide' : 'Change category'}
                </button>
                {#if showChips}
                  <div class="chips">
                    {#each pickableCats as c (c.id)}
                      <button
                        class="chip"
                        class:on={c.id === (g.category?.id ?? null)}
                        disabled={saving}
                        onclick={() => assign(m.merchant_id!, c.id)}
                      >
                        {c.name}
                      </button>
                    {/each}
                    <button class="chip" class:on={g.category === null} disabled={saving} onclick={() => assign(m.merchant_id!, null)}>
                      Uncategorized
                    </button>
                    <span class="new-cat">
                      <input
                        class="new-input"
                        type="text"
                        placeholder="New category..."
                        bind:value={newCat}
                        onkeydown={(e) => e.key === 'Enter' && createAndAssign(m.merchant_id!)}
                      />
                      {#if newCat.trim()}
                        <button class="chip create" disabled={saving} onclick={() => createAndAssign(m.merchant_id!)}>Add</button>
                      {/if}
                    </span>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="page">
  <div class="pager">
    <button class="arrow" disabled={month <= FIRST} onclick={() => shift(-1)}>◂</button>
    <span class="month">{monthLabel}</span>
    <button class="arrow" disabled={month >= CURRENT} onclick={() => shift(1)}>▸</button>
    <span class="spacer"></span>
    <div class="pills" role="group" aria-label="Display currency">
      {#each accounts.currencies as c (c)}
        <button class="pill" class:on={c === cur} onclick={() => displayCurrency.set(c)}>{c}</button>
      {/each}
    </div>
  </div>

  {#if !data}
    <p class="empty">Loading...</p>
  {:else if groups.income.length === 0 && groups.expense.length === 0}
    <p class="empty">No activity in {monthLabel}.</p>
  {:else}
    <section class="card">
      {#each groups.income as g (g.key)}{@render catBlock(g, false)}{/each}
      {#each groups.expense as g (g.key)}{@render catBlock(g, false)}{/each}
      {#if summary}
        <div class="sum-block">
          <span class="sum-title">Cash</span>
          <div class="sum-line"><span>Income</span><span class="num" class:pos={summary.income > 0}>{acc(summary.income, cur)}</span></div>
          <div class="sum-line"><span>Expenses</span><span class="num">{acc(summary.expense, cur)}</span></div>
          <div class="sum-line net">
            <span>Net</span>
            <span class="num" class:pos={summary.cashNet > 0}>{acc(summary.cashNet, cur)}</span>
          </div>
        </div>
        <div class="sum-block">
          <span class="sum-title">Debt</span>
          <div class="sum-line"><span>New debt</span><span class="num">{acc(summary.newDebt, cur)}</span></div>
          <div class="sum-line"><span>Repaid</span><span class="num" class:pos={summary.repaid > 0}>{acc(summary.repaid, cur)}</span></div>
          <div class="sum-line net">
            <span>Net {summary.debtNet > 0 ? '(debt grew)' : summary.debtNet < 0 ? '(debt shrank)' : ''}</span>
            <span class="num" class:pos={summary.debtNet < 0}>{acc(summary.debtNet, cur)}</span>
          </div>
        </div>
      {/if}
      {#each groups.excluded as g (g.key)}{@render catBlock(g, true)}{/each}
    </section>
    {#if accounts.fxDate}
      <p class="fx-note">Converted at current rates</p>
    {/if}
  {/if}
</div>

<style>
  .page {
    max-width: 620px;
    margin: 0 auto;
    padding: 14px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .pager { display: flex; align-items: center; gap: 8px; }
  .arrow {
    font-size: 1rem;
    color: var(--accent);
    padding: 6px 10px;
    border-radius: 8px;
  }
  .arrow:disabled { opacity: 0.25; }
  .month { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); min-width: 118px; text-align: center; }
  .spacer { flex: 1; }
  .pills { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
  .pill { font-size: 0.72rem; padding: 5px 9px; color: var(--text-secondary); }
  .pill.on { background: var(--accent-soft); color: var(--accent-deep); font-weight: 600; }

  .empty { text-align: center; color: var(--text-secondary); font-size: 0.85rem; padding: 40px 0; }

  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .cat + .cat { border-top: 1px solid var(--border); }
  .cat.muted { opacity: 0.55; }
  .cat-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 12px 14px;
    text-align: start;
  }
  .cat-row:active { background: var(--bg-hover); }
  .cat-name { font-size: 0.9rem; color: var(--text-primary); flex: 1; }
  .cat-count { font-size: 0.72rem; color: var(--text-secondary); }
  .cat-total { font-size: 0.9rem; color: var(--text-primary); font-weight: 500; }

  .merchants { padding: 0 0 6px; background: var(--bg-surface); }
  .m-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 14px 8px 24px;
    text-align: start;
  }
  .m-row:active:not(:disabled) { background: var(--bg-hover); }
  .m-label {
    flex: 1;
    font-size: 0.82rem;
    color: var(--text-primary);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .m-count { font-size: 0.7rem; color: var(--text-secondary); }
  .m-total { font-size: 0.8rem; color: var(--text-secondary); }

  .txn-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 4px 14px 10px 32px;
  }
  .txn-row { display: flex; flex-direction: column; gap: 1px; }
  .txn-main { display: flex; justify-content: space-between; gap: 10px; }
  .txn-desc {
    font-size: 0.76rem;
    color: var(--text-primary);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .txn-amt { font-size: 0.76rem; color: var(--text-primary); flex: none; }
  .txn-facts { font-size: 0.68rem; color: var(--text-secondary); }
  .chips-toggle {
    align-self: flex-start;
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 11px;
    background: none;
    margin-top: 2px;
  }
  .chips-toggle:active { background: var(--accent-soft); }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 2px;
    align-items: center;
  }
  .chip {
    font-size: 0.76rem;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); font-weight: 600; }
  .chip.create { color: var(--accent); font-weight: 500; }
  .chip:active { background: var(--accent-soft); }
  .new-cat { display: inline-flex; align-items: center; gap: 6px; }
  .new-input {
    font: inherit;
    font-size: 0.76rem;
    padding: 5px 10px;
    border: 1px dashed var(--border);
    border-radius: 999px;
    background: none;
    color: var(--text-primary);
    width: 120px;
  }
  .new-input:focus { outline: 2px solid var(--accent-light); outline-offset: -1px; }

  .sum-block {
    border-top: 1px solid var(--border);
    padding: 10px 14px 12px;
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sum-title {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .sum-line {
    display: flex;
    justify-content: space-between;
    font-size: 0.84rem;
    color: var(--text-secondary);
  }
  .sum-line.net { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); }
  .fx-note { text-align: center; font-size: 0.68rem; color: var(--text-secondary); opacity: 0.7; }
  /* Money in: calm steel blue, deliberately not the ok-green or danger-red. */
  .pos { color: #35679e; }

  @media (hover: hover) {
    .cat-row:hover, .m-row:hover:not(:disabled) { background: var(--bg-hover); }
    .chip:hover { border-color: var(--accent); }
  }
</style>
