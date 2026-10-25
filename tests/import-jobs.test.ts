// Background screenshot reading: all strips read at once, a stalled strip is
// picked up again by the next poll, card statements come out in ledger sign.

import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from './d1'
import { createJob, workJob, jobStatus } from '../functions/api/import/_jobs'

let db: ReturnType<typeof makeTestDb>

beforeEach(() => {
  db = makeTestDb()
  db.exec(`
    INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
      ('chq','alex','Bank','chequing','CAD','Chequing',0,1),
      ('visa','alex','Bank','credit_card','CAD','Visa',1,1);
  `)
})

// The model "reads" each strip as one row whose amount is the strip number.
function env(opts: { fail?: Set<string>; inflight?: { now: number; max: number } } = {}) {
  return {
    DB: db,
    AI: {
      run: async (_m: string, input: Record<string, unknown>) => {
        const content = (input.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0].content
        const url = content.find((c) => c.type === 'image_url')!.image_url!.url
        if (opts.inflight) {
          opts.inflight.now++
          opts.inflight.max = Math.max(opts.inflight.max, opts.inflight.now)
        }
        await new Promise((r) => setTimeout(r, 5))
        if (opts.inflight) opts.inflight.now--
        if (opts.fail?.has(url)) throw new Error('overloaded')
        const n = Number(url.split(',')[1])
        return { response: JSON.stringify({ rows: [{ date: '2026-10-01', type: 'Row', detail: `${n}`, amount: n, balance: null }] }) }
      },
    },
  } as any
}

const strips = (n: number) => Array.from({ length: n }, (_, i) => `data:image/jpeg;base64,${i + 1}`)

describe('import jobs', () => {
  it('reads every strip at once and hands back rows per strip', async () => {
    const id = await createJob(db as any, 'chq', strips(5))
    const inflight = { now: 0, max: 0 }
    await workJob(env({ inflight }), id)
    expect(inflight.max).toBe(5)
    const s = await jobStatus(db as any, id)
    expect(s).toMatchObject({ total: 5, done: 5, failed: [], finished: true, needs_work: false })
    expect(s!.strips!.map((r) => r[0].amount_cents)).toEqual([100, 200, 300, 400, 500])
  })

  it('retries a failed strip on the next poll, and gives up after three tries', async () => {
    const id = await createJob(db as any, 'chq', strips(2))
    const fail = new Set(['data:image/jpeg;base64,2'])
    await workJob(env({ fail }), id)
    expect(await jobStatus(db as any, id)).toMatchObject({ done: 1, finished: false, needs_work: true })
    await workJob(env({ fail }), id)
    await workJob(env({ fail }), id)
    expect(await jobStatus(db as any, id)).toMatchObject({ done: 1, failed: [2], finished: true })
  })

  it('picks up a strip whose worker died mid-read once its claim goes stale', async () => {
    const id = await createJob(db as any, 'chq', strips(1))
    db.exec(`UPDATE import_strips SET status = 'working', attempts = 1, claimed_at = '2020-01-01T00:00:00Z'`)
    expect(await jobStatus(db as any, id)).toMatchObject({ needs_work: true })
    await workJob(env(), id)
    expect(await jobStatus(db as any, id)).toMatchObject({ done: 1, finished: true })
  })

  it('flips card statements into ledger sign (charges negative)', async () => {
    const id = await createJob(db as any, 'visa', strips(1))
    await workJob(env(), id)
    expect((await jobStatus(db as any, id))!.strips![0][0].amount_cents).toBe(-100)
  })

  it('a new screenshot replaces the open import for that account', async () => {
    const a = await createJob(db as any, 'chq', strips(1))
    const b = await createJob(db as any, 'chq', strips(2))
    expect(await jobStatus(db as any, a)).toBeNull()
    expect(await jobStatus(db as any, b)).toMatchObject({ total: 2 })
  })
})
