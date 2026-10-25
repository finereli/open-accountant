<script lang="ts">
  // The settings hub: each concern is its own screen, reached from here and
  // returning here via the top-bar back arrow. Gates and account scope slot
  // in as new rows later.
  import { router } from '../lib/router.svelte'

  const items = [
    { label: 'Categories', detail: 'add, describe, reorder, delete', path: '/settings/categories' },
    { label: 'Rules', detail: 'what the auto-categorizer knows', path: '/settings/rules' },
    { label: 'Sync', detail: 'Wise and exchange rates', path: '/sync' },
    { label: 'Agents', detail: 'read-only access for Claude and other AI agents', path: '/settings/agents' },
  ]
</script>

<div class="page">
  <div class="card">
    {#each items as it (it.path)}
      <button class="row" onclick={() => router.go(it.path)}>
        <span class="label">{it.label}</span>
        <span class="detail">{it.detail}</span>
        <span class="chev">›</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .page {
    max-width: 620px;
    margin: 0 auto;
    padding: 18px 16px;
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
    padding: 14px;
    text-align: start;
  }
  .row + .row { border-top: 1px solid var(--border); }
  .row:active { background: var(--bg-hover); }
  .label { font-size: 0.92rem; color: var(--text-primary); }
  .detail { flex: 1; font-size: 0.74rem; color: var(--text-secondary); text-align: end; }
  .chev { color: var(--text-secondary); font-size: 1.1rem; }
  @media (hover: hover) {
    .row:hover { background: var(--bg-hover); }
  }
</style>
