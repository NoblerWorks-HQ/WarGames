/**
 * Retry with exponential backoff for AI provider calls.
 *
 * A turn asks the provider four times in ~10s. Without this, one 429 (rate
 * limit) or 5xx (provider overloaded) loses that faction's whole turn as a
 * forfeit. Retried: HTTP 429, any 5xx, and network-level failures (fetch threw
 * before a response). NOT retried: other 4xx (a bad key or bad request will not
 * fix itself) and our own timeouts (a 15s call retried twice would overrun the
 * turn interval several times over).
 *
 * The delay honours a Retry-After header when the provider sends one, capped at
 * maxDelayMs so a "come back in 60s" cannot stall the game.
 */

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries: number
  baseDelayMs: number
  maxDelayMs: number
  sleep: (ms: number) => Promise<void>
}

/** Mutable so tests can swap `sleep` for an instant recorder. */
export const retryDefaults: RetryOptions = {
  retries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Parse Retry-After (delta-seconds or an HTTP date) to milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/** Build a ProviderHttpError from a non-OK response, keeping the old message shape. */
export async function httpError(label: string, res: Response): Promise<ProviderHttpError> {
  const body = await res.text().catch(() => '')
  return new ProviderHttpError(
    `${label} API error ${res.status}: ${body.slice(0, 200)}`,
    res.status,
    parseRetryAfter(res.headers.get('retry-after'))
  )
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof ProviderHttpError) return err.status
  // The Gemini SDK's GoogleGenerativeAIFetchError carries `status`.
  const s = (err as { status?: unknown })?.status
  return typeof s === 'number' ? s : undefined
}

export function isRetryable(err: unknown): boolean {
  const status = statusOf(err)
  if (status !== undefined) return status === 429 || status >= 500
  // fetch() rejects with a TypeError on DNS/connection failures.
  return err instanceof TypeError
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs, sleep } = { ...retryDefaults, ...opts }
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err
      const backoff = baseDelayMs * 2 ** attempt
      const hinted = err instanceof ProviderHttpError ? err.retryAfterMs : undefined
      // Full jitter on the computed backoff; a server hint is taken as-is.
      const delay = Math.min(maxDelayMs, hinted ?? Math.round(backoff / 2 + Math.random() * (backoff / 2)))
      const reason = statusOf(err) ?? (err instanceof Error ? err.message : String(err))
      console.warn(`[${label}] attempt ${attempt + 1} failed (${reason}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
}
