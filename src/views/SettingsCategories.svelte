<script lang="ts">
  // Settings, starting with category management: add, rename, change kind,
  // reorder, delete-when-empty. Structured as sections so gates, account
  // scope, and household instructions can slot in later.
  import { apiJson } from '../lib/api'
  import { toasts } from '$shared/lib/toast.svelte'
  import Sheet from '../ui/Sheet.svelte'

  interface Cat {
    id: number
    name: string
    kind: 'income' | 'expense' | 'excluded'
    sort: number
    flow: 'run_rate' | 'discrete' | 'subscriptions' | 'off'
    description: string | null
    merchant_count: number
  }

  const KINDS = ['income', 'expense', 'excluded'] as const
  const FLOWS = [
    { value: 'run_rate', label: 'run rate' },
    { value: 'discrete', label: 'discrete' },
    { value: 'subscriptions', label: 'subs' },
    { value: 'off', label: 'off' },
  ] as const

  let cats = $state<Cat[]>([])
  let ready = $state(false)
  let editing = $state<number | null>(null)
  let editName = $state('')
  let editDesc = $state('')
  let newName = $state('')
  let newKind = $state<Cat['kind']>('expense')
  let adding = $state(false)
  let saving = $state(false)

  async function load() {
    const r = await apiJson<{ categories: Cat[] }>('/api/categories')
    cats = r.categories
    ready = true
  }
  $effect(() => {
    load().catch((e) => toasts.error(e instanceof Error ? e.message : 'Load failed'))
  })

  function startEdit(c: Cat) {
    if (editing === c.id) {
      editing = null
      return
    }
    editing = c.id
    editName = c.name
    editDesc = c.description ?? ''
  }

  async function mutate(fn: () => Promise<unknown>) {
    if (saving) return
    saving = true
    try {
      await fn()
      await load()
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      saving = false
    }
  }

  const rename = (c: Cat) =>
    mutate(() => apiJson(`/api/categories/${c.id}`, { method: 'PATCH', body: { name: editName.trim() } }))
  // The description is what the auto-categorizer reads to know what belongs
  // here - saved when the field loses focus.
  const saveDesc = (c: Cat) => {
    if (editDesc.trim() === (c.description ?? '')) return
    mutate(() => apiJson(`/api/categories/${c.id}`, { method: 'PATCH', body: { description: editDesc.trim() || null } }))
  }
  const setKind = (c: Cat, kind: Cat['kind']) =>
    mutate(() => apiJson(`/api/categories/${c.id}`, { method: 'PATCH', body: { kind } }))
  const setFlow = (c: Cat, flow: Cat['flow']) =>
    mutate(() => apiJson(`/api/categories/${c.id}`, { method: 'PATCH', body: { flow } }))
  const remove = (c: Cat) =>
    mutate(async () => {
      await apiJson(`/api/categories/${c.id}`, { method: 'DELETE' })
      editing = null
    })
  const add = () =>
    mutate(async () => {
      await apiJson('/api/categories', { method: 'POST', body: { name: newName.trim(), kind: newKind } })
      newName = ''
      newKind = 'expense'
      adding = false
    })

  // Reorder = swap sort values with the neighbor within the same kind, so
  // the Spending view's order follows immediately.
  function move(c: Cat, dir: -1 | 1) {
    const peers = cats.filter((x) => x.kind === c.kind)
    const i = peers.findIndex((x) => x.id === c.id)
    const other = peers[i + dir]
    if (!other) return
    mutate(async () => {
      await apiJson(`/api/categories/${c.id}`, { method: 'PATCH', body: { sort: other.sort } })
      await apiJson(`/api/categories/${other.id}`, { method: 'PATCH', body: { sort: c.sort } })
    })
  }
</script>

<div class="page">
  <section class="section">
    <div class="card">
      {#each cats as c (c.id)}
        <button class="row" onclick={() => startEdit(c)}>
          <span class="name-col">
            <span class="name">{c.name}</span>
            {#if c.description}<span class="desc">{c.description}</span>{/if}
          </span>
          <span class="kind" class:income={c.kind === 'income'} class:excluded={c.kind === 'excluded'}>{c.kind}</span>
          <span class="count num">{c.merchant_count}</span>
        </button>
        {#if editing === c.id}
          <div class="editor">
            <div class="edit-line">
              <input
                class="edit-input"
                type="text"
                bind:value={editName}
                onkeydown={(e) => e.key === 'Enter' && rename(c)}
              />
              <button class="btn" disabled={saving || editName.trim() === c.name || !editName.trim()} onclick={() => rename(c)}>
                Rename
              </button>
            </div>
            <textarea
              class="edit-input desc-input"
              rows="2"
              placeholder="What belongs here, in plain words - the auto-categorizer reads this"
              bind:value={editDesc}
              onblur={() => saveDesc(c)}
            ></textarea>
            <div class="edit-line">
              {#each KINDS as k (k)}
                <button class="chip" class:on={c.kind === k} disabled={saving} onclick={() => setKind(c, k)}>{k}</button>
              {/each}
              <span class="spacer"></span>
              <button class="btn" disabled={saving} onclick={() => move(c, -1)}>↑</button>
              <button class="btn" disabled={saving} onclick={() => move(c, 1)}>↓</button>
            </div>
            <div class="edit-line">
              <span class="hint flow-lbl">Forecast:</span>
              {#each FLOWS as f (f.value)}
                <button class="chip" class:on={c.flow === f.value} disabled={saving} onclick={() => setFlow(c, f.value)}>
                  {f.label}
                </button>
              {/each}
            </div>
            <div class="edit-line">
              {#if c.merchant_count === 0}
                <button class="btn danger" disabled={saving} onclick={() => remove(c)}>Delete</button>
              {:else}
                <span class="hint">{c.merchant_count} merchants use this category - it can be deleted once empty.</span>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
      {#if !ready}<p class="hint pad">Loading...</p>{/if}
    </div>

    <button class="btn primary add-btn" onclick={() => (adding = true)}>Add category</button>
    <p class="hint">
      Transactions are categorized automatically from these descriptions and your rules; change any one from
      its sheet. Uncategorized is built in and collects whatever is left.
    </p>
  </section>
</div>

{#if adding}
  <Sheet onclose={() => (adding = false)}>
    <span class="sheet-title">New category</span>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="edit-input"
      type="text"
      placeholder="Name..."
      autofocus
      bind:value={newName}
      onkeydown={(e) => e.key === 'Enter' && newName.trim() && add()}
    />
    <div class="edit-line">
      {#each KINDS as k (k)}
        <button class="chip" class:on={newKind === k} onclick={() => (newKind = k)}>{k}</button>
      {/each}
    </div>
    <div class="edit-line">
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving || !newName.trim()} onclick={add}>Add</button>
    </div>
  </Sheet>
{/if}

<style>
  .name-col { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; text-align: start; }
  .desc { font-size: 0.72rem; color: var(--text-secondary); line-height: 1.35; }
  .edit-input.desc-input { width: 100%; resize: vertical; font-size: 0.82rem; line-height: 1.4; }
  .sheet-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .add-btn { align-self: flex-start; margin-top: 10px; }
  .page {
    max-width: 620px;
    margin: 0 auto;
    padding: 18px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
    gap: 10px;
    width: 100%;
    padding: 11px 14px;
    text-align: start;
  }
  .row + .row, .editor + .row { border-top: 1px solid var(--border); }
  .row:active { background: var(--bg-hover); }
  .name { flex: 1; font-size: 0.9rem; color: var(--text-primary); }
  .kind {
    font-size: 0.68rem;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
  }
  .kind.income { color: #35679e; border-color: #35679e55; }
  .kind.excluded { opacity: 0.6; }
  .count { font-size: 0.75rem; color: var(--text-secondary); min-width: 20px; text-align: end; }

  .editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 14px 12px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
  }
  .edit-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .edit-input {
    font: inherit;
    font-size: 0.85rem;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-raised);
    color: var(--text-primary);
    flex: 1;
    min-width: 140px;
  }
  .edit-input:focus { outline: 2px solid var(--accent-light); outline-offset: -1px; }
  .chip {
    font-size: 0.74rem;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); font-weight: 600; }
  .btn {
    font-size: 0.78rem;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    background: var(--bg-raised);
  }
  .btn:active { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.4; }
  .btn.primary { color: #fff; background: var(--accent-deep); border-color: var(--accent-deep); }
  .btn.danger { color: var(--danger); border-color: var(--danger); }
  .spacer { flex: 1; }
  .hint { font-size: 0.72rem; color: var(--text-secondary); line-height: 1.5; margin: 8px 2px 0; }
  .hint.pad { padding: 10px 14px; margin: 0; }
  .hint.flow-lbl { margin: 0; }

  @media (hover: hover) {
    .row:hover { background: var(--bg-hover); }
    .btn:hover:not(:disabled) { background: var(--bg-hover); }
    .btn.primary:hover:not(:disabled) { background: var(--accent); }
  }
</style>
