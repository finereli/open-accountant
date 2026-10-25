// The one fetch wrapper for an app's API. Attaches the session token,
// JSON-encodes plain-object bodies (files and streams pass through
// untouched), and funnels 401s into the auth store so a dead session
// re-prompts sign-in instead of leaving the app half-working.
//
//   // src/lib/api.ts
//   import { makeApi } from '$shared/lib/api'
//   import { auth } from './auth.svelte'
//   export const { api, apiJson } = makeApi(auth)
//
// Stores that call these should guard `res.ok` and keep `loading = true` on
// failure (a spinner, not a fake-empty list), and reset their loaded flag on
// auth.onChange so they refetch after re-auth. See reference/behavior.md.

export interface ApiAuth {
  readonly token: string | undefined
  handleUnauthorized(): void
}

export type ApiOptions = Omit<RequestInit, 'body' | 'headers'> & {
  body?: BodyInit | Record<string, unknown> | unknown[] | null
  headers?: Record<string, string>
}

export function makeApi(auth: ApiAuth) {
  async function api(path: string, opts: ApiOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers }
    if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`
    const isPlainBody = opts.body && typeof opts.body === 'object' &&
      !(opts.body instanceof ReadableStream) &&
      !(opts.body instanceof ArrayBuffer) &&
      !(opts.body instanceof Blob) &&
      !(opts.body instanceof FormData)
    let body = opts.body as BodyInit | null | undefined
    if (isPlainBody) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    // redirect: 'manual' - a sign-in gateway in front of the API (Cloudflare
    // Access) answers an expired session with a redirect to its login page,
    // which fetch can't follow cross-origin. Treat it as a 401.
    const res = await fetch(path, { redirect: 'manual', ...opts, body, headers })
    if (res.status === 401 || res.type === 'opaqueredirect') auth.handleUnauthorized()
    return res
  }

  // api() + res.ok check + parsed JSON, throwing a readable error otherwise.
  async function apiJson<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
    const res = await api(path, opts)
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error || `${opts.method || 'GET'} ${path} failed: ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  return { api, apiJson }
}
