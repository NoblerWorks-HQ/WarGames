/**
 * Provider retry/backoff. fetch is mocked; `sleep` is swapped for a recorder so
 * the backoff schedule is asserted without actually waiting.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRetryable, parseRetryAfter, ProviderHttpError, retryDefaults, withRetry } from './retry.js'

const realSleep = retryDefaults.sleep
let slept: number[] = []

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key'
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
})

beforeEach(() => {
  slept = []
  retryDefaults.sleep = async (ms) => {
    slept.push(ms)
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  retryDefaults.sleep = realSleep
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Queue one response (or thrown error) per fetch call. */
function fetchSequence(...steps: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = steps.shift()
    if (!next) throw new Error('fetch called more times than expected')
    if (next instanceof Error) throw next
    return next
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const openaiOk = () => json({ choices: [{ message: { content: ' {"orders":[]} ' } }] })
const anthropicOk = () => json({ content: [{ type: 'text', text: 'recap' }] })

async function provider(name: 'openai' | 'anthropic') {
  process.env.AI_PROVIDER = name
  const { getProvider } = await import('./ai-provider.js')
  return getProvider()
}

describe('provider calls (mocked fetch)', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    const fetchMock = fetchSequence(json({ error: 'rate limited' }, 429), openaiOk())
    const text = await (await provider('openai')).generate('hi')
    expect(text).toBe('{"orders":[]}')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(slept).toHaveLength(1)
  })

  it('retries 5xx with growing backoff, then succeeds', async () => {
    const fetchMock = fetchSequence(json({}, 503), json({}, 529), anthropicOk())
    vi.spyOn(Math, 'random').mockReturnValue(1) // top of the jitter range
    const text = await (await provider('anthropic')).generate('hi')
    expect(text).toBe('recap')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(slept).toEqual([1000, 2000])
  })

  it('gives up after the retry budget and surfaces the last error', async () => {
    const fetchMock = fetchSequence(json({}, 500), json({}, 500), json({ e: 'still down' }, 502))
    await expect((await provider('openai')).generate('hi')).rejects.toThrow(/OpenAI API error 502/)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 + retryDefaults.retries
  })

  it('does not retry a 401 (a bad key will not fix itself)', async () => {
    const fetchMock = fetchSequence(json({ error: 'bad key' }, 401))
    await expect((await provider('anthropic')).generate('hi')).rejects.toThrow(/Anthropic API error 401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('does not retry a 400', async () => {
    const fetchMock = fetchSequence(json({ error: 'bad request' }, 400))
    await expect((await provider('openai')).generate('hi')).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honours Retry-After, capped at maxDelayMs', async () => {
    fetchSequence(json({}, 429, { 'retry-after': '3' }), json({}, 429, { 'retry-after': '120' }), openaiOk())
    await (await provider('openai')).generate('hi')
    expect(slept).toEqual([3000, retryDefaults.maxDelayMs])
  })

  it('retries a network failure (fetch rejected with TypeError)', async () => {
    const fetchMock = fetchSequence(new TypeError('fetch failed'), anthropicOk())
    expect(await (await provider('anthropic')).generate('hi')).toBe('recap')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('retry helpers', () => {
  it('classifies retryable errors', () => {
    expect(isRetryable(new ProviderHttpError('x', 429))).toBe(true)
    expect(isRetryable(new ProviderHttpError('x', 500))).toBe(true)
    expect(isRetryable(new ProviderHttpError('x', 404))).toBe(false)
    // Gemini SDK errors carry a numeric `status`
    expect(isRetryable(Object.assign(new Error('sdk'), { status: 503 }))).toBe(true)
    expect(isRetryable(Object.assign(new Error('sdk'), { status: 403 }))).toBe(false)
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryable(new Error('gemini timed out after 15000ms'))).toBe(false)
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(null)).toBeUndefined()
    const now = Date.parse('2026-09-18T00:00:00Z')
    expect(parseRetryAfter('Fri, 18 Sep 2026 00:00:05 GMT', now)).toBe(5000)
    expect(parseRetryAfter('soon')).toBeUndefined()
  })

  it('withRetry returns the first success without sleeping', async () => {
    const fn = vi.fn(async () => 'ok')
    expect(await withRetry('t', fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })
})
