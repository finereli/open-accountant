<script lang="ts">
  // Plaid Link update mode: restores a linked bank after Plaid says it needs
  // a fresh login. Loads Plaid's Link script, fetches an update-mode token
  // for bank number `item` from our API, and opens the flow. Success needs no
  // token exchange - the bank's connection heals in place.
  import { apiJson } from '../lib/api'
  import { router } from '../lib/router.svelte'

  let { item }: { item: number } = $props()

  let status = $state<'loading' | 'ready' | 'open' | 'done' | 'failed'>('loading')
  let message = $state('')

  type PlaidGlobal = { create: (cfg: Record<string, unknown>) => { open: () => void } }
  const plaid = () => (window as unknown as { Plaid?: PlaidGlobal }).Plaid

  async function init() {
    try {
      if (!plaid()) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script')
          s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
          s.onload = () => resolve()
          s.onerror = () => reject(new Error('Could not load Plaid Link'))
          document.head.appendChild(s)
        })
      }
      const { link_token } = await apiJson<{ link_token: string }>('/api/plaid/link-token', {
        method: 'POST',
        body: { item },
      })
      status = 'ready'
      const handler = plaid()!.create({
        token: link_token,
        onSuccess: () => {
          status = 'done'
          message = 'Bank connection restored.'
        },
        onExit: (err: { display_message?: string; error_message?: string } | null) => {
          if (status !== 'done') {
            status = 'failed'
            message = err?.display_message || err?.error_message || 'Link closed without finishing.'
          }
        },
      })
      status = 'open'
      handler.open()
    } catch (e) {
      status = 'failed'
      message = e instanceof Error ? e.message : 'Something went wrong'
    }
  }

  $effect(() => {
    init()
  })
</script>

<div class="page">
  <section class="card">
    <h2>Reconnect through Plaid</h2>
    {#if status === 'loading'}
      <p>Preparing Plaid Link...</p>
    {:else if status === 'open' || status === 'ready'}
      <p>Complete the bank login in the Plaid window.</p>
    {:else if status === 'done'}
      <p class="ok">{message}</p>
      <button class="btn" onclick={() => router.go('/sync')}>Run sync</button>
    {:else}
      <p class="fail">{message}</p>
      <button class="btn" onclick={() => init()}>Try again</button>
    {/if}
  </section>
</div>

<style>
  .page { max-width: 620px; margin: 0 auto; padding: 18px 16px; }
  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); }
  p { font-size: 0.88rem; color: var(--text-secondary); line-height: 1.5; }
  .ok { color: var(--ok); }
  .fail { color: var(--danger); }
  .btn {
    align-self: flex-start;
    padding: 9px 18px;
    border-radius: var(--radius);
    background: var(--accent-deep);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 500;
  }
</style>
