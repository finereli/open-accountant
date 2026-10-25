<script lang="ts">
  // Screenshot import: the fallback when no feed or CSV covers the latest days.
  // Pick a scrolling screenshot of the bank app's transaction list; it's
  // cut into overlapping strips, each read by a vision model, merged, and
  // checked against the running balance the bank prints under every
  // amount. Rows the ledger already has are skipped; the rest import through
  // the normal ingest path. Nothing is written until Import is tapped.
  // Reading happens on the server (an import job), so the sheet can be
  // closed or the app left while it runs; the account screen shows progress.
  import { apiJson } from '../lib/api'
  import { fmtAmount, fmtCents, parseCents } from '../lib/money'
  import { formatDate } from '$shared/lib/format'
  import { toasts } from '$shared/lib/toast.svelte'
  import { mergeStrips, checkChain, breakGap, editableField, touchesBreak, type ReadRow } from '../lib/statement-import'
  import Sheet from '../ui/Sheet.svelte'
  import type { Account } from '../lib/types'
  import type { ImportTracker } from '../lib/import-job.svelte'

  let {
    account,
    tracker,
    onclose,
    ondone,
  }: { account: Account; tracker: ImportTracker; onclose: () => void; ondone: () => void } = $props()

  interface Line extends ReadRow {
    ledgerId: number | null // already in the ledger (matched), else new
    locked: boolean // inside a reconciled period: the ledger is settled there
    include: boolean
  }

  let step = $state<'pick' | 'reading' | 'reviewing' | 'review' | 'saving' | 'done'>('pick')
  const progress = $derived({ done: tracker.job?.done ?? 0, total: tracker.job?.total ?? 0 })
  let lines = $state<Line[]>([])
  let undated = $state(0)
  let unreadable = $state<number[]>([]) // strip numbers that failed twice
  let ledgerBalance = $state<number | null>(null)
  let result = $state<{ inserted: number; duplicates: number; flagged: number } | null>(null)

  // A long scrolling screenshot is far taller than a vision model can read
  // at once. Strips overlap by more than a row's height, so every row sits
  // whole in at least one strip; the model skips rows cut at an edge.
  const WIDTH = 1080
  const STRIP = 1600
  const OVERLAP = 360

  async function slice(file: File): Promise<string[]> {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, WIDTH / bmp.width)
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const strips: string[] = []
    for (let y = 0; ; y += STRIP - OVERLAP) {
      const sh = Math.min(STRIP, h - y)
      const c = document.createElement('canvas')
      c.width = w
      c.height = sh
      c.getContext('2d')!.drawImage(bmp, 0, y / scale, bmp.width, sh / scale, 0, 0, w, sh)
      strips.push(c.toDataURL('image/jpeg', 0.85))
      if (y + sh >= h) break
    }
    return strips
  }

  async function readAll(file: File) {
    step = 'reading'
    try {
      await tracker.start(account.id, await slice(file))
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Upload failed')
      step = 'pick'
    }
  }

  // An import already running (or read and waiting) opens where it is.
  if (tracker.job) step = 'reading'
  $effect(() => {
    const j = tracker.job
    if (step === 'reading' && j?.finished && j.strips) review(j.strips, j.failed)
  })

  async function review(results: ReadRow[][], failedStrips: number[]) {
    step = 'reviewing'
    unreadable = failedStrips
    try {
      const merged = mergeStrips(results)
      // Rows above the first date header can't be placed in time.
      const dated = merged.filter((r) => r.date !== null)
      undated = merged.length - dated.length
      if (dated.length === 0) throw new Error('No dated transactions found in this screenshot')

      const pv = await apiJson<{
        matches: (number | null)[]
        ledger_balance_cents: number | null
        locked_before: string | null
      }>('/api/import/preview', {
        method: 'POST',
        body: { account_id: account.id, rows: dated.map((r) => ({ date: r.date, amount_cents: r.amount_cents })) },
      })
      lines = dated.map((r, i) => {
        const locked = pv.locked_before !== null && r.date! < pv.locked_before
        return { ...r, ledgerId: pv.matches[i], locked, include: pv.matches[i] === null && !locked }
      })
      ledgerBalance = pv.ledger_balance_cents
      step = 'review'
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Reading failed')
      await tracker.discard()
      step = 'pick'
    }
  }

  const chain = $derived(checkChain(lines))
  const breaks = $derived(chain.filter((c) => c === 'break').length)
  // Only rows being imported need to add up; a break among rows the ledger
  // already has is noted but blocks nothing.
  const blocking = $derived(lines.filter((l, i) => l.include && touchesBreak(chain, i)).length)
  const toImport = $derived(lines.filter((l) => l.include))
  const matched = $derived(lines.filter((l) => l.ledgerId !== null).length)
  const lockedNew = $derived(lines.filter((l) => l.locked && l.ledgerId === null).length)
  const bankNewest = $derived(lines[0]?.balance_cents ?? null)
  const ledgerAfter = $derived(ledgerBalance === null ? null : ledgerBalance + toImport.reduce((s, l) => s + l.amount_cents, 0))

  function setNum(i: number, field: 'amount_cents' | 'balance_cents', text: string) {
    const v = parseCents(text)
    if (v !== null) lines[i][field] = v
  }

  async function commit() {
    step = 'saving'
    try {
      const r = await apiJson<{ inserted: number; duplicates: number; flagged: unknown[] }>('/api/import/commit', {
        method: 'POST',
        body: {
          account_id: account.id,
          rows: toImport.map((l) => ({
            date: l.date,
            description: l.description,
            amount_cents: l.amount_cents,
            balance_cents: l.balance_cents,
          })),
        },
      })
      result = { inserted: r.inserted, duplicates: r.duplicates, flagged: r.flagged.length }
      step = 'done'
      await tracker.discard()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Import failed')
      step = 'review'
    }
  }

  const cur = $derived(account.currency)
</script>

<Sheet onclose={step === 'done' ? ondone : onclose} tall={step === 'review'}>
  <span class="sheet-title">Import from screenshot · {account.display_name}</span>

  {#if step === 'pick'}
    <p class="hint">
      A screenshot of the bank app's transaction list - a long scrolling capture is fine. Every row is checked against
      the balance the bank shows under it; nothing is saved until you tap Import.
    </p>
    <label class="btn primary pick">
      Choose screenshot
      <input
        type="file"
        accept="image/*"
        onchange={(e) => {
          const f = e.currentTarget.files?.[0]
          if (f) readAll(f)
        }}
      />
    </label>
  {:else if step === 'reading' || step === 'reviewing'}
    <p class="hint">
      {#if !tracker.job}
        Uploading...
      {:else}
        Reading the screenshot - part {progress.done} of {progress.total}...
      {/if}
    </p>
    <div class="bar"><div class="fill" style="width: {progress.total ? (progress.done / progress.total) * 100 : 5}%"></div></div>
    <p class="hint">You can close this or switch apps - it keeps reading, and the account screen shows when it's ready.</p>
  {:else if step === 'review' || step === 'saving'}
    <div class="summary">
      <span>{lines.length} rows read · <b>{toImport.length} to import</b> · {matched} already in ledger</span>
      {#if lockedNew > 0}
        <span>
          {lockedNew} more {lockedNew === 1 ? 'is' : 'are'} in an already-reconciled period and can't be imported - the ledger
          there already matches the bank, so {lockedNew === 1 ? "it's" : "they're"} most likely misread or a duplicate
        </span>
      {/if}
      {#if blocking > 0}
        <span class="bad">
          {blocking} {blocking === 1 ? 'row to import sits' : 'rows to import sit'} next to a place that doesn't add up - fix the
          highlighted number, or untick the row
        </span>
      {:else if breaks > 0}
        <span class="warn">
          {breaks} {breaks === 1 ? "place doesn't" : "places don't"} add up, but only among rows already in the ledger -
          nothing to fix
        </span>
      {:else if chain.some((c) => c === 'ok')}
        <span class="good">Every row adds up to the bank's balance</span>
      {/if}
      {#if ledgerAfter !== null && bankNewest !== null && blocking === 0}
        {#if ledgerAfter === bankNewest}
          <span class="good">After import the ledger matches the bank: {fmtCents(bankNewest, cur)}</span>
        {:else}
          <span class="warn">
            After import the ledger will be {fmtCents(ledgerAfter, cur)} vs the bank's {fmtCents(bankNewest, cur)}
            (off by {fmtCents(Math.abs(bankNewest - ledgerAfter), cur)}) - older rows may be missing
          </span>
        {/if}
      {/if}
      {#if unreadable.length > 0}
        <span class="warn">
          Couldn't read part {unreadable.join(', ')} of the screenshot - any rows there are missing (the balance check shows
          where)
        </span>
      {/if}
      {#if undated > 0}<span class="warn">{undated} rows above the first date header were left out</span>{/if}
    </div>

    <div class="list">
      {#each lines as l, i (i)}
        {@const field = l.include ? editableField(chain, i) : null}
        {@const gap = chain[i] === 'break' ? breakGap(lines, i) : null}
        <div class="row" class:off={!l.include} class:break={touchesBreak(chain, i) && l.include}>
          <div class="main">
            <span class="date num">{formatDate(l.date!).slice(0, 5)}</span>
            <span class="desc">{l.description}</span>
            {#if field === 'amount'}
              <input class="num-in" inputmode="decimal" value={(l.amount_cents / 100).toFixed(2)} onchange={(e) => setNum(i, 'amount_cents', e.currentTarget.value)} />
            {:else}
              <span class="amt num" class:pos={l.amount_cents > 0}>{fmtAmount(l.amount_cents, cur)}</span>
            {/if}
          </div>
          <div class="sub">
            {#if l.locked && l.ledgerId === null}
              <span class="chip">reconciled</span>
            {:else}
              <button class="chip" class:on={l.include} onclick={() => (l.include = !l.include)}>
                {l.include ? 'import' : l.ledgerId !== null ? 'in ledger' : 'skip'}
              </button>
            {/if}
            {#if l.balance_cents !== null}
              {#if field === 'balance'}
                <span class="bal">balance <input class="num-in small" inputmode="decimal" value={(l.balance_cents / 100).toFixed(2)} onchange={(e) => setNum(i, 'balance_cents', e.currentTarget.value)} /></span>
              {:else}
                <span class="bal num">{fmtCents(l.balance_cents, cur)}</span>
              {/if}
            {/if}
          </div>
          {#if gap !== null}
            <span class="gap">
              Doesn't add up by {fmtCents(Math.abs(gap), cur)} below this row - a row may be missing from the screenshot, or a
              number was misread
            </span>
          {/if}
        </div>
      {/each}
    </div>

    <div class="actions">
      <button
        class="btn"
        onclick={async () => {
          await tracker.discard()
          step = 'pick'
        }}
        disabled={step === 'saving'}>Discard</button
      >
      <span class="spacer"></span>
      <button class="btn primary" disabled={step === 'saving' || toImport.length === 0 || blocking > 0} onclick={commit}>
        {step === 'saving' ? 'Importing...' : `Import ${toImport.length}`}
      </button>
    </div>
  {:else if step === 'done' && result}
    <p class="summary">
      <span class="good">Imported {result.inserted} {result.inserted === 1 ? 'transaction' : 'transactions'}.</span>
      {#if result.duplicates > 0}<span>{result.duplicates} were already there and skipped.</span>{/if}
      {#if result.flagged > 0}
        <span class="warn">{result.flagged} fell inside an already-reconciled period and were not imported.</span>
      {/if}
    </p>
    <div class="actions">
      <span class="spacer"></span>
      <button class="btn primary" onclick={ondone}>Done</button>
    </div>
  {/if}
</Sheet>

<style>
  .sheet-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .hint { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.5; margin: 0; }
  .btn {
    padding: 9px 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 0.85rem;
    font-weight: 500;
  }
  .btn:disabled { opacity: 0.4; }
  .btn.primary { color: #fff; background: var(--accent-deep); border-color: var(--accent-deep); }
  .pick { align-self: flex-start; position: relative; cursor: pointer; }
  .pick input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .bar { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width 0.3s; }

  .summary { display: flex; flex-direction: column; gap: 3px; font-size: 0.8rem; color: var(--text-secondary); margin: 0; line-height: 1.45; }
  .good { color: var(--ok); }
  .warn { color: var(--warn); }
  .bad { color: var(--danger); font-weight: 500; }

  .list {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .row { padding: 8px 12px; display: flex; flex-direction: column; gap: 3px; }
  .row + .row { border-top: 1px solid var(--border); }
  .row.off .desc, .row.off .amt { color: var(--text-secondary); }
  .row.break { background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .main { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .date { flex: none; font-size: 0.72rem; color: var(--text-secondary); }
  .desc { flex: 1; min-width: 0; font-size: 0.82rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .amt { flex: none; font-size: 0.84rem; font-weight: 500; color: var(--text-primary); }
  .amt.pos { color: #35679e; }
  .sub { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .bal { font-size: 0.7rem; color: var(--text-secondary); }
  .chip {
    font-size: 0.68rem;
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    background: none;
  }
  .chip.on { border-color: var(--accent); color: var(--accent-deep); background: var(--accent-soft); }
  .num-in {
    width: 84px;
    font: inherit;
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
    text-align: end;
    padding: 3px 6px;
    border: 1px solid var(--danger);
    border-radius: 6px;
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .num-in.small { width: 76px; font-size: 0.72rem; }
  .gap { font-size: 0.7rem; color: var(--danger); line-height: 1.4; }
  .actions { display: flex; align-items: center; gap: 10px; }
  .spacer { flex: 1; }
</style>
