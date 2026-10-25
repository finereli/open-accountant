// /mcp - the read-only MCP server (functions/_mcp.ts), behind OAuth
// (functions/_mcp-auth.ts). Not under /api/: it has its own bearer tokens.

import type { Env } from './api/_lib'
import { mcpRequest } from './_mcp'
import { bearerOk, unauthorized, preflight } from './_mcp-auth'
import { homeCurrency } from './api/_lib'

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method === 'OPTIONS') return preflight()
  if (!(await bearerOk(request, env.DB))) return unauthorized(new URL(request.url).origin)
  return mcpRequest(request, env.DB, homeCurrency(env))
}
