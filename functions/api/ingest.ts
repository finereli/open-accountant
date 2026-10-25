// POST /api/ingest - bulk transaction import from the local CLI (bank CSVs
// via ingest.config.json, and any other desktop-side source). All dedup and lock rules live in
// ingestRows - see _lib.ts.

import type { Env } from './_lib'
import { json, error, ingestRows, type IngestRowIn } from './_lib'

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let body: { rows?: IngestRowIn[] }
  try {
    body = await request.json()
  } catch {
    return error('Invalid JSON body')
  }
  const rows = body.rows
  if (!Array.isArray(rows) || rows.length === 0) return error('rows[] required')
  if (rows.length > 2000) return error('Too many rows in one request (max 2000)')

  return json(await ingestRows(env.DB, rows))
}
