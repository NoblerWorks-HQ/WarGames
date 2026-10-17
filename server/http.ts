/** Small pure helpers for server/index.ts, kept separate so they can be unit-tested. */

export const MIN_INTERVAL_MS = 5000
export const MAX_INTERVAL_MS = 60000
export const DEFAULT_INTERVAL_MS = 10000

/** Clamp a client-supplied turn interval; anything non-numeric gets the default. */
export function clampInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || value === undefined || value === null || value === '') return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)))
}

/**
 * Only the local UI may call the API from a browser: the Vite dev server (:3000)
 * or this server itself when it serves dist/ (:3001). Requests without an Origin
 * header (curl, server-to-server) are allowed - the server binds to 127.0.0.1.
 */
export function isAllowedOrigin(origin: string | undefined, ports: number[] = [3000, 3001]): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    return u.protocol === 'http:' && local && ports.includes(Number(u.port))
  } catch {
    return false
  }
}

/**
 * True when the browser's Origin is this server itself (the built UI loads its script with
 * crossorigin, so it sends one). Only safe where nothing can spend money: a page on a
 * DNS-rebound hostname also passes this check, which is why it's used in READ_ONLY mode only.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
