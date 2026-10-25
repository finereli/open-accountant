<!-- The app's one editing surface (see CLAUDE.md, "Editing surfaces"):
     a bottom sheet sliding up over a scrim on mobile, a centered modal on
     desktop (offset for the nav drawer). Scrim tap and Escape close it.
     TxSheet, the transaction editor, is built on it. -->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    onclose,
    tall = false,
    children,
  }: {
    onclose: () => void
    // tall: pickers and lists want at least half the screen; short forms don't.
    tall?: boolean
    children: Snippet
  } = $props()
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="scrim" onclick={onclose} role="presentation"></div>
<div class="sheet" class:tall>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 40;
    animation: fade-in 0.2s ease;
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .sheet {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    z-index: 41;
    background: var(--bg-raised);
    border-radius: 16px 16px 0 0;
    padding: 18px 16px calc(var(--safe-bottom) + 18px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-height: 80dvh;
    overflow-y: auto;
    box-shadow: var(--shadow);
    animation: slide-up 0.28s cubic-bezier(0.32, 0.72, 0, 1);
  }
  .sheet.tall { min-height: 50dvh; }
  @keyframes slide-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  @media (min-width: 768px) {
    .scrim { inset-inline-start: min(78vw, 300px); }
    .sheet {
      inset-inline-start: min(78vw, 300px);
      inset-block: 0;
      max-width: 520px;
      min-height: 0;
      max-height: max-content;
      margin: auto;
      border-radius: var(--radius);
      animation: pop-in 0.2s ease;
    }
    .sheet.tall { min-height: 0; }
    @keyframes pop-in {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
  }
</style>
