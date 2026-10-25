// The classifier's plumbing around the model: what it reads from a row,
// which rows it asks about, and what it writes back. The model itself is
// faked - its quality is measured offline against labelled data.

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { bankHints, buildPrompt, classifyPending, parsePicks, requeue } from '../functions/api/_classify'
import type { Env } from '../functions/api/_lib'

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('wise-eur','alex','wise','wallet','EUR','Wise EUR',0,1);
    INSERT INTO categories (id, name, kind, sort, description) VALUES
      (1,'Food','expense',10,'Groceries and eating out'), (2,'Transport','expense',20,NULL);
    INSERT INTO merchants (id, household_name, created_at, category_id, category_auto) VALUES
      (10,'Lidl','2026-01-01',1,0), (11,'Named Only','2026-01-01',NULL,0);
    INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
      ('lidl',10,1,'x'), ('named',11,1,'x');
    INSERT INTO rules (text, sort, created_at, updated_at) VALUES ('Alex lives in Lisbon.', 0, 'x', 'x');
    INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key, meta) VALUES
      (1,'wise-eur','2026-08-10','Lidl Lisbon',-500,'t','h1','lidl',NULL),
      (2,'wise-eur','2026-08-11','Named thing',-700,'t','h2','named',NULL),
      (3,'wise-eur','2026-08-12','Card transaction of 1.40 GBP issued by Mercado Central',-160,'t','h3','mercado central',
       '{"details":{"type":"CARD","merchant":{"name":"Mercado Central Lda","city":"LISBON","country":"PT","category":"Grocery Stores"},"amount":{"value":1.4,"currency":"GBP"}},"amount":{"value":-1.6,"currency":"EUR"}}'),
      (4,'wise-eur','2026-08-13','Shell 123',-4000,'t','h4','shell',NULL);
  `)
})

function fakeEnv(answer: (prompt: string) => unknown): { env: Env; prompts: string[] } {
  const prompts: string[] = []
  const env = {
    DB: db,
    AI: {
      run: async (_model: string, input: Record<string, unknown>) => {
        const prompt = (input.messages as Array<{ content: string }>)[0].content
        prompts.push(prompt)
        return answer(prompt)
      },
    },
  } as unknown as Env
  return { env, prompts }
}

const resolved = async (id: number) =>
  (await db.prepare('SELECT * FROM tx_resolved WHERE id = ?').bind(id).first()) as Record<string, unknown>

describe('bankHints', () => {
  it('reads Wise card merchants and the original currency', () => {
    const h = bankHints(
      '{"details":{"type":"CARD","merchant":{"name":"Mercado Central Lda","city":"LISBON","country":"PT","category":"Grocery Stores"},"amount":{"value":1.4,"currency":"GBP"}},"amount":{"value":-1.6,"currency":"EUR"}}'
    )
    expect(h).toMatchObject({ kind: 'CARD', card_merchant: 'Mercado Central Lda', city: 'LISBON', country: 'PT', original_amount: '1.4 GBP' })
  })

  it("reads Plaid's merchant, MCC and category", () => {
    const h = bankHints(
      '{"merchant_name":"Cloudflare","merchant_category_code":"5734","personal_finance_category":{"detailed":"GENERAL_SERVICES_OTHER"},"counterparties":[{"name":"Cloudflare"}],"location":{}}'
    )
    expect(h).toEqual({ bank_merchant: 'Cloudflare', mcc: '5734', bank_category: 'GENERAL_SERVICES_OTHER' })
  })

  it('survives missing or broken meta', () => {
    expect(bankHints(null)).toEqual({})
    expect(bankHints('{oops')).toEqual({})
  })
})

describe('parsePicks', () => {
  it('keeps only rows that were asked about, tolerating prose around the JSON', () => {
    const p = parsePicks('Sure!\n[{"id":3,"merchant":"Mercado","category":"Food"},{"id":99,"merchant":"x"},{"id":4}]', new Set([3, 4]))
    expect(p).toEqual([
      { id: 3, merchant: 'Mercado', category: 'Food' },
      { id: 4, merchant: null, category: null },
    ])
  })
  it('returns nothing for unparseable answers', () => {
    expect(parsePicks('no idea', new Set([1]))).toEqual([])
  })
})

describe('buildPrompt', () => {
  it('carries rules, category descriptions and corrections', () => {
    const p = buildPrompt(
      {
        rules: ['AliExpress is for the kids'],
        accounts: ['Wise EUR'],
        categories: [{ name: 'Food', description: 'Groceries' }],
        merchants: ['Lidl'],
        corrections: ['- "x" -1.00 EUR on 2026-08-01: category is Food (not Shopping)'],
      },
      [{ id: 1 }]
    )
    expect(p).toContain('- AliExpress is for the kids')
    expect(p).toContain('- Food: Groceries')
    expect(p).toContain('category is Food (not Shopping)')
    expect(p).toContain('{"id":1}')
  })
})

describe('classifyPending', () => {
  it('asks only about undecided rows and writes auto picks', async () => {
    const { env, prompts } = fakeEnv(() => ({
      response:
        '[{"id":2,"merchant":"Named Only","category":"Food"},{"id":3,"merchant":"Mercado","category":"food"},{"id":4,"merchant":"Gas Station","category":"Transport"}]',
    }))
    const r = await classifyPending(env)
    expect(r).toMatchObject({ ok: true, skipped: 1, classified: 3, failed: 0, remaining: 0 })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('Lidl Lisbon') // fully decided by a person
    expect(prompts[0]).toContain('"merchant_is":"Named Only"') // merchant known, category open
    expect(prompts[0]).toContain('Alex lives in Lisbon.')
    expect(prompts[0]).toContain('"card_merchant":"Mercado Central Lda"')

    expect(await resolved(1)).toMatchObject({ res_merchant_id: 10, res_category_id: 1, category_source: 'human' })
    expect(await resolved(2)).toMatchObject({ res_merchant_id: 11, merchant_source: 'human', res_category_id: 1, category_source: 'auto' })
    const mercado = await resolved(3)
    expect(mercado).toMatchObject({ merchant_name: 'Mercado', merchant_source: 'auto', res_category_id: 1 })
    expect(await resolved(4)).toMatchObject({ merchant_name: 'Gas Station', res_category_id: 2 })
  })

  it('reuses merchants case-insensitively and never names a merchant "Transfer"', async () => {
    const { env } = fakeEnv(() => ({
      response: '[{"id":3,"merchant":"lidl","category":"Food"},{"id":4,"merchant":"Transfer","category":"Nope"}]',
    }))
    await classifyPending(env)
    expect(await resolved(3)).toMatchObject({ res_merchant_id: 10 })
    const t = (await db.prepare('SELECT auto_merchant_id, auto_category_id, auto_at FROM transactions WHERE id = 4').first()) as Record<
      string,
      unknown
    >
    expect(t.auto_merchant_id).toBeNull()
    expect(t.auto_category_id).toBeNull() // unknown category name
    expect(t.auto_at).not.toBeNull()
  })

  it('leaves rows in the queue when the model fails', async () => {
    const { env } = fakeEnv(() => {
      throw new Error('overloaded')
    })
    const r = await classifyPending(env)
    expect(r).toMatchObject({ classified: 0, failed: 3, remaining: 3 })
  })

  it('learns from logged corrections', async () => {
    db.exec(`INSERT INTO corrections (transaction_id, field, auto_value, human_value, created_at) VALUES (1,'category','Shopping','Food','x')`)
    const { env, prompts } = fakeEnv(() => ({ response: '[]' }))
    await classifyPending(env)
    expect(prompts[0]).toContain('"Lidl Lisbon" -5.00 EUR on 2026-08-10: category is Food (not Shopping)')
  })

  it('requeue puts everything back without touching human decisions', async () => {
    const { env } = fakeEnv(() => ({ response: '[{"id":4,"merchant":"Gas Station","category":"Transport"}]' }))
    await classifyPending(env)
    expect(await requeue(db)).toBe(4)
    expect(await resolved(1)).toMatchObject({ res_merchant_id: 10, category_source: 'human' })
    expect(await resolved(4)).toMatchObject({ merchant_name: 'Gas Station' }) // old pick shows until re-run
  })

  it('records which rules decided a row, and stops reading retired ones', async () => {
    db.exec(`INSERT INTO rules (id, text, sort, created_at, updated_at) VALUES (7, 'Mercado is a supermarket', 1, 'x', 'x'),
                                                                         (8, 'Old news', 2, 'x', 'x')`)
    db.exec(`UPDATE rules SET retired_at = 'x' WHERE id = 8`)
    const { env, prompts } = fakeEnv(() => ({
      response: '[{"id":3,"merchant":"Mercado","category":"Food","rules":[7,"R7",8,999]},{"id":4,"merchant":"Gas Station","category":"Transport","rules":[]}]',
    }))
    await classifyPending(env)
    expect(prompts[0]).toContain('[R7] Mercado is a supermarket')
    expect(prompts[0]).not.toContain('Old news')
    // Only active rules that exist are recorded, once.
    expect((await db.prepare('SELECT rule_id, transaction_id FROM rule_uses ORDER BY rule_id').all()).results).toEqual([
      { rule_id: 7, transaction_id: 3 },
    ])
    // Re-classifying the row replaces its uses.
    await requeue(db)
    await classifyPending(fakeEnv(() => ({ response: '[{"id":3,"merchant":"Mercado","category":"Food","rules":[]}]' })).env)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM rule_uses').first())).toEqual({ n: 0 })
  })
})

