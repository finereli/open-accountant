// POST /api/merchants/rebuild-keys - recompute merchant_key for every
// transaction from its untouched raw description. Idempotent; run after the
// cleaner in merchantKey() changes. The raw description is the permanent
// record; keys are always derivable.
//
// Aliases MIGRATE with the keys: a human decision ("this key is Aldo") must
// survive the cleaner learning to spell the key better. For every key that
// changes, an alias on the old spelling is copied to the new spelling, and
// old-spelling aliases that no longer match any transaction are dropped.

import type { Env } from '../_lib'
import { json, merchantKey } from '../_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  const db = env.DB
  const rows = (
    await db.prepare('SELECT id, description, merchant_key FROM transactions').all()
  ).results as Array<{ id: number; description: string; merchant_key: string | null }>

  let updated = 0
  const stmts = []
  const keyMoves = new Map<string, string>() // old key -> new key
  for (const r of rows) {
    const key = merchantKey(r.description)
    if (key !== r.merchant_key) {
      if (r.merchant_key) keyMoves.set(r.merchant_key, key)
      stmts.push(db.prepare('UPDATE transactions SET merchant_key = ? WHERE id = ?').bind(key, r.id))
      updated++
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))

  let migrated = 0
  for (const [oldKey, newKey] of keyMoves) {
    const alias = await db
      .prepare('SELECT merchant_id, confirmed, created_at FROM merchant_aliases WHERE normalized_raw = ?')
      .bind(oldKey)
      .first<{ merchant_id: number; confirmed: number; created_at: string }>()
    if (!alias) continue
    await db
      .prepare(
        `INSERT OR IGNORE INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(newKey, alias.merchant_id, alias.confirmed, alias.created_at)
      .run()
    migrated++
  }
  // Old-spelling aliases whose key no longer exists on any transaction.
  const dropped = await db
    .prepare(
      `DELETE FROM merchant_aliases
       WHERE normalized_raw NOT IN (SELECT DISTINCT merchant_key FROM transactions WHERE merchant_key IS NOT NULL)`
    )
    .run()

  const distinct = await db
    .prepare('SELECT COUNT(DISTINCT merchant_key) AS n FROM transactions')
    .first<{ n: number }>()
  return json({
    ok: true,
    scanned: rows.length,
    updated,
    aliases_migrated: migrated,
    aliases_dropped: dropped.meta.changes ?? 0,
    distinct_keys: distinct?.n ?? 0,
  })
}
