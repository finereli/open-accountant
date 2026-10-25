import { Router } from '$shared/lib/router.svelte'

export type Route =
  | { view: 'dashboard' }
  | { view: 'account'; id: string }
  | { view: 'reconcile'; id: string }
  | { view: 'sync' }
  | { view: 'plaid-link'; item: number }
  | { view: 'spending' }
  | { view: 'forecast' }
  | { view: 'plan' }
  | { view: 'settings' }
  | { view: 'settings-categories' }
  | { view: 'settings-rules' }
  | { view: 'settings-agents' }

export const router = new Router<Route>({
  home: '/',
  parse(path) {
    const account = path.match(/^\/account\/([\w-]+)$/)
    if (account) return { view: 'account', id: account[1] }
    const reconcile = path.match(/^\/reconcile\/([\w-]+)$/)
    if (reconcile) return { view: 'reconcile', id: reconcile[1] }
    if (path === '/sync') return { view: 'sync' }
    const relink = path.match(/^\/plaid-link\/(\d+)$/)
    if (relink) return { view: 'plaid-link', item: Number(relink[1]) }
    if (path === '/spending') return { view: 'spending' }
    if (path === '/forecast') return { view: 'forecast' }
    if (path === '/plan') return { view: 'plan' }
    if (path === '/settings') return { view: 'settings' }
    if (path === '/settings/categories') return { view: 'settings-categories' }
    if (path === '/settings/rules') return { view: 'settings-rules' }
    if (path === '/settings/agents') return { view: 'settings-agents' }
    return { view: 'dashboard' }
  },
})
