import type { Env } from '../api/_lib'
import { register, preflight } from '../_mcp-auth'

export const onRequestOptions: PagesFunction<Env> = async () => preflight()
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => register(request, env.DB)
