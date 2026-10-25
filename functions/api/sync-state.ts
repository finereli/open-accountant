// GET /api/sync-state - when each source last completed a sync, and what it
// did. The Sync screen shows this before any sync is started.

import type { Env } from './_lib'
import { json } from './_lib'

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = (await env.DB.prepare('SELECT source, synced_at, summary FROM sync_state').all()).results
  return json({ sources: rows })
}
