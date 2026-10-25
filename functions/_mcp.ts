// The MCP server: the Accountant's numbers for an agent (Claude or any MCP client),
// read only. Streamable HTTP, stateless: every POST is one JSON-RPC message
// (or a batch) answered with JSON.
//
// The tools reuse the app's own queries and the Forecast screen's math
// (src/lib/forecast.ts, src/lib/allowance.ts), so an agent sees the numbers
// the owner sees. Money goes out as decimal amounts with a currency.

import { accountsData } from './api/accounts'
import { forecastData } from './api/forecast'
import { allowanceData } from './api/allowance/index'
import { spendingRows } from './api/spending'
import { project, cashStart, burnLines, baseItems, daysUntil } from '../src/lib/forecast'
import { monthPlans, allowanceItems, monthsBetween, type AllowanceData } from '../src/lib/allowance'
import { convertCents } from '../src/lib/money'

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
// The home currency (HOME_CURRENCY) is the default for totals; set per request.
let HOME = 'USD'

const money = (cents: number) => Math.round(cents) / 100
const today = () => new Date().toISOString().slice(0, 10)
const curOf = (v: unknown) => {
  const c = String(v ?? HOME).toUpperCase()
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('currency must be a 3-letter code like USD')
  return c
}
const limitOf = (v: unknown, def: number, max: number) => Math.max(1, Math.min(max, Number(v) || def))
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

async function converter(db: D1Database, cur: string) {
  const acc = await accountsData(db, HOME)
  const conv = (cents: number, from: string) => convertCents(cents, from, cur, acc.fx) ?? 0
  return { acc, conv }
}

const currencyArg = { type: 'string', description: "Currency to convert totals into (3-letter code; default: the owner's home currency). Native amounts are always included too." }

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (db: D1Database, a: Record<string, any>) => Promise<unknown>
}

const TOOLS: Tool[] = [
  {
    name: 'get_overview',
    description:
      "Every account with its owner, balance from the trusted ledger, last transaction, and reconciliation state (the last bank-verified balance and any mismatch), plus cash and debt totals for the accounts in the spending plan.",
    inputSchema: { type: 'object', properties: { currency: currencyArg } },
    run: async (db, a) => {
      const cur = curOf(a.currency)
      const { acc, conv } = await converter(db, cur)
      const debt = (k: string) => k === 'credit_card' || k === 'line_of_credit'
      const accounts = (acc.accounts as Array<Record<string, any>>).map((x) => ({
        id: x.id,
        name: x.display_name,
        owner: x.owner,
        institution: x.institution,
        kind: x.kind,
        currency: x.currency,
        balance: money(x.balance_cents),
        [`balance_${cur}`]: money(conv(x.balance_cents, x.currency)),
        transactions: x.tx_count,
        last_transaction: x.last_date,
        reconciled_to: x.checkpoint?.date ?? null,
        reconcile_mismatch: x.checkpoint ? money(x.checkpoint.discrepancy_cents) : null,
      }))
      const planned = (acc.accounts as Array<Record<string, any>>).filter((x) => x.in_spending === 1)
      return {
        today: today(),
        currency: cur,
        cash: money(planned.filter((x) => !debt(x.kind)).reduce((s, x) => s + conv(x.balance_cents, x.currency), 0)),
        debt: money(-planned.filter((x) => debt(x.kind)).reduce((s, x) => s + conv(x.balance_cents, x.currency), 0)),
        note: 'Debt accounts carry negative balances (money owed). Dormant accounts have a zero balance.',
        accounts,
        fx_date: acc.fx_date,
      }
    },
  },
  {
    name: 'get_forecast',
    description:
      "The cash forecast as the Forecast screen shows it: starting cash (the cash accounts in the plan), daily burn per run-rate category (measured over a trailing window, or pinned), derived subscriptions, expected income and expenses, and the fun allowance; projected forward to the low point, the day cash hits zero, and the runway.",
    inputSchema: {
      type: 'object',
      properties: {
        currency: currencyArg,
        window_days: { type: 'number', description: 'Trailing window for measured burn rates, 7-365 (default 60)' },
        horizon_days: { type: 'number', description: 'How far to project, up to 1095 (default 91)' },
      },
    },
    run: async (db, a) => {
      const cur = curOf(a.currency)
      const window = Math.round(limitOf(a.window_days, 60, 365))
      if (window < 7) throw new Error('window_days must be 7-365')
      const horizon = Math.round(limitOf(a.horizon_days, 91, 1095))
      const { acc, conv } = await converter(db, cur)
      const [fc, al] = await Promise.all([forecastData(db, window), allowanceData(db)])
      const t = today()
      const start = cashStart(acc.accounts as any, conv)
      const lines = burnLines(fc.burn as any, window, conv)
      const daily = lines.reduce((s, l) => s + l.daily, 0)
      const base = baseItems(fc.items as any, fc.subs as any, conv)
      const plans = monthPlans(al as unknown as AllowanceData, monthsBetween(t, new Date(Date.now() + 1095 * 86400000).toISOString()), conv)
      const items = [...base, ...allowanceItems(plans, t)]
      const p = project(start, daily, items, t, horizon)
      const long = project(start, daily, items, t, 1095)
      const runway = long.zero ? daysUntil(t, long.zero.date) : null
      const monthEnds = p.points.filter((pt, i) => i + 1 < p.points.length && p.points[i + 1].date.endsWith('-01'))
      return {
        today: t,
        currency: cur,
        starting_cash: money(start),
        daily_burn: money(daily),
        burn_by_category: lines.map((l) => ({ category: l.name, per_day: money(l.daily), per_month: money((l.daily * 365) / 12), pinned: l.pinned, measured_per_day: money(l.measured) })),
        subscriptions: (fc.subs as Array<Record<string, any>>).map((s) => ({ name: s.name, monthly: money(s.monthly_cents), currency: s.currency, day: s.day, ends: s.end_date })),
        expected: (fc.items as Array<Record<string, any>>).map((i) => ({
          name: i.name,
          kind: i.kind,
          amount: money(i.amount_cents),
          currency: i.currency,
          when: i.per_day ? 'daily' : i.date ? i.date : `monthly on day ${i.day_of_month}${i.end_month ? ` until ${i.end_month}` : ''}`,
        })),
        fun_allowance: plans.filter((pl) => pl.month <= p.end.date.slice(0, 7)).map((pl) => ({ month: pl.month, allowance: money(pl.allowance), planned: money(pl.planned), over: money(pl.over) })),
        projection: {
          horizon_days: horizon,
          low_point: { date: p.low.date, cash: money(p.low.cents) },
          cash_hits_zero: long.zero?.date ?? null,
          runway_days: runway,
          runway_months: runway === null ? null : Math.round((runway / (365 / 12)) * 10) / 10,
          end: { date: p.end.date, cash: money(p.end.cents) },
          month_ends: monthEnds.map((pt) => ({ date: pt.date, cash: money(pt.cents) })),
        },
        notes: 'Run-rate categories are averaged over the window; a pinned category uses a fixed rate instead. The fun allowance lands on the 1st of each month (the current month: tomorrow); plan items inside it cost nothing extra.',
      }
    },
  },
  {
    name: 'get_spending',
    description:
      "One month of spending from the accounts that count toward spending, by category and merchant, as the Spending screen shows it. Transfers between the household's own accounts are left out, except debt repayments and borrowing, which show under excluded categories.",
    inputSchema: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM (default: this month)' }, currency: currencyArg, merchants_per_category: { type: 'number', description: 'Top merchants listed per category (default 8)' } },
    },
    run: async (db, a) => {
      const cur = curOf(a.currency)
      const month = typeof a.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(a.month) ? a.month : today().slice(0, 7)
      const [y, mo] = month.split('-').map(Number)
      const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`
      const { conv } = await converter(db, cur)
      const cats = (await db.prepare('SELECT id, name, kind FROM categories').all<{ id: number; name: string; kind: string }>()).results
      const idOf = (n: string) => cats.find((c) => c.name === n)?.id ?? null
      const rows = await spendingRows(db, `${month}-01`, to, idOf('Debt Repay'), idOf('Debt Borrow'))
      const byCat = new Map<string, { category: string; kind: string; total: number; count: number; merchants: Map<string, number> }>()
      for (const r of rows) {
        const c = cats.find((x) => x.id === r.category_id)
        const key = c?.name ?? 'Uncategorized'
        const g = byCat.get(key) ?? byCat.set(key, { category: key, kind: c?.kind ?? 'expense', total: 0, count: 0, merchants: new Map() }).get(key)!
        const v = conv(r.total_cents, r.currency)
        g.total += v
        g.count += r.count
        g.merchants.set(r.label, (g.merchants.get(r.label) ?? 0) + v)
      }
      const n = limitOf(a.merchants_per_category, 8, 50)
      const categories = [...byCat.values()]
        .sort((x, y2) => x.total - y2.total)
        .map((g) => ({
          category: g.category,
          kind: g.kind,
          total: money(g.total),
          transactions: g.count,
          top_merchants: [...g.merchants.entries()].sort((x, y2) => x[1] - y2[1]).slice(0, n).map(([name, v]) => ({ name, total: money(v) })),
        }))
      const sum = (k: string) => money(categories.filter((c) => c.kind === k).reduce((s, c) => s + c.total * 100, 0))
      return { month, currency: cur, spent: sum('expense'), income: sum('income'), categories, note: 'Spending is negative, money in positive.' }
    },
  },
  {
    name: 'list_transactions',
    description:
      'Transactions from the ledger, newest first, with the merchant and category as resolved (people\'s decisions win over the auto-categorizer). Filter by account, date range, category, merchant or text.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'An account id from get_overview' },
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        category: { type: 'string', description: "A category name, or 'Uncategorized'" },
        merchant: { type: 'string', description: 'Merchant name (case-insensitive, partial)' },
        query: { type: 'string', description: 'Text in the bank description or memo' },
        limit: { type: 'number', description: 'Up to 500, default 50' },
      },
    },
    run: async (db, a) => {
      const where: string[] = []
      const args: unknown[] = []
      if (a.account_id) (where.push('t.account_id = ?'), args.push(String(a.account_id)))
      if (isDate(a.from)) (where.push('t.date >= ?'), args.push(a.from))
      if (isDate(a.to)) (where.push('t.date <= ?'), args.push(a.to))
      if (a.category) {
        if (String(a.category).toLowerCase() === 'uncategorized') where.push('t.res_category_id IS NULL AND t.transfer_account_id IS NULL')
        else (where.push('c.name = ? COLLATE NOCASE'), args.push(String(a.category)))
      }
      if (a.merchant) (where.push('COALESCE(t.merchant_name, t.merchant_concept) LIKE ?'), args.push(`%${String(a.merchant)}%`))
      if (a.query) (where.push('(t.description LIKE ? OR t.memo LIKE ?)'), args.push(`%${a.query}%`, `%${a.query}%`))
      const limit = limitOf(a.limit, 50, 500)
      const rows = (
        await db
          .prepare(
            `SELECT t.id, t.date, t.account_id, ac.display_name AS account, ac.currency, t.description, t.memo, t.amount_cents,
                    COALESCE(t.merchant_name, t.merchant_concept) AS merchant, ta.display_name AS transfer_to,
                    c.name AS category, t.category_source
             FROM tx_resolved t
             JOIN accounts ac ON ac.id = t.account_id
             LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
             LEFT JOIN categories c ON c.id = t.res_category_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY t.date DESC, t.id DESC LIMIT ?`
          )
          .bind(...args, limit + 1)
          .all<Record<string, any>>()
      ).results
      return {
        items: rows.slice(0, limit).map((r) => ({
          id: r.id,
          date: r.date,
          account: r.account,
          account_id: r.account_id,
          amount: money(r.amount_cents),
          currency: r.currency,
          description: r.description,
          memo: r.memo,
          merchant: r.transfer_to ? `Transfer: ${r.transfer_to}` : r.merchant,
          category: r.transfer_to ? null : (r.category ?? 'Uncategorized'),
          categorized_by: r.category_source,
        })),
        more: rows.length > limit,
      }
    },
  },
  {
    name: 'get_fun_plan',
    description:
      "The fun allowance and its plan, month by month from this month on: the allowance (a month's own amount or the default), the things planned into it (in or out of the plan), what's left or over, and whether the month's plan is locked.",
    inputSchema: { type: 'object', properties: { currency: currencyArg, months: { type: 'number', description: 'How many months from this one (default 4)' } } },
    run: async (db, a) => {
      const cur = curOf(a.currency)
      const { conv } = await converter(db, cur)
      const al = (await allowanceData(db)) as unknown as AllowanceData
      const t = today()
      const n = limitOf(a.months, 4, 24)
      const months = monthsBetween(t, new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 + n - 1, 1)).toISOString())
      return {
        currency: cur,
        default_allowance: al.default ? { amount: money(al.default.amount_cents), currency: al.default.currency } : null,
        months: monthPlans(al, months, conv).map((p) => ({
          month: p.month,
          allowance: money(p.allowance),
          own_amount: p.custom,
          planned: money(p.planned),
          left: money(p.left),
          over: money(p.over),
          locked: p.locked_at,
          items: p.items.map((i) => ({ name: i.name, amount: money(i.amount_cents), currency: i.currency, date: i.date, in_plan: !!i.active })),
        })),
        note: 'Fun spending is planned on purpose (Underearners Anonymous: some fun even when money is tight). The allowance is already in the forecast; only going over it costs runway.',
      }
    },
  },
  {
    name: 'list_categories',
    description: 'The categories, with what belongs in each and how the forecast treats them (run_rate = averaged daily burn, subscriptions = monthly per merchant, discrete/off = neither).',
    inputSchema: { type: 'object', properties: {} },
    run: async (db) => ({
      items: (await db.prepare('SELECT name, kind, flow, description FROM categories ORDER BY sort, id').all()).results,
    }),
  },
]

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }
const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result })
const rpcError = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function handle(db: D1Database, m: Rpc): Promise<object | null> {
  // A notification (no id) gets no answer.
  if (m.id === undefined || m.id === null) return null
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.protocolVersion ?? '')
      return reply(m.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'accountant', title: 'Accountant (read only)', version: '1.0.0' },
        instructions:
          "Read-only access to a household's Accountant: trusted per-account ledgers in their own currencies, categorized spending, the cash forecast with its runway, and the monthly fun allowance and plan. Nothing here can change the books.",
      })
    }
    case 'ping':
      return reply(m.id, {})
    case 'tools/list':
      return reply(m.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })),
      })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name)
      if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${m.params?.name}`)
      try {
        const out = await tool.run(db, m.params?.arguments ?? {})
        return reply(m.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out })
      } catch (e) {
        return reply(m.id, { content: [{ type: 'text', text: e instanceof Error ? e.message : 'That did not work' }], isError: true })
      }
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`)
  }
}

export async function mcpRequest(request: Request, db: D1Database, home = 'USD'): Promise<Response> {
  HOME = home
  if (request.method !== 'POST') return new Response('This MCP server answers POST only.', { status: 405, headers: { Allow: 'POST' } })
  let body: Rpc | Rpc[]
  try {
    body = await request.json()
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 })
  }
  const list: Rpc[] = Array.isArray(body) ? body : [body]
  const answers = (await Promise.all(list.map((m) => handle(db, m)))).filter(Boolean)
  if (!answers.length) return new Response(null, { status: 202 })
  return Response.json(Array.isArray(body) ? answers : answers[0])
}

export const toolNames = TOOLS.map((t) => t.name)
