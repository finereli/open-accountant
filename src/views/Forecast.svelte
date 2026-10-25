<script lang="ts">
  // The cash curve: today's trusted balances projected forward. Measured
  // inputs come from /api/forecast (trailing burn per run-rate category,
  // expected items); the projection is client-side (src/lib/forecast.ts) so
  // every edit redraws instantly. The headline is the low point.
  import { apiJson } from '../lib/api'
  import { accounts, displayCurrency } from '../lib/stores.svelte'
  import { convertCents, fmtCents, parseCents, type Currency } from '../lib/money'
  import { project, cashStart, burnLines as burnLines_, baseItems as baseItems_, type BurnLine } from '../lib/forecast'
  import {
    monthPlans,
    allowanceItems,
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
  import AllowanceSheet from './AllowanceSheet.svelte'
  import { toasts } from '$shared/lib/toast.svelte'
  import { formatDate } from '$shared/lib/format'
  import Sheet from '../ui/Sheet.svelte'
  import DateField from '../ui/DateField.svelte'

  const cur = $derived(displayCurrency.current)

  interface ExpectedItem {
    id: number
    name: string
    kind: 'income' | 'expense'
    amount_cents: number
    currency: string
    day_of_month: number | null
    date: string | null
    end_month: string | null
    end_date: string | null
    per_day: number
    account_id: string | null
    category_id: number | null
  }
  interface BurnRow {
    category_id: number
    name: string
    currency: string
    total_cents: number
    pinned_daily_cents: number | null
    pinned_currency: string | null
  }
  interface SubRow {
    merchant_id: number
    name: string
    currency: string
    monthly_cents: number
    day: number
    end_date: string | null
  }
  interface ForecastData {
    days: number
    burn: BurnRow[]
    subs: SubRow[]
    items: ExpectedItem[]
  }

  const HORIZONS = [
    { label: '3 mo', days: 91 },
    { label: '6 mo', days: 182 },
    { label: '12 mo', days: 365 },
  ]
  const readPref = (k: string, dflt: number) => {
    try {
      const v = Number(localStorage.getItem(k))
      return v > 0 ? v : dflt
    } catch {
      return dflt
    }
  }
  let horizonDays = $state(readPref('accountant.fc.horizon', 91))
  let windowDays = $state(readPref('accountant.fc.window', 60))
  const setPref = (k: string, v: number) => {
    try {
      localStorage.setItem(k, String(v))
    } catch {}
  }

  let data = $state<ForecastData | null>(null)
  let saving = $state(false)

  let allowance = $state<AllowanceData | null>(null)

  async function load() {
    const [d, a] = await Promise.all([
      apiJson<ForecastData>(`/api/forecast?days=${windowDays}`),
      apiJson<AllowanceData>('/api/allowance'),
    ])
    data = d
    allowance = a
  }
  $effect(() => {
    void windowDays
    load().catch((e) => toasts.error(e instanceof Error ? e.message : 'Load failed'))
  })

  const conv = (cents: number, from: string) => convertCents(cents, from, cur, accounts.fx) ?? 0

  const startCents = $derived(cashStart(accounts.list, conv))

  const burnLines = $derived(data ? burnLines_(data.burn, data.days, conv) : [])
  const totalDaily = $derived(burnLines.reduce((s, l) => s + l.daily, 0))

  const today = new Date().toISOString().slice(0, 10)
  const addDays = (iso: string, n: number) => {
    const d = new Date(iso + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }

  // The fun allowance: every month the projection covers (runway looks
  // further ahead, so plans run three years out).
  const plans = $derived(allowance ? monthPlans(allowance, monthsBetween(today, addDays(today, RUNWAY_DAYS)), conv) : [])
  const shownPlans = $derived(plans.filter((p) => p.month <= addDays(today, horizonDays).slice(0, 7)))

  const baseItems = $derived(data ? baseItems_(data.items, data.subs, conv) : [])
  const projection = $derived.by(() => {
    if (!data) return null
    return project(startCents, totalDaily, [...baseItems, ...allowanceItems(plans, today)], today, horizonDays)
  })

  const baseline = $derived({ start: startCents, daily: totalDaily, items: baseItems, today })
  const runway = $derived(data && allowance ? runwayDays(baseline, plans) : null)

  const income = $derived(data?.items.filter((i) => i.kind === 'income') ?? [])
  // Active subs first (by size), cancelled ones muted at the bottom. The
  // monthly total counts only the still-running ones.
  const subs = $derived(
    [...(data?.subs ?? [])].sort((a, b) => {
      const ac = a.end_date ? 1 : 0
      const bc = b.end_date ? 1 : 0
      if (ac !== bc) return ac - bc
      return conv(b.monthly_cents, b.currency) - conv(a.monthly_cents, a.currency)
    })
  )
  const subsTotal = $derived(
    subs.filter((x) => !x.end_date).reduce((s2, x) => s2 + conv(x.monthly_cents, x.currency), 0)
  )
  const expenses = $derived(data?.items.filter((i) => i.kind === 'expense') ?? [])
  const schedLabel = (it: ExpectedItem) => {
    if (it.per_day) return 'every day'
    return it.date ? formatDate(it.date) : `monthly · day ${it.day_of_month}${it.end_month ? ` · until ${it.end_month}` : ''}`
  }
  // A daily-rate item shows its amount as a per-day rate.
  const itemAmount = (it: ExpectedItem) =>
    `${it.kind === 'income' ? '+' : '-'}${fmtCents(conv(it.amount_cents, it.currency), cur)}${it.per_day ? '/day' : ''}`

  // ---- chart geometry (SVG, single series, months on x) ----
  const W = 600
  const H = 220
  const PAD = { l: 8, r: 8, t: 14, b: 22 }
  const chart = $derived.by(() => {
    const p = projection
    if (!p) return null
    const min = Math.min(0, p.low.cents)
    const max = Math.max(...p.points.map((x) => x.cents), 0)
    const span = max - min || 1
    const x = (i: number) => PAD.l + (i / (p.points.length - 1)) * (W - PAD.l - PAD.r)
    const y = (c: number) => PAD.t + (1 - (c - min) / span) * (H - PAD.t - PAD.b)
    const path = p.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pt.cents).toFixed(1)}`).join('')
    const months = p.points
      .map((pt, i) => ({ pt, i }))
      .filter(({ pt }) => pt.date.endsWith('-01'))
      .map(({ pt, i }) => ({
        x: x(i),
        label: new Date(pt.date + 'T00:00:00Z').toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }),
      }))
    const lowIdx = p.points.findIndex((pt) => pt.date === p.low.date)
    const zeroIdx = p.zero ? p.points.findIndex((pt) => pt.date === p.zero!.date) : -1
    return {
      path,
      months,
      x,
      y,
      zeroY: y(0),
      crossesZero: min < 0,
      low: { x: x(lowIdx), y: y(p.low.cents) },
      zeroPt: zeroIdx >= 0 ? { x: x(zeroIdx), y: y(0) } : null,
    }
  })

  // Hover/scrub tooltip
  let hover = $state<{ x: number; date: string; cents: number } | null>(null)
  function scrub(e: PointerEvent) {
    const p = projection
    const c = chart
    if (!p || !c) return
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const fx = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.max(0, Math.min(p.points.length - 1, Math.round(((fx - PAD.l) / (W - PAD.l - PAD.r)) * (p.points.length - 1))))
    hover = { x: c.x(i), date: p.points[i].date, cents: p.points[i].cents }
  }

  // ---- expected-item editor sheet ----
  let editItem = $state<Partial<ExpectedItem> | null>(null) // null = closed; id absent = new
  let fAmount = $state('')
  let fMode = $state<'monthly' | 'once' | 'daily'>('monthly')
  function openItem(it: ExpectedItem | null, kind: 'income' | 'expense') {
    editItem = it ? { ...it } : { kind, currency: cur, day_of_month: 1, name: '' }
    fAmount = it ? (it.amount_cents / 100).toFixed(2) : ''
    fMode = it?.per_day ? 'daily' : it?.date ? 'once' : 'monthly'
  }
  async function saveItem() {
    if (!editItem || saving) return
    const cents = parseCents(fAmount)
    if (cents === null || cents <= 0) {
      toasts.error('Amount must be a positive number')
      return
    }
    const body = {
      name: editItem.name?.trim(),
      kind: editItem.kind,
      amount_cents: cents,
      currency: editItem.currency,
      day_of_month: fMode === 'monthly' ? (editItem.day_of_month ?? 1) : null,
      date: fMode === 'once' ? editItem.date : fMode === 'daily' ? editItem.date || null : null,
      end_month: fMode === 'monthly' ? editItem.end_month || null : null,
      end_date: fMode === 'daily' ? editItem.end_date || null : null,
      per_day: fMode === 'daily',
      account_id: editItem.account_id ?? null,
      category_id: editItem.category_id ?? null,
    }
    saving = true
    try {
      if (editItem.id) await apiJson(`/api/expected/${editItem.id}`, { method: 'PATCH', body })
      else await apiJson('/api/expected', { method: 'POST', body })
      editItem = null
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }
  async function deleteItem() {
    if (!editItem?.id || saving) return
    saving = true
    try {
      await apiJson(`/api/expected/${editItem.id}`, { method: 'DELETE' })
      editItem = null
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      saving = false
    }
  }

  // ---- fun allowance ----
  const thisMonth = today.slice(0, 7)
  let planMonth = $state<string | null>(null)
  const plan = $derived(planMonth ? (plans.find((p) => p.month === planMonth) ?? null) : null)
  let mAmount = $state('')
  let mCur = $state<Currency>(displayCurrency.current)
  let editDefault = $state(false)

  function openDefault() {
    editDefault = true
    mAmount = allowance?.default ? String(allowance.default.amount_cents / 100) : ''
    mCur = (allowance?.default?.currency ?? cur) as Currency
  }
  async function saveDefault() {
    if (saving) return
    saving = true
    try {
      const c = parseCents(mAmount)
      if (c === null || c < 0) throw new Error('Amount must be a number')
      await apiJson('/api/allowance', { method: 'PUT', body: { amount_cents: c, currency: mCur } })
      editDefault = false
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }
  // Toggling is the tinkering loop: flip it on screen first, revert on failure.
  async function toggleItem(it: PlanItem) {
    if (!allowance) return
    const was = it.active
    allowance.items = allowance.items.map((x) => (x.id === it.id ? { ...x, active: was ? 0 : 1 } : x))
    try {
      await apiJson(`/api/allowance/items/${it.id}`, { method: 'PATCH', body: { active: !was } })
    } catch (e) {
      allowance.items = allowance.items.map((x) => (x.id === it.id ? { ...x, active: was } : x))
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    }
  }

  // ---- burn pin sheet ----
  let pinLine = $state<BurnLine | null>(null)
  let pinAmount = $state('')
  let pinCur = $state<Currency>(displayCurrency.current)
  // Pins are entered per month (rent is a monthly number) and stored as the
  // daily rate the forecast runs on.
  const DAYS_PER_MONTH = 365 / 12
  function openPin(l: BurnLine) {
    pinLine = l
    pinAmount = l.pinned ? (Math.round((l.daily * DAYS_PER_MONTH) / 100)).toString() : ''
    pinCur = cur
  }
  async function savePin(clear: boolean) {
    if (!pinLine || saving) return
    const monthly = clear ? null : parseCents(pinAmount)
    const cents = monthly === null ? null : Math.round(monthly / DAYS_PER_MONTH)
    if (!clear && (cents === null || cents! < 0)) {
      toasts.error('Rate must be a number')
      return
    }
    saving = true
    try {
      await apiJson(`/api/categories/${pinLine.category_id}`, {
        method: 'PATCH',
        body: { pinned_daily_cents: cents, pinned_currency: clear ? null : pinCur },
      })
      pinLine = null
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }

  // ---- cancel-subscription sheet ----
  let cancelSub = $state<SubRow | null>(null)
  let cancelDate = $state('')
  function openCancel(sub: SubRow) {
    cancelSub = sub
    cancelDate = sub.end_date ?? today
  }
  async function saveCancel(clear: boolean) {
    if (!cancelSub || saving) return
    saving = true
    try {
      await apiJson('/api/sub-override', {
        method: 'POST',
        body: { merchant_id: cancelSub.merchant_id, end_date: clear ? null : cancelDate },
      })
      cancelSub = null
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }
</script>

<div class="page">
  <div class="bar">
    <div class="pills" role="group" aria-label="Horizon">
      {#each HORIZONS as h (h.days)}
        <button
          class="pill"
          class:on={h.days === horizonDays}
          onclick={() => {
            horizonDays = h.days
            setPref('accountant.fc.horizon', h.days)
          }}
        >
          {h.label}
        </button>
      {/each}
    </div>
    <span class="spacer"></span>
    <div class="pills" role="group" aria-label="Display currency">
      {#each accounts.currencies as c (c)}
        <button class="pill" class:on={c === cur} onclick={() => displayCurrency.set(c)}>{c}</button>
      {/each}
    </div>
  </div>

  {#if !projection || !chart}
    <p class="empty">Loading...</p>
  {:else}
    <section class="card chart-card">
      <svg
        viewBox="0 0 {W} {H}"
        class="chart"
        role="img"
        aria-label="Projected cash over the next {horizonDays} days"
        onpointermove={scrub}
        onpointerdown={scrub}
        onpointerleave={() => (hover = null)}
      >
        {#each chart.months as m (m.x)}
          <line x1={m.x} y1={PAD.t} x2={m.x} y2={H - PAD.b} class="grid" />
          <text x={m.x + 4} y={H - 8} class="tick">{m.label}</text>
        {/each}
        {#if chart.crossesZero}
          <line x1={PAD.l} y1={chart.zeroY} x2={W - PAD.r} y2={chart.zeroY} class="zero" />
        {/if}
        <path d={chart.path} class="line" />
        <circle cx={chart.low.x} cy={chart.low.y} r="4" class="low-dot" />
        {#if chart.zeroPt}
          <circle cx={chart.zeroPt.x} cy={chart.zeroPt.y} r="4.5" class="zero-dot" />
        {/if}
        {#if hover}
          <line x1={hover.x} y1={PAD.t} x2={hover.x} y2={H - PAD.b} class="crosshair" />
        {/if}
      </svg>
      {#if hover}
        <div class="tooltip num" style="left: {(hover.x / W) * 100}%">
          {formatDate(hover.date)} · {fmtCents(hover.cents, cur)}
        </div>
      {/if}
      <div class="stats">
        <div class="stat">
          {#if projection.zero}
            <span class="stat-label">Cash hits zero</span>
            <span class="stat-val num danger">{formatDate(projection.zero.date)}</span>
          {:else}
            <span class="stat-label">Cash hits zero</span>
            <span class="stat-val num covered">Not in {Math.round(horizonDays / 30)} mo</span>
          {/if}
        </div>
        <div class="stat">
          <span class="stat-label">Lowest point</span>
          <span class="stat-val num" class:danger={projection.low.cents < 0}>
            {fmtCents(projection.low.cents, cur)} · {formatDate(projection.low.date)}
          </span>
        </div>
        <div class="stat">
          <span class="stat-label">End of horizon</span>
          <span class="stat-val num">{fmtCents(projection.end.cents, cur)} · {formatDate(projection.end.date)}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="sec-head">
        <h2>Fun allowance</h2>
        <button class="add" onclick={openDefault}>
          {allowance?.default ? `${fmtCents(conv(allowance.default.amount_cents, allowance.default.currency), cur, { whole: true })}/mo` : 'Set'}
        </button>
      </div>
      {#each shownPlans as p (p.month)}
        <button class="item" onclick={() => (planMonth = p.month)}>
          <span class="i-name">
            {monthName(p.month)}{#if p.month === thisMonth}<span class="muted">· rest of month</span>{/if}
          </span>
          {#if p.locked_at}<span class="pin-tag">locked</span>{/if}
          <span class="i-sched" class:over={p.over > 0}>
            {#if p.over > 0}
              over by {fmtCents(p.over, cur, { whole: true })}
            {:else if p.planned > 0}
              {fmtCents(p.left, cur, { whole: true })} left
            {/if}
          </span>
          <span class="i-amt num">{fmtCents(p.allowance, cur, { whole: true })}</span>
        </button>
      {/each}
      <p class="burn-note">
        Runway with this plan: <b>{fmtRunway(runway)}</b>. The allowance is already in the forecast - plan things into it;
        only going over costs runway.
      </p>
      <a class="see-all" href="#/plan">See the whole plan ›</a>
    </section>

    <section class="card">
      <div class="sec-head">
        <h2>Expected income</h2>
        <button class="add" onclick={() => openItem(null, 'income')}>Add</button>
      </div>
      {#each income as it (it.id)}
        <button class="item" onclick={() => openItem(it, 'income')}>
          <span class="i-name">{it.name}</span>
          <span class="i-sched">{schedLabel(it)}</span>
          <span class="i-amt num pos">{itemAmount(it)}</span>
        </button>
      {/each}
    </section>

    <section class="card">
      <div class="sec-head">
        <h2>Expected expenses</h2>
        <button class="add" onclick={() => openItem(null, 'expense')}>Add</button>
      </div>
      {#each expenses as it (it.id)}
        <button class="item" onclick={() => openItem(it, 'expense')}>
          <span class="i-name">{it.name}</span>
          <span class="i-sched">{schedLabel(it)}</span>
          <span class="i-amt num">{itemAmount(it)}</span>
        </button>
      {/each}
    </section>

    <section class="card">
      <div class="sec-head">
        <h2>Subscriptions · {fmtCents(subsTotal, cur)}/mo</h2>
        <span class="measured">measured</span>
      </div>
      {#each subs as sub (sub.merchant_id + sub.currency)}
        <button class="item" class:cancelled={sub.end_date} onclick={() => openCancel(sub)}>
          <span class="i-name">{sub.name}</span>
          <span class="i-sched">{sub.end_date ? `cancelled · ${formatDate(sub.end_date)}` : `~ day ${sub.day}`}</span>
          <span class="i-amt num">-{fmtCents(conv(sub.monthly_cents, sub.currency), cur)}</span>
        </button>
      {/each}
    </section>

    <section class="card">
      <div class="sec-head">
        <h2>Daily burn · {fmtCents(totalDaily, cur)}/day</h2>
        <span class="over">over</span>
        <div class="pills small">
          {#each [14, 30, 60, 90] as w (w)}
            <button
              class="pill"
              class:on={w === windowDays}
              onclick={() => {
                windowDays = w
                setPref('accountant.fc.window', w)
              }}
            >
              {w}d
            </button>
          {/each}
        </div>
      </div>
      {#each burnLines as l (l.category_id)}
        <button class="item" onclick={() => openPin(l)}>
          <span class="i-name">{l.name}</span>
          {#if l.pinned}<span class="pin-tag">pinned</span>{/if}
          <span class="i-sched">≈ {fmtCents(l.daily * DAYS_PER_MONTH, cur, { whole: true })}/mo</span>
          <span class="i-amt num">{fmtCents(l.daily, cur)}/day</span>
        </button>
      {/each}
      <p class="burn-note">
        Each rate is what was spent in the last {windowDays} days ÷ {windowDays}, and it drives the balance forecast
        above. Monthly bills like rent swing with the window - pin those.
      </p>
    </section>
  {/if}
</div>

{#if editItem}
  <Sheet onclose={() => (editItem = null)}>
    <span class="sheet-title">{editItem.id ? 'Edit' : 'New'} {editItem.kind}</span>
    <input class="input" type="text" placeholder="Name..." bind:value={editItem.name} />
    <div class="line">
      <input
        class="input amt"
        type="text"
        inputmode="decimal"
        placeholder={fMode === 'daily' ? 'Per day' : 'Amount'}
        bind:value={fAmount}
      />
      {#each accounts.currencies as c (c)}
        <button class="chip" class:on={editItem.currency === c} onclick={() => (editItem!.currency = c)}>{c}</button>
      {/each}
    </div>
    <div class="line">
      <button class="chip" class:on={fMode === 'monthly'} onclick={() => (fMode = 'monthly')}>Monthly</button>
      <button class="chip" class:on={fMode === 'once'} onclick={() => (fMode = 'once')}>One-off</button>
      <button class="chip" class:on={fMode === 'daily'} onclick={() => (fMode = 'daily')}>Daily rate</button>
    </div>
    <div class="line">
      {#if fMode === 'monthly'}
        <label class="lbl">day <input class="input tiny" type="number" min="1" max="31" bind:value={editItem.day_of_month} /></label>
        <label class="lbl">until <input class="input mid" type="text" placeholder="YYYY-MM" bind:value={editItem.end_month} /></label>
      {:else if fMode === 'once'}
        <DateField bind:value={editItem.date} />
      {/if}
    </div>
    <div class="line">
      {#if editItem.id}<button class="btn danger" disabled={saving} onclick={deleteItem}>Delete</button>{/if}
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving || !editItem.name?.trim() || !fAmount.trim()} onclick={saveItem}>
        Save
      </button>
    </div>
  </Sheet>
{/if}

{#if editDefault}
  <Sheet onclose={() => (editDefault = false)}>
    <span class="sheet-title">Fun allowance · every month</span>
    <p class="hint">Lands on the 1st. A month can have its own amount - tap the month.</p>
    <div class="line">
      <input class="input amt" type="text" inputmode="decimal" placeholder="Per month" bind:value={mAmount} />
      {#each accounts.currencies as c (c)}
        <button class="chip" class:on={mCur === c} onclick={() => (mCur = c)}>{c}</button>
      {/each}
    </div>
    <div class="line">
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving || !mAmount.trim()} onclick={saveDefault}>Save</button>
    </div>
  </Sheet>
{/if}

{#if plan && allowance}
  <AllowanceSheet
    {plan}
    data={allowance}
    {cur}
    {conv}
    overCost={overCostDays(baseline, plans, plan)}
    snapshot={() => snapshotFor(baseline, plans, plan!, allowance!, cur, conv)}
    ontoggle={toggleItem}
    reload={load}
    onclose={() => (planMonth = null)}
  />
{/if}

{#if pinLine}
  <Sheet onclose={() => (pinLine = null)}>
    <span class="sheet-title">{pinLine.name}</span>
    <p class="hint">
      Last {windowDays} days: {fmtCents(pinLine.spent, cur)} spent ÷ {windowDays} days =
      {fmtCents(pinLine.measured, cur)}/day, about {fmtCents(pinLine.measured * DAYS_PER_MONTH, cur, { whole: true })}/month.
      {#if pinLine.pinned}
        Pinned at {fmtCents(pinLine.daily * DAYS_PER_MONTH, cur, { whole: true })}/month instead - the forecast uses the pin.
      {:else}
        Pin a monthly amount when you know better than the data; it stays until you unpin it.
      {/if}
    </p>
    <div class="line">
      <input class="input amt" type="text" inputmode="decimal" placeholder="Per month" bind:value={pinAmount} />
      {#each accounts.currencies as c (c)}
        <button class="chip" class:on={pinCur === c} onclick={() => (pinCur = c)}>{c}</button>
      {/each}
    </div>
    <div class="line">
      {#if pinLine.pinned}<button class="btn" disabled={saving} onclick={() => savePin(true)}>Unpin</button>{/if}
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving || !pinAmount.trim()} onclick={() => savePin(false)}>Pin monthly</button>
    </div>
  </Sheet>
{/if}

{#if cancelSub}
  <Sheet onclose={() => (cancelSub = null)}>
    <span class="sheet-title">{cancelSub.name}</span>
    <p class="hint">
      {cancelSub.end_date
        ? 'This subscription is cancelled — it stops charging after the date below. Reactivate to return it to its measured monthly charge.'
        : 'Cancel this subscription: it stops adding to the forecast after the end date. It stays listed so you remember. Reactivate any time to return it to derived.'}
    </p>
    <div class="ends"><span class="lbl">Ends</span><DateField bind:value={cancelDate} /></div>
    <div class="line">
      {#if cancelSub.end_date}<button class="btn" disabled={saving} onclick={() => saveCancel(true)}>Reactivate</button>{/if}
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving || !cancelDate} onclick={() => saveCancel(false)}>
        {cancelSub.end_date ? 'Update' : 'Cancel subscription'}
      </button>
    </div>
  </Sheet>
{/if}

<style>
  .ends { display: flex; flex-direction: column; gap: 6px; }
  .page {
    max-width: 620px;
    margin: 0 auto;
    padding: 14px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .bar { display: flex; align-items: center; gap: 8px; }
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
  .chart-card { position: relative; padding: 6px 6px 0; }
  .chart { width: 100%; height: auto; display: block; touch-action: none; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .zero { stroke: var(--danger); stroke-width: 1; stroke-dasharray: 4 4; opacity: 0.6; }
  .line { fill: none; stroke: var(--accent-deep); stroke-width: 2; stroke-linejoin: round; }
  .low-dot { fill: var(--bg-raised); stroke: var(--accent-deep); stroke-width: 2; }
  .crosshair { stroke: var(--text-secondary); stroke-width: 1; stroke-dasharray: 2 3; }
  .tick { font-size: 10px; fill: var(--text-secondary); }
  .tooltip {
    position: absolute;
    top: 4px;
    transform: translateX(-50%);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 0.72rem;
    color: var(--text-primary);
    white-space: nowrap;
    pointer-events: none;
  }
  .stats { display: flex; gap: 10px; padding: 8px 10px 12px; }
  .stat { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .stat-label { font-size: 0.68rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
  .stat-val { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); }
  .stat-val.danger { color: var(--danger); }
  .stat-val.covered { color: #35679e; }
  .zero-dot { fill: var(--danger); stroke: var(--bg-raised); stroke-width: 2; }

  .sec-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px 6px; }
  h2 { flex: 1; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-secondary); margin: 0; }
  .add { font-size: 0.76rem; font-weight: 500; color: var(--accent); padding: 2px 8px; }
  .pills.small .pill { padding: 3px 8px; font-size: 0.68rem; }

  .measured { font-size: 0.66rem; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; }
  .item.cancelled .i-name { color: var(--text-secondary); text-decoration: line-through; }
  .item.cancelled .i-amt { color: var(--text-secondary); }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 14px;
    text-align: start;
    border-top: 1px solid var(--border);
  }
  .item:active { background: var(--bg-hover); }
  .i-name { font-size: 0.85rem; color: var(--text-primary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .over { font-size: 0.7rem; color: var(--text-secondary); }
  .muted { color: var(--text-secondary); font-size: 0.74rem; }
  .i-name .muted { margin-inline-start: 0.35em; }
  .over { color: var(--warn); }
  .see-all { display: block; padding: 0 14px 12px; font-size: 0.8rem; color: var(--accent); text-decoration: none; }
  .burn-note { margin: 0; padding: 8px 14px 12px; font-size: 0.7rem; line-height: 1.45; color: var(--text-secondary); }
  .i-sched { flex: 1; font-size: 0.7rem; color: var(--text-secondary); text-align: end; }
  .i-amt { font-size: 0.82rem; color: var(--text-primary); flex: none; }
  .pos { color: #35679e; }
  .pin-tag {
    font-size: 0.64rem;
    color: var(--accent-deep);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 1px 7px;
  }

  .sheet-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .hint { font-size: 0.74rem; color: var(--text-secondary); line-height: 1.5; margin: 0; }
  .line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
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
  .input.tiny { width: 58px; padding: 6px 8px; }
  .input.mid { width: 130px; padding: 6px 8px; }
  .lbl { display: inline-flex; align-items: center; gap: 4px; font-size: 0.74rem; color: var(--text-secondary); }
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
  .btn:disabled { opacity: 0.4; }
  .btn.primary { color: #fff; background: var(--accent-deep); border-color: var(--accent-deep); }
  .btn.danger { color: var(--danger); border-color: var(--danger); }

  @media (hover: hover) {
    .item:hover { background: var(--bg-hover); }
  }
</style>
