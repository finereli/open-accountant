// Core of the LLM merchant-proposal pass, shared by the POST endpoint and
// the post-sync hook (sync endpoints fire it via waitUntil so fresh
// transactions get proposals without anyone asking). Llama (Workers AI,
// free, on-platform: no spending data leaves Cloudflare) looks at merchant
// keys with no alias yet and may match each to an EXISTING merchant or a
// concept from the fixed list. Proposals land as confirmed=0 aliases -
// visible in the ledger as provisional, applied to nothing until a human
// confirms or corrects. Matching is closed-world: candidates are the household's
// own merchants, never the internet.

import type { Env } from './_lib'

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export interface ProposeResult {
  ok: boolean
  message?: string
  considered?: number
  proposed?: number
  remaining?: number
}

export async function runPropose(env: Env, limit = 40): Promise<ProposeResult> {
  if (!env.AI || typeof env.AI.run !== 'function')
    return { ok: false, message: 'AI binding not attached - check [ai] in wrangler.toml and redeploy' }

  const db = env.DB

  // Unmatched keys with recognition context: where seen, how often, amounts.
  const unmatched = (
    await db
      .prepare(
        `SELECT t.merchant_key AS key, COUNT(*) AS n,
                MIN(t.amount_cents) AS min_c, MAX(t.amount_cents) AS max_c,
                GROUP_CONCAT(DISTINCT t.account_id) AS accounts
         FROM transactions t
         LEFT JOIN merchant_aliases a ON a.normalized_raw = t.merchant_key
         WHERE a.normalized_raw IS NULL AND t.merchant_key IS NOT NULL AND t.merchant_key != ''
         GROUP BY t.merchant_key
         ORDER BY n DESC
         LIMIT ?`
      )
      .bind(limit)
      .all()
  ).results as Array<{ key: string; n: number; min_c: number; max_c: number; accounts: string }>

  if (unmatched.length === 0) return { ok: true, proposed: 0, remaining: 0 }

  // The keep-as-is marker merchant (both fields null) is not a match target.
  // Only CONFIRMED aliases are shown as evidence - the model's own
  // unconfirmed guesses must not feed back as if they were knowledge.
  const merchants = (
    await db
      .prepare(
        `SELECT m.id, m.household_name, m.concept,
                GROUP_CONCAT(a.normalized_raw, ' | ') AS aliases
         FROM merchants m LEFT JOIN merchant_aliases a ON a.merchant_id = m.id AND a.confirmed = 1
         WHERE m.household_name IS NOT NULL OR m.concept IS NOT NULL
         GROUP BY m.id`
      )
      .all()
  ).results as Array<{ id: number; household_name: string | null; concept: string | null; aliases: string | null }>

  const merchantList = merchants
    .map((m) => `${m.id}: ${m.household_name ?? m.concept ?? '?'}${m.aliases ? ` (aliases: ${m.aliases})` : ''}`)
    .join('\n')
  const keyList = unmatched
    .map(
      (u, i) =>
        `${i}: "${u.key}" (${u.n} txns, ${(u.min_c / 100).toFixed(2)}..${(u.max_c / 100).toFixed(2)}, on ${u.accounts})`
    )
    .join('\n')

  const prompt = `You are matching raw bank-statement merchant strings to a household's known merchants.
The strings may come from any country - names may be abbreviated, transliterated, misspelled, or in another language.

KNOWN MERCHANTS (id: name):
${merchantList || '(none yet)'}

UNMATCHED STRINGS (index: "string" with context):
${keyList}

For each string, respond with ONE of:
- {"i": <index>, "merchant_id": <id>} if it clearly belongs to a known merchant: the same shop (spelling/transliteration variant, different source), OR a one-off place of a generalized type that already exists ("Gas Station", "Restaurant")
- {"i": <index>, "name": "<Name>"} to propose a merchant that doesn't exist yet: a well-known brand ("cloudflare" -> "Cloudflare"), a person ("sent money to Simeon Petranov" -> "Simeon Petranov"), or a generalized type for a one-off place not worth naming individually ("an obvious car wash" -> "Car Wash")
- skip it entirely if unsure

Rules:
- Prefer matching an existing merchant by id over proposing a new name. Only propose a new generalized type when no existing one fits.
- Nameless internal money movement is NOT a merchant: "topped up account", currency conversions, e-transfers, credit card bill payments. Skip those.
- "Bank Fee" is ONLY for actual fees and interest charged by a bank or payment provider (e.g. "wise charges for: card", "interest charges"). Taxes and government payments (CRA, ministries) are NOT bank fees - name the agency instead. Person-to-person e-transfers are NOT bank fees - skip them.
- Be conservative: a wrong match is much worse than no match. Never invent merchant ids.
Answer with a JSON array only, no prose.`

  let raw: unknown
  try {
    raw = await env.AI.run(MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    })
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Workers AI failed' }
  }

  // Workers AI returns `response` as a string for prose, but as an
  // ALREADY-PARSED object when the model answers in pure JSON. Handle both.
  const response = (raw as { response?: unknown }).response
  let items: Array<{ i: number; merchant_id?: number; name?: string }>
  if (Array.isArray(response)) {
    items = response
  } else if (typeof response === 'string') {
    const jsonMatch = response.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return { ok: false, message: `Model returned no JSON array: ${response.slice(0, 200)}` }
    try {
      items = JSON.parse(jsonMatch[0])
    } catch {
      return { ok: false, message: `Model JSON did not parse: ${jsonMatch[0].slice(0, 200)}` }
    }
  } else {
    return { ok: false, message: `Unexpected model response shape: ${JSON.stringify(response).slice(0, 200)}` }
  }
  if (!Array.isArray(items)) return { ok: false, message: 'Model answer was not an array' }

  const validIds = new Set(merchants.map((m) => m.id))
  const now = new Date().toISOString()
  let proposed = 0

  // Proposed names become merchants - still only proposals (confirmed=0)
  // until a human agrees. Get-or-create case-insensitively so repeated runs
  // and casing wobbles ("Gas station") never mint duplicates.
  async function namedMerchantId(name: string): Promise<number> {
    const existing = await db
      .prepare('SELECT id FROM merchants WHERE household_name = ? COLLATE NOCASE')
      .bind(name)
      .first<{ id: number }>()
    if (existing) return existing.id
    const res = await db
      .prepare('INSERT INTO merchants (household_name, created_at) VALUES (?, ?)')
      .bind(name, now)
      .run()
    return res.meta.last_row_id as number
  }

  for (const it of items) {
    const u = unmatched[it.i]
    if (!u) continue
    let merchantId: number | null = null
    if (it.merchant_id && validIds.has(it.merchant_id)) merchantId = it.merchant_id
    else if (typeof it.name === 'string' && it.name.trim().length >= 2 && it.name.trim().length <= 40)
      merchantId = await namedMerchantId(it.name.trim())
    if (merchantId === null) continue
    await db
      .prepare(
        `INSERT OR IGNORE INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at)
         VALUES (?, ?, 0, ?)`
      )
      .bind(u.key, merchantId, now)
      .run()
    proposed++
  }

  const remaining = await db
    .prepare(
      `SELECT COUNT(DISTINCT t.merchant_key) AS n FROM transactions t
       LEFT JOIN merchant_aliases a ON a.normalized_raw = t.merchant_key
       WHERE a.normalized_raw IS NULL AND t.merchant_key IS NOT NULL AND t.merchant_key != ''`
    )
    .first<{ n: number }>()

  return { ok: true, considered: unmatched.length, proposed, remaining: remaining?.n ?? 0 }
}
