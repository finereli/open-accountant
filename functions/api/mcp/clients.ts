// GET /api/mcp/clients - agents with access to the MCP, for Settings.
// POST /api/mcp/clients - { revoke: client_id } takes it back.
import type { Env } from '../_lib'
import { json, error } from '../_lib'
import { listClients, revoke } from '../../_mcp-auth'

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) =>
  json({ items: await listClients(env.DB), url: `${new URL(request.url).origin}/mcp` })

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const b = (await request.json().catch(() => null)) as { revoke?: string } | null
  if (!b?.revoke) return error('revoke (client id) required')
  await revoke(env.DB, b.revoke)
  return json({ ok: true })
}
