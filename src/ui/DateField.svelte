<script lang="ts">
  // The app's one date input. Shows the date as yyyy-mm-dd and opens a
  // calendar inline, right below the field - not the browser's native
  // picker, which on Android fights the soft keyboard inside bottom sheets
  // (the field slid under the keyboard) and ignores the format we want.
  // The calendar is Cally (web components, ISO yyyy-mm-dd values natively).
  import 'cally'

  let {
    value = $bindable(),
    min,
    max,
    placeholder = 'yyyy-mm-dd',
  }: { value?: string | null; min?: string; max?: string; placeholder?: string } = $props()

  let open = $state(false)
  let cal = $state<HTMLElement>()

  // Cally's change event doesn't go through Svelte's delegated handlers,
  // so listen on the element directly.
  $effect(() => {
    const el = cal
    if (!el) return
    const pick = () => {
      value = (el as HTMLElement & { value: string }).value
      open = false
    }
    el.addEventListener('change', pick)
    return () => el.removeEventListener('change', pick)
  })

  function toggle() {
    // A focused text field above (amount, name) would keep the keyboard up.
    ;(document.activeElement as HTMLElement | null)?.blur()
    open = !open
  }

  const today = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
</script>

<div class="date-field">
  <button type="button" class="field num" class:empty={!value} class:open onclick={toggle}>
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
    {value || placeholder}
  </button>
  {#if open}
    <div class="cal-wrap">
      <calendar-date bind:this={cal} class="cal" value={value ?? ''} {min} {max} locale="en">
        <span slot="previous" class="nav"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-label="Previous month"><path d="M15 18l-6-6 6-6" /></svg></span>
        <span slot="next" class="nav"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-label="Next month"><path d="M9 18l6-6-6-6" /></svg></span>
        <calendar-month></calendar-month>
      </calendar-date>
      {#if (!min || today() >= min) && (!max || today() <= max)}
        <button
          type="button"
          class="today"
          onclick={() => {
            value = today()
            open = false
          }}>Today</button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .date-field { display: flex; flex-direction: column; gap: 6px; }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    align-self: flex-start;
    font: inherit;
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .field svg { color: var(--text-secondary); flex: none; }
  .field.empty { color: var(--text-secondary); }
  .field.open { border-color: var(--accent-light); outline: 2px solid var(--accent-light); outline-offset: -1px; }

  .cal-wrap {
    align-self: flex-start;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 8px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
  }
  .cal { font-size: 0.85rem; color: var(--text-primary); }
  .cal::part(header) { padding: 0 4px 6px; }
  .cal::part(heading) { font-weight: 600; font-size: 0.88rem; }
  .cal::part(button) {
    border: none;
    background: none;
    color: var(--text-secondary);
    padding: 6px;
    border-radius: 8px;
    cursor: pointer;
  }
  .cal::part(disabled) { opacity: 0.3; cursor: default; }
  calendar-month::part(th) { font-size: 0.68rem; font-weight: 500; color: var(--text-secondary); padding-bottom: 4px; }
  calendar-month::part(button) {
    width: 38px;
    height: 36px;
    border: none;
    border-radius: 8px;
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  calendar-month::part(today) { color: var(--accent-deep); font-weight: 700; box-shadow: inset 0 0 0 1px var(--accent-light); }
  calendar-month::part(selected) { background: var(--accent-deep); color: #fff; font-weight: 600; }
  calendar-month::part(outside) { color: var(--text-secondary); opacity: 0.45; }
  calendar-month::part(disallowed) { opacity: 0.25; cursor: default; }
  .nav { display: flex; }
  .today {
    align-self: flex-end;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--accent-deep);
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: none;
  }
  @media (hover: hover) {
    calendar-month::part(button):hover { background: var(--bg-hover); }
    calendar-month::part(selected):hover { background: var(--accent); }
  }
</style>
