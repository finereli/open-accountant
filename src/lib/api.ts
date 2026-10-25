import { makeApi } from '$shared/lib/api'
import { auth } from './auth.svelte'

export const { api, apiJson } = makeApi(auth)
