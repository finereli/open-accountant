<script lang="ts">
  // One month of the fun allowance, for editing: its amount, the things
  // planned into it (toggled in/out, added, removed), and locking. Opened
  // from the Forecast screen's allowance section and the Fun plan screen.
  import { untrack } from 'svelte'
  import { apiJson } from '../lib/api'
  import { fmtCents, parseCents, type Currency } from '../lib/money'
  import { accounts } from '../lib/stores.svelte'
  import { monthName, lastDay, changedSinceLock, type AllowanceData, type MonthPlan, type PlanItem, type PlanSnapshot } from '../lib/allowance'
  import { formatDate } from '$shared/lib/format'
  import { toasts } from '$shared/lib/toast.svelte'
  import Sheet from '../ui/Sheet.svelte'
  import DateField from '../ui/DateField.svelte'

  let {
    plan,
    data,
    cur,
    conv,
    overCost,
    snapshot,
    ontoggle,
    reload,
    onclose,
  }: {
    plan: MonthPlan
    data: AllowanceData
    cur: string
    conv: (cents: number, currency: string) => number
    overCost: number // runway days the overage costs
    snapshot: () => PlanSnapshot
    ontoggle: (it: PlanItem) => void // optimistic, owned by the screen
    reload: () => Promise<void>
    onclose: () => void
  } = $props()

  const thisMonth = new Date().toISOString().slice(0, 7)
  // The form starts from the month's amount as it is when the sheet opens.
  const own = untrack(() => data.months.find((m) => m.month === plan.month) ?? data.default)
  let mAmount = $state(own ? String(own.amount_cents / 100) : '')
  let mCur = $state<Currency>((own?.currency ?? untrack(() => cur)) as Currency)
  let newName = $state('')
  let newAmount = $state('')
  let newDate = $state<string | null>(null)
  let saving = $state(false)

  async function act(fn: () => Promise<unknown>) {
    if (saving) return
    saving = true
    try {
      await fn()
      await reload()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }
  const saveAmount = () =>
    act(async () => {
      const c = parseCents(mAmount)
      if (c === null || c < 0) throw new Error('Amount must be a number')
      await apiJson(`/api/allowance/months/${plan.month}`, { method: 'PUT', body: { amount_cents: c, currency: mCur } })
    })
  const useDefault = () =>
    act(async () => {
      await apiJson(`/api/allowance/months/${plan.month}`, { method: 'PUT', body: { amount_cents: null } })
      if (data.default) mAmount = String(data.default.amount_cents / 100)
    })
  const addItem = () =>
    act(async () => {
      const c = parseCents(newAmount)
      if (!newName.trim() || c === null || c <= 0) throw new Error('Give it a name and an amount')
      await apiJson('/api/allowance/items', {
        method: 'POST',
        body: { month: plan.month, name: newName.trim(), amount_cents: c, currency: mCur, date: newDate },
      })
      newName = ''
      newAmount = ''
      newDate = null
    })
  const removeItem = (it: PlanItem) => act(() => apiJson(`/api/allowance/items/${it.id}`, { method: 'DELETE' }))
  const lock = (on: boolean) =>
    act(() => apiJson(`/api/allowance/months/${plan.month}`, { method: 'POST', body: { locked: on, snapshot: on ? snapshot() : null } }))
</script>

<Sheet {onclose} tall>
  <span class="sheet-title">{monthName(plan.month)} allowance{plan.month === thisMonth ? ' · rest of month' : ''}</span>
  <div class="line">
    <input class="input amt" type="text" inputmode="decimal" placeholder="Allowance" bind:value={mAmount} />
    {#each accounts.currencies as c (c)}
      <button class="chip" class:on={mCur === c} onclick={() => (mCur = c)}>{c}</button>
    {/each}
    <button class="btn" disabled={saving || !mAmount.trim()} onclick={saveAmount}>Set</button>
  </div>
  {#if plan.custom && data.default && !plan.locked_at}
    <button class="linkish" onclick={useDefault}>
      Use the default ({fmtCents(conv(data.default.amount_cents, data.default.currency), cur, { whole: true })})
    </button>
  {/if}

  <p class="hint">
    Planned {fmtCents(plan.planned, cur, { whole: true })} of {fmtCents(plan.allowance, cur, { whole: true })}
    {#if plan.over > 0}
      · <span class="over">over by {fmtCents(plan.over, cur, { whole: true })}, about {overCost}
        {overCost === 1 ? 'day' : 'days'} of runway</span>
    {:else}
      · {fmtCents(plan.left, cur, { whole: true })} left
    {/if}
  </p>

  <div class="plan-list">
    {#each plan.items as it (it.id)}
      <div class="plan-item" class:off={!it.active}>
        <button class="chip" class:on={!!it.active} onclick={() => ontoggle(it)}>{it.active ? 'in' : 'out'}</button>
        <span class="name">{it.name}{#if it.date}<span class="muted">· {formatDate(it.date)}</span>{/if}</span>
        <span class="amt num">{fmtCents(conv(it.amount_cents, it.currency), cur, { whole: true })}</span>
        <button class="x" aria-label="Remove {it.name}" disabled={saving} onclick={() => removeItem(it)}>×</button>
      </div>
    {/each}
    {#if plan.items.length === 0}<p class="hint pad">Nothing planned yet - what would be fun this month?</p>{/if}
  </div>

  <div class="line">
    <input class="input amt" type="text" placeholder="Dinner out, a course..." bind:value={newName} />
    <input class="input mid" type="text" inputmode="decimal" placeholder="Amount ({mCur})" bind:value={newAmount} />
  </div>
  <div class="line">
    <DateField bind:value={newDate} min="{plan.month}-01" max={lastDay(plan.month)} placeholder="Any day" />
    <span class="spacer"></span>
    <button class="btn" disabled={saving || !newName.trim() || !newAmount.trim()} onclick={addItem}>Add</button>
  </div>

  <div class="line lock-line">
    {#if plan.locked_at}
      <span class="hint">Locked {formatDate(plan.locked_at.slice(0, 10))}{changedSinceLock(plan, data) ? ' · changed since' : ''}</span>
      <span class="spacer"></span>
      <button class="btn" disabled={saving} onclick={() => lock(false)}>Unlock</button>
    {:else}
      <span class="hint">Lock when it feels right - that's what the month gets compared against.</span>
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving} onclick={() => lock(true)}>Lock plan</button>
    {/if}
  </div>
</Sheet>

<style>
  .sheet-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .hint { font-size: 0.74rem; color: var(--text-secondary); line-height: 1.5; margin: 0; }
  .hint.pad { padding: 10px 12px; }
  .line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .input {
    font: inherit;
    font-size: 0.85rem;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-surface);
    color: var(--text-primary);
    width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-light); outline-offset: -1px; }
  .input.amt { flex: 1; width: auto; min-width: 90px; }
  .input.mid { width: 130px; padding: 6px 8px; }
  .chip {
    font-size: 0.74rem;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); font-weight: 600; }
  .btn {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .btn { white-space: nowrap; }
  .btn:disabled { opacity: 0.4; }
  .btn.primary { color: #fff; background: var(--accent-deep); border-color: var(--accent-deep); }
  .linkish { align-self: flex-start; font-size: 0.76rem; color: var(--accent); padding: 0; }
  .over { color: var(--warn); }
  .muted { color: var(--text-secondary); font-size: 0.74rem; margin-inline-start: 0.35em; }
  .plan-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); }
  .plan-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; min-width: 0; }
  .plan-item + .plan-item { border-top: 1px solid var(--border); }
  .name { flex: 1; min-width: 0; font-size: 0.85rem; color: var(--text-primary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .amt { flex: none; font-size: 0.82rem; color: var(--text-primary); }
  .plan-item.off .name, .plan-item.off .amt { color: var(--text-secondary); text-decoration: line-through; }
  .x { flex: none; width: 26px; height: 26px; border-radius: 50%; color: var(--text-secondary); font-size: 1.05rem; line-height: 1; }
  .lock-line { border-top: 1px solid var(--border); padding-top: 10px; flex-wrap: nowrap; }
</style>
