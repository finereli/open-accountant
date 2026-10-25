// GET /api/transactions/:id - one transaction as the ledger shows it
// (resolved merchant and category), so the transaction sheet can show the
// result of a change without reloading the whole account.

import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { LEDGER_SELECT } from '../accounts/[id]/transactions'

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return error('Bad transaction id')
  const row = await env.DB.prepare(`${LEDGER_SELECT} WHERE t.id = ?`).bind(id).first()
  if (!row) return error('Unknown transaction', 404)
  return json({ transaction: row })
}
