import type { Env } from '../api/_lib'
import { authorize, approve } from '../_mcp-auth'

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => authorize(request, env.DB, env)
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => approve(request, env.DB, env)
