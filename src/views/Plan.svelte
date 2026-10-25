<script lang="ts">
  // The fun plan, all of it at once: every month's allowance with the things
  // planned into it, toggles in reach, what's left or over, and what the plan
  // does to the runway. The amounts are set here or in the Forecast screen's
  // allowance section; editing a month opens the same sheet as there.
  import { apiJson } from '../lib/api'
  import { accounts, displayCurrency } from '../lib/stores.svelte'
  import { convertCents, fmtCents } from '../lib/money'
  import { cashStart, burnLines, baseItems, type BurnInput, type SubInput, type ExpectedInput } from '../lib/forecast'
  import {
    monthPlans,
    monthsBetween,
    runwayDays,
    overCostDays,
    snapshotFor,
    fmtRunway,
    monthName,
    RUNWAY_DAYS,
    type AllowanceData,
    type PlanItem,
  } from '../lib/allowance'
  import { formatDate } from '$shared/lib/format'
  import { toasts } from '$shared/lib/toast.svelte'
  import AllowanceSheet from './AllowanceSheet.svelte'

  // This month plus three ahead - as far as plans can honestly see, and
  // the same reach as the forecast's default 3-month view.
  const MONTHS_SHOWN = 4
  const cur = $derived(displayCurrency.current)
  const conv = (cents: number, from: string) => convertCents(cents, from, cur, accounts.fx) ?? 0

  // Same measured window the Forecast screen uses, so the runway agrees.
  const windowDays = (() => {
    try {
      return Number(localStorage.getItem('accountant.fc.window')) || 60
    } catch {
      return 60
    }
  })()

  let forecast = $state<{ days: number; burn: BurnInput[]; subs: SubInput[]; items: ExpectedInput[] } | null>(null)
  let data = $state<AllowanceData | null>(null)

  async function load() {
    const [f, a] = await Promise.all([
      apiJson<typeof forecast>(`/api/forecast?days=${windowDays}`),
      apiJson<AllowanceData>('/api/allowance'),
    ])
    forecast = f
    data = a
  }
  $effect(() => {
    load().catch((e) => toasts.error(e instanceof Error ? e.message : 'Load failed'))
  })

  const today = new Date().toISOString().slice(0, 10)
  const thisMonth = today.slice(0, 7)
  const plans = $derived(
    data ? monthPlans(data, monthsBetween(today, new Date(Date.now() + RUNWAY_DAYS * 86400000).toISOString()), conv) : []
  )
  const shown = $derived(plans.slice(0, MONTHS_SHOWN))
  const baseline = $derived({
    start: cashStart(accounts.list, conv),
    daily: forecast ? burnLines(forecast.burn, forecast.days, conv).reduce((s, l) => s + l.daily, 0) : 0,
    items: forecast ? baseItems(forecast.items, forecast.subs, conv) : [],
    today,
  })
  const runway = $derived(forecast && data ? runwayDays(baseline, plans) : null)
  const totals = $derived({
    allowance: shown.reduce((s, p) => s + p.allowance, 0),
    planned: shown.reduce((s, p) => s + p.planned, 0),
    over: shown.reduce((s, p) => s + p.over, 0),
  })

  let openMonth = $state<string | null>(null)
  const open = $derived(openMonth ? (plans.find((p) => p.month === openMonth) ?? null) : null)

  // Toggling is the tinkering loop: flip it on screen first, revert on failure.
  async function toggle(it: PlanItem) {
    if (!data) return
    const was = it.active
    data.items = data.items.map((x) => (x.id === it.id ? { ...x, active: was ? 0 : 1 } : x))
    try {
      await apiJson(`/api/allowance/items/${it.id}`, { method: 'PATCH', body: { active: !was } })
    } catch (e) {
      data.items = data.items.map((x) => (x.id === it.id ? { ...x, active: was } : x))
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const whole = (c: number) => fmtCents(c, cur, { whole: true })
  const fill = (part: number, of: number) => (of > 0 ? Math.min(100, (part / of) * 100) : part > 0 ? 100 : 0)
</script>

<div class="page">
  <div class="bar">
    <span class="spacer"></span>
    <div class="pills" role="group" aria-label="Display currency">
      {#each accounts.currencies as c (c)}
        <button class="pill" class:on={c === cur} onclick={() => displayCurrency.set(c)}>{c}</button>
      {/each}
    </div>
  </div>

  {#if !data || !forecast}
    <p class="empty">Loading...</p>
  {:else}
    <section class="card hero">
      <div class="stat">
        <span class="label">Runway with this plan</span>
        <span class="big num">{fmtRunway(runway)}</span>
      </div>
      <div class="stat">
        <span class="label">Through {monthName(shown[shown.length - 1]?.month ?? thisMonth)}</span>
        <span class="mid num">{whole(totals.planned)} planned</span>
        <span class="of">of {whole(totals.allowance)} allowance</span>
        {#if totals.over > 0}<span class="over">{whole(totals.over)} over</span>{/if}
      </div>
    </section>

    {#each shown as p (p.month)}
      <section class="card month">
        <button class="head" onclick={() => (openMonth = p.month)}>
          <span class="m-name">{monthName(p.month)}{#if p.month === thisMonth}<span class="muted">· rest of month</span>{/if}</span>
          {#if p.locked_at}<span class="tag">locked</span>{/if}
          <span class="spacer"></span>
          <span class="m-amt num">{whole(p.allowance)}</span>
          <span class="chev">›</span>
        </button>
        <div class="meter" aria-hidden="true">
          <div class="meter-fill" class:over={p.over > 0} style="width: {fill(p.planned, p.allowance)}%"></div>
        </div>
        <div class="sum">
          {#if p.over > 0}
            <span class="over">over by {whole(p.over)} · about {overCostDays(baseline, plans, p)} days of runway</span>
          {:else if p.planned > 0}
            {whole(p.planned)} planned · {whole(p.left)} left
          {:else}
            {whole(p.left)} to plan
          {/if}
        </div>
        {#each p.items as it (it.id)}
          <div class="item" class:off={!it.active}>
            <button class="chip" class:on={!!it.active} onclick={() => toggle(it)}>{it.active ? 'in' : 'out'}</button>
            <span class="i-name">{it.name}{#if it.date}<span class="muted">· {formatDate(it.date)}</span>{/if}</span>
            <span class="i-amt num">{whole(conv(it.amount_cents, it.currency))}</span>
          </div>
        {/each}
        <button class="add" onclick={() => (openMonth = p.month)}>
          {p.items.length === 0 ? 'Nothing planned yet - plan something' : '+ Plan something'}
        </button>
      </section>
    {/each}

    <p class="note">
      The allowance is already in the forecast, so planning inside it costs nothing extra; only going over does. Amounts:
      tap a month, or the default in Forecast.
    </p>
  {/if}
</div>

{#if open && data}
  <AllowanceSheet
    plan={open}
    {data}
    {cur}
    {conv}
    overCost={overCostDays(baseline, plans, open)}
    snapshot={() => snapshotFor(baseline, plans, open!, data!, cur, conv)}
    ontoggle={toggle}
    reload={load}
    onclose={() => (openMonth = null)}
  />
{/if}

<style>
  .page { max-width: 620px; margin: 0 auto; padding: 14px 16px calc(var(--safe-bottom) + 28px); display: flex; flex-direction: column; gap: 12px; }
  .bar { display: flex; align-items: center; }
  .spacer { flex: 1; }
  .pills { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
  .pill { font-size: 0.74rem; padding: 5px 11px; color: var(--text-secondary); }
  .pill.on { background: var(--accent-soft); color: var(--accent-deep); font-weight: 600; }
  .empty { text-align: center; color: var(--text-secondary); padding: 40px 12px; font-size: 0.9rem; }
  .card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); }
  .hero { display: flex; gap: 14px; padding: 14px 15px; }
  .stat { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .label { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-secondary); }
  .big { font-size: 1.5rem; font-weight: 600; color: var(--accent-deep); line-height: 1.2; }
  .mid { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); line-height: 1.4; }
  .of { font-size: 0.78rem; font-weight: 400; color: var(--text-secondary); }
  .over { color: var(--warn); font-size: 0.76rem; }

  .month { overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 14px 8px; text-align: start; }
  .m-name { font-size: 0.98rem; font-weight: 600; color: var(--text-primary); }
  .m-amt { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); }
  .chev { color: var(--text-secondary); font-size: 1.1rem; }
  .tag { font-size: 0.64rem; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent-deep); }
  .muted { color: var(--text-secondary); font-size: 0.74rem; font-weight: 400; margin-inline-start: 0.35em; }
  .meter { height: 6px; margin: 0 14px; border-radius: 3px; background: var(--border); overflow: hidden; }
  .meter-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.25s; }
  .meter-fill.over { background: var(--warn); }
  .sum { padding: 6px 14px 8px; font-size: 0.76rem; color: var(--text-secondary); }
  .item { display: flex; align-items: center; gap: 9px; padding: 8px 14px; border-top: 1px solid var(--border); min-width: 0; }
  .item.off .i-name, .item.off .i-amt { color: var(--text-secondary); text-decoration: line-through; }
  .i-name { flex: 1; min-width: 0; font-size: 0.86rem; color: var(--text-primary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .i-amt { flex: none; font-size: 0.84rem; color: var(--text-primary); }
  .chip {
    flex: none;
    font-size: 0.72rem;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    background: var(--bg-raised);
  }
  .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); font-weight: 600; }
  .add { display: block; width: 100%; padding: 10px 14px; border-top: 1px solid var(--border); text-align: start; font-size: 0.8rem; color: var(--accent); }
  .note { margin: 2px 2px 0; font-size: 0.72rem; line-height: 1.5; color: var(--text-secondary); }
  @media (hover: hover) {
    .head:hover, .add:hover { background: var(--bg-hover); }
  }
</style>
