<script lang="ts">
  // Agents with read-only access through the MCP server (/mcp): where to
  // point one, who's connected, and taking access back.
  import { apiJson } from '../lib/api'
  import { formatDate } from '$shared/lib/format'
  import { toasts } from '$shared/lib/toast.svelte'

  interface Client {
    id: string
    name: string | null
    created_at: string
    last_used: string | null
  }
  let clients = $state<Client[]>([])
  let url = $state('')
  let ready = $state(false)
  let busy = $state(false)

  async function load() {
    const r = await apiJson<{ items: Client[]; url: string }>('/api/mcp/clients')
    clients = r.items
    url = r.url
    ready = true
  }
  $effect(() => {
    load().catch((e) => toasts.error(e instanceof Error ? e.message : 'Load failed'))
  })

  async function revoke(c: Client) {
    if (busy) return
    busy = true
    const before = clients
    clients = clients.filter((x) => x.id !== c.id)
    try {
      await apiJson('/api/mcp/clients', { method: 'POST', body: { revoke: c.id } })
    } catch (e) {
      clients = before
      toasts.error(e instanceof Error ? e.message : 'Revoke failed')
    } finally {
      busy = false
    }
  }
</script>

<div class="page">
  <p class="hint">
    Claude or any MCP client can read the books - balances, transactions, spending, the forecast and the fun
    plan - but never change them. Add this as a custom connector; approving it means signing in with Google.
  </p>
  <div class="card url num">{url || '...'}</div>

  <h2>Connected</h2>
  <div class="card">
    {#each clients as c (c.id)}
      <div class="row">
        <span class="name">{c.name ?? 'Unnamed agent'}</span>
        <span class="detail">
          {c.last_used ? `used ${formatDate(c.last_used.slice(0, 10))}` : `added ${formatDate(c.created_at.slice(0, 10))}`}
        </span>
        <button class="btn" disabled={busy} onclick={() => revoke(c)}>Revoke</button>
      </div>
    {/each}
    {#if ready && clients.length === 0}<p class="hint pad">No agents connected.</p>{/if}
  </div>
</div>

<style>
  .page { max-width: 620px; margin: 0 auto; padding: 18px 16px; display: flex; flex-direction: column; gap: 10px; }
  .hint { font-size: 0.78rem; line-height: 1.5; color: var(--text-secondary); margin: 0 2px; }
  .hint.pad { padding: 12px 14px; margin: 0; }
  .card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .url { padding: 12px 14px; font-size: 0.84rem; color: var(--text-primary); user-select: all; word-break: break-all; }
  h2 { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-secondary); margin: 10px 2px 0; }
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
  .row + .row { border-top: 1px solid var(--border); }
  .name { font-size: 0.88rem; color: var(--text-primary); }
  .detail { flex: 1; font-size: 0.72rem; color: var(--text-secondary); text-align: end; }
  .btn { font-size: 0.76rem; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border); color: var(--danger); }
  .btn:disabled { opacity: 0.4; }
</style>
