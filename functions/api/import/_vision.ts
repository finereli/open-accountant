// Reading one strip of a bank-app screenshot into rows - shared by the
// one-shot POST /api/import/read and the background import jobs. The client
// slices a long scrolling screenshot into overlapping strips; merging and
// the balance-chain check happen client-side (src/lib/statement-import.ts),
// matching and writing in preview/commit.
//
// Model choice, measured on a real bank-app screenshot (41 rows): Qwen 3.8
// read every amount, balance, date and description exactly. Llama 4 Scout
// got the numbers but garbled descriptions ("Surg.com/" for "Surg.co/"),
// which splits merchant keys; Mistral Small lost the date headers.

import type { Env } from '../_lib'
import type { ReadRow } from '../../../src/lib/statement-import'

const MODEL = '@cf/qwen/qwen3.8-27b'

// Written against one banking app's layout and kept general on purpose;
// another app may need its own wording here (see README -> Screenshot import).
const PROMPT = `This is a screenshot of a bank account's transaction list. Extract every transaction row, top to bottom.
Date headers (e.g. "MON SEP 28, 2026" or "Today") apply to the rows below them; a date printed on the row itself wins. If rows appear before any date in the image, use null for their date.
Return ONLY JSON: {"rows":[{"date":"YYYY-MM-DD"|null,"type":"POS Purchase","detail":"Corner Bakery","amount":-42.09,"balance":308.32}]}
type: the row's main line (often bold). detail: its secondary line, copied exactly, or "" if there is none.
amount: signed, negative for money out, positive for deposits and credits (often shown in green or with a plus). balance: the running balance shown for the row, or null.
Skip any row that is cut off at the top or bottom edge.
__CARD__
If the image shows no transaction rows at all (a header, a blank band, the end of the list), return {"rows":[]}.`

// Card and line-of-credit screens show it the other way round: charges as
// plain amounts, payments and credits with a minus. The model copies the
// sign as shown; the ledger's sign (charges negative) is applied here.
const CARD_NOTE = `This is a credit card or line of credit. For amount, copy the number exactly as shown: plain for charges, purchases, interest and fees; with its minus sign for payments, refunds and credits. Do not apply the money-out rule above.`

export function promptFor(card: boolean): string {
  return PROMPT.replace('__CARD__', card ? CARD_NOTE : '').trim()
}

const cents = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null

// No JSON at all means the model saw nothing to extract (a blank band from
// a badly stitched scrolling capture, the app's header, the list's end) -
// that's an empty strip, not a failure. A missing row it should have seen
// still can't slip through: the balance chain breaks where it was.
export function parseModelRows(text: string): ReadRow[] {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return []
  const raw = (JSON.parse(m[0]) as { rows?: unknown[] }).rows
  if (!Array.isArray(raw)) throw new Error('model JSON has no rows')
  const rows: ReadRow[] = []
  for (const x of raw as Array<Record<string, unknown>>) {
    const amount = cents(x.amount)
    if (amount === null) continue
    const date = typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : null
    const description = [x.type, x.detail]
      .filter((s) => typeof s === 'string' && s.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    rows.push({ date, description: description || 'Imported transaction', amount_cents: amount, balance_cents: cents(x.balance) })
  }
  return rows
}

export async function isCardAccount(db: D1Database, accountId: string | undefined): Promise<boolean> {
  if (!accountId) return false
  const a = await db.prepare('SELECT kind FROM accounts WHERE id = ?').bind(accountId).first<{ kind: string }>()
  return a?.kind === 'credit_card' || a?.kind === 'line_of_credit'
}

export class ReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

// One strip -> rows in ledger sign. Throws ReadError on a model failure (500)
// or an answer that isn't the JSON asked for (422).
export async function readStrip(env: Env, image: string, card: boolean): Promise<ReadRow[]> {
  let out: unknown
  try {
    out = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptFor(card) },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      max_tokens: 4000,
      temperature: 0,
      // Reading a screen needs no deliberation.
      chat_template_kwargs: { enable_thinking: false },
    })
  } catch (e) {
    // Not 502: Cloudflare's edge swaps 502 bodies for its own page.
    throw new ReadError(`Vision model failed: ${e instanceof Error ? e.message : 'unknown'}`, 500)
  }
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: string } }> }
  const text =
    typeof o.response === 'string'
      ? o.response
      : o.response !== undefined
        ? JSON.stringify(o.response)
        : (o.choices?.[0]?.message?.content ?? '')
  let rows: ReadRow[]
  try {
    rows = parseModelRows(text)
  } catch (e) {
    throw new ReadError(`Couldn't read this part of the screenshot: ${e instanceof Error ? e.message : ''}`, 422)
  }
  return card
    ? rows.map((r) => ({ ...r, amount_cents: -r.amount_cents, balance_cents: r.balance_cents === null ? null : -r.balance_cents }))
    : rows
}
