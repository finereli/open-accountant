// OAuth discovery for MCP clients (RFC 9728 protected resource, RFC 8414
// authorization server; some clients ask for openid-configuration).
import { protectedResource, authorizationServer, preflight } from '../_mcp-auth'

export const onRequest: PagesFunction = async ({ request, next }) => {
  if (request.method === 'OPTIONS') return preflight()
  const { pathname, origin } = new URL(request.url)
  if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') return protectedResource(origin)
  if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration') return authorizationServer(origin)
  return next()
}
