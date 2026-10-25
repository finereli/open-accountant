<script lang="ts">
  // One transaction, two independent decisions: who (merchant) and what for
  // (category). Both arrive filled in by the auto-categorizer; tapping one
  // opens its picker, and a pick applies to this transaction at once. Only
  // then does the sheet offer the wider scope ("all 12 like this") and a
  // "why" that becomes a rule - correcting one row is the common case, and
  // teaching is optional. Closing is always safe.
  import { apiJson } from '../lib/api'
  import { toasts } from '$shared/lib/toast.svelte'
  import { formatDate } from '$shared/lib/format'
  import { fmtAmount } from '../lib/money'
  import { accounts } from '../lib/stores.svelte'
  import { untrack } from 'svelte'
  import Sheet from '../ui/Sheet.svelte'
  import { merchantDisplay, type Tx, type Merchant, type Category } from '../lib/types'

  let {
    tx: initial,
    accountId,
    currency,
    onclose,
    onchanged,
  }: {
    tx: Tx
    accountId: string
    currency: string
    onclose: () => void
    onchanged: () => void
  } = $props()

  // The sheet is mounted per transaction; it keeps its own copy, refreshed
  // from the server after each change.
  let tx = $state<Tx>(untrack(() => ({ ...initial })))
  let merchants = $state<Merchant[]>([])
  let categories = $state<Category[]>([])
  let similarCount = $state(0)
  let ready = $state(false)
  let open = $state<'merchant' | 'category' | null>(null)
  let query = $state('')
  let saving = $state(false)
  let changed = $state(false)
  // What the last pick could be widened to, and the "why" box under it.
  let after = $state<
    | { kind: 'merchant'; body: Record<string, unknown>; label: string }
    | { kind: 'category'; categoryId: number; label: string }
    | null
  >(null)
  let widened = $state(false)
  let why = $state('')
  let whySaved = $state(false)
  let memo = $state(untrack(() => initial.memo ?? ''))

  $effect(() => {
    const key = untrack(() => tx.merchant_key) // once per sheet, not per refresh
    Promise.all([
      apiJson<{ merchants: Merchant[] }>('/api/merchants').then((r) => (merchants = r.merchants)),
      apiJson<{ categories: Category[] }>('/api/categories').then((r) => (categories = r.categories)),
      key
        ? apiJson<{ transactions: unknown[] }>(`/api/merchants/similar?merchant_key=${encodeURIComponent(key)}`
          ).then((r) => (similarCount = r.transactions.length))
        : Promise.resolve(),
    ])
      .catch(() => {})
      .finally(() => (ready = true))
  })

  async function refresh() {
    const r = await apiJson<{ transaction: Tx }>(`/api/transactions/${tx.id}`)
    tx = { ...r.transaction, running_cents: tx.running_cents }
  }

  async function run(fn: () => Promise<unknown>) {
    if (saving) return false
    saving = true
    try {
      await fn()
      changed = true
      await refresh()
      return true
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
      return false
    } finally {
      saving = false
    }
  }

  function close() {
    saveMemo()
    if (changed) onchanged()
    else onclose()
  }

  // --- merchant -----------------------------------------------------------
  const display = (m: Merchant) => m.household_name ?? m.concept ?? '?'
  const pickable = $derived(merchants.filter((m) => m.household_name !== null || m.concept !== null))
  const q = $derived(query.trim().toLowerCase())
  const filtered = $derived(
    (q ? pickable.filter((m) => display(m).toLowerCase().includes(q)) : pickable)
      .slice()
      .sort((a, b) => b.tx_count - a.tx_count)
      .slice(0, 40)
  )
  const transferRows = $derived(
    accounts.list
      .filter((a) => a.id !== accountId && a.tx_count > 0)
      .map((a) => ({ account: a.id, label: `Transfer: ${a.display_name}` }))
      .filter((t) => !q || t.label.toLowerCase().includes(q))
  )
  const exactMatch = $derived(!q || pickable.some((m) => display(m).toLowerCase() === q))
  // Others sharing this bank description - what "all like this" covers.
  const others = $derived(Math.max(similarCount - 1, 0))

  async function pickMerchant(what: Record<string, unknown>, label: string) {
    open = null
    query = ''
    // A description seen once: name it for good, so its next visit is
    // recognized. Seen before: this row now, the rest only if asked.
    const applyAll = others === 0
    const base = { merchant_key: tx.merchant_key, transaction_id: tx.id }
    let picked: number | null = null
    const ok = await run(async () => {
      const r = await apiJson<{ merchant_id: number }>('/api/merchants/assign', {
        method: 'POST',
        body: { ...base, ...what, apply_all: applyAll },
      })
      picked = r.merchant_id
    })
    if (ok && picked !== null) {
      // Widening reuses the merchant just picked (or created) by id, so a
      // new name is never created twice.
      after = { kind: 'merchant', body: { ...base, merchant_id: picked }, label }
      widened = applyAll
      why = ''
      whySaved = false
    }
  }

  async function widenMerchant() {
    const a = after
    if (a?.kind !== 'merchant') return
    if (await run(() => apiJson('/api/merchants/assign', { method: 'POST', body: { ...a.body, apply_all: true } })))
      widened = true
  }

  const merchantToAuto = () =>
    run(() =>
      apiJson('/api/merchants/unassign', {
        method: 'POST',
        body: tx.merchant_override ? { transaction_id: tx.id } : { merchant_key: tx.merchant_key },
      })
    ).then(() => (after = null))

  // --- category -----------------------------------------------------------
  const pickableCats = $derived(categories.filter((c) => c.kind !== 'excluded'))
  // "All of <merchant>" needs a named merchant that isn't a transfer.
  const namedMerchant = $derived(
    tx.merchant_id !== null && !tx.is_transfer && (tx.merchant_name !== null || tx.merchant_concept !== null)
  )

  async function pickCategory(c: Category) {
    open = null
    const ok = await run(() =>
      apiJson('/api/transactions/category', { method: 'POST', body: { transaction_id: tx.id, category_id: c.id } })
    )
    if (ok) {
      after = { kind: 'category', categoryId: c.id, label: c.name }
      widened = false
      why = ''
      whySaved = false
    }
  }

  async function widenCategory() {
    const a = after
    if (a?.kind !== 'category') return
    const body = { merchant_id: tx.merchant_id, category_id: a.categoryId, transaction_id: tx.id }
    if (await run(() => apiJson('/api/merchants/category', { method: 'POST', body }))) widened = true
  }

  const categoryToAuto = () =>
    run(() =>
      apiJson('/api/transactions/category', { method: 'POST', body: { transaction_id: tx.id, category_id: null } })
    ).then(() => (after = null))

  // --- teaching and notes -------------------------------------------------
  async function saveWhy() {
    const text = why.trim()
    if (!text || saving) return
    saving = true
    try {
      await apiJson('/api/rules', { method: 'POST', body: { text } })
      whySaved = true
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Rule save failed')
    } finally {
      saving = false
    }
  }

  async function saveMemo() {
    const text = memo.trim() || null
    if (text === (tx.memo ?? null)) return
    try {
      await apiJson('/api/transactions/memo', { method: 'POST', body: { transaction_id: tx.id, memo: text } })
      tx.memo = text
      changed = true
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Note save failed')
    }
  }
</script>

<Sheet onclose={close} tall={open !== null}>
  <div class="context">
    <span class="raw">{tx.description}</span>
    <span class="facts num">{formatDate(tx.date)} · {fmtAmount(tx.amount_cents, currency)}</span>
  </div>

  {#if ready}
    <div class="fields">
      <button class="field" class:active={open === 'merchant'} onclick={() => (open = open === 'merchant' ? null : 'merchant')}>
        <span class="f-label">Merchant</span>
        <span class="f-value" class:none={tx.merchant_id === null}>
          {tx.merchant_id === null ? 'Unknown' : merchantDisplay(tx)}
        </span>
        {#if tx.merchant_source === 'auto' || tx.merchant_source === 'proposed'}<span class="auto">auto</span>{/if}
        <span class="chev">›</span>
      </button>

      {#if open === 'merchant'}
        <div class="picker">
          <!-- svelte-ignore a11y_autofocus -->
          <input class="search" type="search" placeholder="Search or create..." autofocus bind:value={query} />
          <div class="list">
            {#if q && !exactMatch}
              <button class="option create" disabled={saving} onclick={() => pickMerchant({ new_merchant: { household_name: query.trim() } }, query.trim())}>
                Create “{query.trim()}”
              </button>
            {/if}
            {#each filtered as m (m.id)}
              <button
                class="option"
                class:on={m.id === tx.merchant_id}
                disabled={saving}
                onclick={() => pickMerchant({ merchant_id: m.id }, display(m))}
              >
                <span>{display(m)}</span>
                <span class="count num">{m.tx_count}</span>
              </button>
            {/each}
            {#each transferRows as t (t.account)}
              <button class="option xfer" disabled={saving} onclick={() => pickMerchant({ transfer_account_id: t.account }, t.label)}>
                {t.label}
              </button>
            {/each}
            <button class="option keep" disabled={saving} onclick={() => pickMerchant({ keep_description: true }, tx.description)}>
              <span class="keep-text">Keep the bank's description</span>
            </button>
          </div>
          {#if tx.merchant_source === 'human'}
            <button class="link" disabled={saving} onclick={merchantToAuto}>Back to automatic</button>
          {/if}
        </div>
      {/if}

      {#if !tx.is_transfer}
        <button class="field" class:active={open === 'category'} onclick={() => (open = open === 'category' ? null : 'category')}>
          <span class="f-label">Category</span>
          <span class="f-value" class:none={tx.category_id === null}>{tx.category_name ?? 'Uncategorized'}</span>
          {#if tx.category_auto && tx.category_id !== null}<span class="auto">auto</span>{/if}
          <span class="chev">›</span>
        </button>

        {#if open === 'category'}
          <div class="picker">
            <div class="chips">
              {#each pickableCats as c (c.id)}
                <button class="chip" class:on={c.id === tx.category_id} disabled={saving} onclick={() => pickCategory(c)}>
                  {c.name}
                </button>
              {/each}
            </div>
            {#if tx.category_row}
              <button class="link" disabled={saving} onclick={categoryToAuto}>Back to automatic</button>
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    {#if after && open === null}
      <div class="after">
        {#if after.kind === 'merchant' && others > 0}
          {#if widened}
            <span class="done">All {others + 1} with this description are now {after.label}.</span>
          {:else}
            <button class="wide" disabled={saving} onclick={widenMerchant}>
              Also the {others} other{others === 1 ? '' : 's'} with this description
            </button>
          {/if}
        {:else if after.kind === 'category' && namedMerchant}
          {#if widened}
            <span class="done">Every {merchantDisplay(tx)} transaction is now {after.label}.</span>
          {:else}
            <button class="wide" disabled={saving} onclick={widenCategory}>Always {after.label} for {merchantDisplay(tx)}</button>
          {/if}
        {/if}
        {#if whySaved}
          <span class="done">Saved as a rule.</span>
        {:else}
          <div class="why">
            <input
              class="why-input"
              type="text"
              placeholder="Why? (optional - becomes a rule)"
              bind:value={why}
              onkeydown={(e) => e.key === 'Enter' && saveWhy()}
            />
            {#if why.trim()}<button class="btn" disabled={saving} onclick={saveWhy}>Save</button>{/if}
          </div>
        {/if}
      </div>
    {/if}

    <input
      class="memo"
      type="text"
      placeholder="Add a note..."
      bind:value={memo}
      onblur={saveMemo}
      onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  {/if}
</Sheet>

<style>
  .context { display: flex; flex-direction: column; gap: 3px; }
  .raw { font-size: 0.9rem; color: var(--text-primary); font-weight: 500; word-break: break-word; }
  .facts { font-size: 0.78rem; color: var(--text-secondary); }

  .fields {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    flex: none;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    text-align: start;
    background: var(--bg-raised);
  }
  .field + .field, .picker + .field { border-top: 1px solid var(--border); }
  .field.active { background: var(--accent-soft); }
  .field:active { background: var(--bg-hover); }
  .f-label { font-size: 0.76rem; color: var(--text-secondary); width: 68px; flex: none; }
  .f-value { flex: 1; min-width: 0; font-size: 0.92rem; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .f-value.none { color: var(--warn); font-weight: 400; }
  .auto { font-size: 0.68rem; font-style: italic; color: var(--text-secondary); flex: none; }
  .chev { color: var(--text-secondary); flex: none; }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
  }
  .search {
    font: inherit;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-raised);
    color: var(--text-primary);
    width: 100%;
  }
  .search:focus, .memo:focus, .why-input:focus { outline: 2px solid var(--accent-light); outline-offset: -1px; }
  .list {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-raised);
    max-height: 38dvh;
    overflow-y: auto;
  }
  .option {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    font-size: 0.88rem;
    color: var(--text-primary);
    text-align: start;
  }
  .option + .option { border-top: 1px solid var(--border); }
  .option:active { background: var(--bg-hover); }
  .option.on { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
  .option.create { color: var(--accent); font-weight: 500; }
  /* Transfers are structural, not spending - indigo sets them apart. */
  .option.xfer { color: #4a5a9e; }
  .keep-text { font-size: 0.82rem; color: var(--text-secondary); }
  .count { font-size: 0.75rem; color: var(--text-secondary); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-size: 0.82rem;
    padding: 7px 13px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); font-weight: 600; }
  .chip:active { background: var(--accent-soft); }
  .link {
    align-self: flex-start;
    font-size: 0.8rem;
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 2px 0;
  }

  .after { display: flex; flex-direction: column; gap: 8px; }
  .wide {
    align-self: flex-start;
    font-size: 0.84rem;
    font-weight: 500;
    color: var(--accent-deep);
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 7px 14px;
  }
  .done { font-size: 0.8rem; color: var(--text-secondary); }
  .why { display: flex; gap: 8px; }
  .why-input, .memo {
    font: inherit;
    font-size: 0.85rem;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-surface);
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
  }
  .btn {
    font-size: 0.82rem;
    font-weight: 500;
    color: #fff;
    background: var(--accent-deep);
    border-radius: 8px;
    padding: 7px 14px;
  }
  button:disabled { opacity: 0.5; }

  @media (hover: hover) {
    .field:hover, .option:hover { background: var(--bg-hover); }
    .option.on:hover { background: var(--accent-soft); }
  }
</style>
