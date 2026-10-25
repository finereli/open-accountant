<script lang="ts">
  import TopBar from '$shared/ui/TopBar.svelte'
  import Drawer from '$shared/ui/Drawer.svelte'
  import Toast from '$shared/ui/Toast.svelte'
  import ResetButton from '$shared/ui/ResetButton.svelte'
  import type { DrawerGroup } from '$shared/ui/Drawer.svelte'
  import { auth } from './lib/auth.svelte'
  import { router, type Route } from './lib/router.svelte'
  import { accounts } from './lib/stores.svelte'
  import { fmtCents } from './lib/money'
  import Dashboard from './views/Dashboard.svelte'
  import Account from './views/Account.svelte'
  import Reconcile from './views/Reconcile.svelte'
  import Sync from './views/Sync.svelte'
  import PlaidLink from './views/PlaidLink.svelte'
  import Spending from './views/Spending.svelte'
  import Forecast from './views/Forecast.svelte'
  import Plan from './views/Plan.svelte'
  import Settings from './views/Settings.svelte'
  import SettingsCategories from './views/SettingsCategories.svelte'
  import SettingsRules from './views/SettingsRules.svelte'
  import SettingsAgents from './views/SettingsAgents.svelte'

  router.start()
  auth.init()

  let menuOpen = $state(false)
  router.onChange(() => (menuOpen = false))

  const route = $derived(router.route)
  const currentAccount = $derived(
    route.view === 'account' || route.view === 'reconcile' ? accounts.byId(route.id) : undefined
  )
  const TITLES: Partial<Record<Route['view'], string>> = {
    dashboard: 'Accountant',
    reconcile: 'Reconcile',
    sync: 'Sync',
    'plaid-link': 'Reconnect bank',
    spending: 'Spending',
    forecast: 'Forecast',
    plan: 'Fun plan',
    settings: 'Settings',
    'settings-categories': 'Categories',
    'settings-rules': 'Rules',
    'settings-agents': 'Agents',
  }
  const title = $derived(TITLES[route.view] ?? currentAccount?.display_name ?? 'Account')

  const groups = $derived.by((): DrawerGroup[] => {
    const isCurrent = (id: string) => (route.view === 'account' || route.view === 'reconcile') && route.id === id
    // Same rule as the dashboard: dormant (zero-balance) accounts stay out
    // of the way - except the one currently open, which keeps its highlight.
    const active = (owner: string) =>
      accounts.list
        .filter((a) => (a.owner || '') === owner && (a.balance_cents !== 0 || isCurrent(a.id)))
        .map((a) => {
          const debt = a.kind === 'credit_card' || a.kind === 'line_of_credit'
          const warn = a.checkpoint !== null && a.checkpoint.discrepancy_cents !== 0
          const ok =
            a.checkpoint !== null &&
            a.checkpoint.discrepancy_cents === 0 &&
            (a.last_date === null || a.last_date <= a.checkpoint.date)
          return {
            label: a.display_name,
            hash: `/account/${a.id}`,
            current: isCurrent(a.id),
            trailing: fmtCents(debt ? -a.balance_cents : a.balance_cents, a.currency),
            status: warn ? ('warn' as const) : ok ? ('ok' as const) : undefined,
          }
        })
    return [
      {
        entries: [
          { label: 'Dashboard', hash: '/', current: route.view === 'dashboard' },
          { label: 'Spending', hash: '/spending', current: route.view === 'spending' },
          { label: 'Forecast', hash: '/forecast', current: route.view === 'forecast' },
          { label: 'Fun plan', hash: '/plan', current: route.view === 'plan' },
        ],
      },
      // One group per owner, in account order; accounts with no owner
      // share an untitled-looking "Accounts" group.
      ...[...new Set(accounts.list.map((a) => a.owner || ''))].map((o) => ({
        title: (o || 'Accounts').toUpperCase(),
        entries: active(o),
      })),
    ].filter((g) => !('title' in g) || g.entries.length > 0)
  })

  // Top-level screens show the hamburger; everything else is a sub-screen
  // with a back arrow.
  const topLevel = $derived(
    route.view === 'dashboard' ||
      route.view === 'spending' ||
      route.view === 'forecast' ||
      route.view === 'plan' ||
      route.view === 'settings'
  )

  function onleading() {
    if (topLevel) menuOpen = true
    // back() pops history (go() would push and trap the back button in a
    // reconcile/account loop); the fallback covers cold deep links.
    else if (route.view === 'reconcile') router.back(`/account/${route.id}`)
    else if (route.view === 'plaid-link') router.back('/sync')
    else if (route.view.startsWith('settings-') || route.view === 'sync') router.back('/settings')
    else router.back('/')
  }
</script>

<div class="shell">
  <TopBar leading={topLevel ? 'menu' : 'back'} {title} {onleading} />

  <div class="body">
    {#if route.view === 'account'}
      <Account id={route.id} />
    {:else if route.view === 'reconcile'}
      <Reconcile id={route.id} />
    {:else if route.view === 'sync'}
      <Sync />
    {:else if route.view === 'plaid-link'}
      <PlaidLink item={route.item} />
    {:else if route.view === 'spending'}
      <Spending />
    {:else if route.view === 'forecast'}
      <Forecast />
    {:else if route.view === 'plan'}
      <Plan />
    {:else if route.view === 'settings'}
      <Settings />
    {:else if route.view === 'settings-categories'}
      <SettingsCategories />
    {:else if route.view === 'settings-rules'}
      <SettingsRules />
    {:else if route.view === 'settings-agents'}
      <SettingsAgents />
    {:else}
      <Dashboard />
    {/if}
  </div>
</div>

<Drawer open={menuOpen} onclose={() => (menuOpen = false)} {groups}>
  {#snippet brand()}
    <strong class="brand-name">Accountant</strong>
  {/snippet}
  {#snippet footer()}
    <button class="menu-btn" onclick={() => router.go('/settings')}>Settings</button>
    <button class="menu-btn" onclick={() => auth.signOut()}>Logout</button>
    <p class="build">
      <span>Version {__BUILD__}</span>
      <ResetButton tabindex={menuOpen ? 0 : -1} />
    </p>
  {/snippet}
</Drawer>

<Toast />

<style>
  .shell { display: flex; flex-direction: column; height: 100%; }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-y: contain;
  }
  @media (min-width: 768px) {
    .shell { margin-inline-start: min(78vw, 300px); }
  }
  .brand-name { color: var(--accent-deep); font-size: 1.05rem; letter-spacing: 0.01em; }
  /* Footer actions share the drawer entries' type and layout. */
  .menu-btn {
    display: flex;
    align-items: center;
    width: 100%;
    text-align: start;
    padding: 13px 14px;
    margin: 0 -14px;
    border-radius: 12px;
    font-size: 0.95rem;
    color: var(--text-secondary);
    transition: background 0.15s;
  }
  .menu-btn:hover { background: var(--bg-hover); }
  .build { display: flex; align-items: center; gap: 6px; font-size: 0.65rem; color: var(--text-secondary); margin-top: 8px; }
  .build span { opacity: 0.6; }
</style>
