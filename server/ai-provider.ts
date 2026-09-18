/**
 * AI Provider abstraction - supports Gemini, OpenAI, and Anthropic
 *
 * Global default:
 *   AI_PROVIDER=gemini (or openai, anthropic)
 *
 * Per-faction overrides:
 *   NATO_AI_PROVIDER=anthropic
 *   RUSSIA_AI_PROVIDER=gemini
 *   CHINA_AI_PROVIDER=openai
 *   NARRATOR_AI_PROVIDER=anthropic
 *
 * Each provider needs its corresponding API key set:
 *   GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
 */

import type { GoogleGenerativeAI } from '@google/generative-ai'
import { httpError, withRetry } from './retry.js'

export interface AIProvider {
  name: string
  /** The model id this provider sends, after env overrides. */
  model: string
  /** Env var a user sets to change the model - named in startup errors. */
  modelEnvVar: string
  /** Env var holding the API key - named in startup errors. */
  keyEnvVar: string
  generate(prompt: string): Promise<string>
  /**
   * Ask the provider whether `model` exists. One cheap metadata GET, no tokens
   * spent. Called once at server boot by validateProviders(), never per turn.
   */
  checkModel(): Promise<ModelCheck>
}

/**
 * Outcome of a startup model check.
 *   ok          - the provider confirmed the model id
 *   bad-model   - the provider says the model does not exist (fatal)
 *   bad-key     - the provider rejected the API key (fatal)
 *   unverified  - could not tell (network down, timeout, 5xx, 429, or an
 *                 OpenAI-compatible server without a models endpoint) - warn only
 */
export interface ModelCheck {
  status: 'ok' | 'bad-model' | 'bad-key' | 'unverified'
  detail?: string
}

const MODEL_CHECK_TIMEOUT_MS = 5000

/** Map a models-endpoint HTTP response to a ModelCheck. */
async function classifyModelResponse(res: Response): Promise<ModelCheck> {
  if (res.ok) return { status: 'ok' }
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
  if (res.status === 404) return { status: 'bad-model', detail: body }
  if (res.status === 401 || res.status === 403) return { status: 'bad-key', detail: body }
  // Gemini reports a bad key as 400 API_KEY_INVALID rather than 401.
  if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) {
    return { status: 'bad-key', detail: body }
  }
  return { status: 'unverified', detail: `HTTP ${res.status} ${body}`.trim() }
}

async function fetchModelCheck(url: string, headers: Record<string, string>): Promise<ModelCheck> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS) })
    return await classifyModelResponse(res)
  } catch (err) {
    return { status: 'unverified', detail: err instanceof Error ? err.message : String(err) }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

// --- Gemini ---

function createGeminiProvider(): AIProvider {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set. Get one at https://aistudio.google.com/apikey')

  const modelId = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
  // Gemini 2.5 takes thinkingBudget: 0 to switch thinking off. Gemini 3.x uses
  // thinkingLevel instead and its levels differ per model (3.8 Flash rejects
  // "minimal"), so leave 3.x on its own default - 3.5 Flash-Lite defaults to
  // minimal thinking already.
  const thinkingConfig = modelId.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : undefined

  let client: GoogleGenerativeAI | null = null

  return {
    name: 'gemini',
    model: modelId,
    modelEnvVar: 'GEMINI_MODEL',
    keyEnvVar: 'GEMINI_API_KEY',
    async generate(prompt: string): Promise<string> {
      if (!client) {
        const { GoogleGenerativeAI } = await import('@google/generative-ai')
        client = new GoogleGenerativeAI(key)
      }
      const model = client.getGenerativeModel({
        model: modelId,
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0.7,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      })
      // 429/5xx are retried with backoff (server/retry.ts); the SDK error carries `status`.
      const result = await withRetry('gemini', () =>
        withTimeout(model.generateContent(prompt), 15000, 'gemini')
      )
      return result.response.text().trim()
    },
    checkModel() {
      return fetchModelCheck(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}`,
        { 'x-goog-api-key': key }
      )
    },
  }
}

// --- OpenAI ---

function createOpenAIProvider(): AIProvider {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set. Get one at https://platform.openai.com/api-keys')

  const defaultBaseUrl = 'https://api.openai.com/v1'
  const baseUrl = (process.env.OPENAI_BASE_URL || defaultBaseUrl).replace(/\/+$/, '')
  const isCustomBaseUrl = baseUrl !== defaultBaseUrl
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna'

  // OpenAI's reasoning models (GPT-5 family onward, o-series) reject max_tokens
  // and a non-default temperature on Chat Completions. They take
  // max_completion_tokens plus reasoning_effort; "none" keeps a turn inside the
  // 15s timeout. Older and OpenAI-compatible local models keep the classic body.
  const isReasoningModel = /^(gpt-[5-9]|o\d)/.test(model)
  const tuning = isReasoningModel
    ? {
        max_completion_tokens: 4096,
        reasoning_effort: process.env.OPENAI_REASONING_EFFORT || 'none',
      }
    : { max_tokens: 4096, temperature: 0.7 }

  return {
    name: 'openai',
    model,
    modelEnvVar: 'OPENAI_MODEL',
    keyEnvVar: 'OPENAI_API_KEY',
    async generate(prompt: string): Promise<string> {
      return withRetry('openai', async () => {
        const res = await withTimeout(
          fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              ...tuning,
            }),
          }),
          15000,
          'openai'
        )
        if (!res.ok) throw await httpError('OpenAI', res)
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        return (data.choices?.[0]?.message?.content || '').trim()
      })
    },
    async checkModel() {
      const result = await fetchModelCheck(`${baseUrl}/models/${encodeURIComponent(model)}`, {
        Authorization: `Bearer ${key}`,
      })
      // OpenAI-compatible servers (Ollama, LM Studio, vLLM, Azure) do not all
      // implement GET /models/{id}, so a 404 there proves nothing - warn only.
      if (isCustomBaseUrl && result.status === 'bad-model') {
        return { status: 'unverified', detail: `${baseUrl}/models/${model} returned 404` }
      }
      return result
    },
  }
}

// --- Anthropic ---

function createAnthropicProvider(): AIProvider {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set. Get one at https://console.anthropic.com/settings/keys')

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
  // Sonnet 5 / Opus 5 / Opus 4.7+ reject temperature with a 400, so it is not
  // sent. Thinking is switched off to keep turns fast and cheap (as with the
  // Gemini thinkingBudget: 0 above); Fable/Mythos models reject an explicit
  // "disabled", so they are left on their default.
  const thinking = /fable|mythos/.test(model) ? {} : { thinking: { type: 'disabled' } }

  return {
    name: 'anthropic',
    model,
    modelEnvVar: 'ANTHROPIC_MODEL',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    async generate(prompt: string): Promise<string> {
      return withRetry('anthropic', async () => {
        const res = await withTimeout(
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              messages: [{ role: 'user', content: prompt }],
              ...thinking,
            }),
          }),
          15000,
          'anthropic'
        )
        if (!res.ok) throw await httpError('Anthropic', res)
        const data = (await res.json()) as { content?: { type: string; text?: string }[] }
        const textBlock = data.content?.find(b => b.type === 'text')
        return (textBlock?.text || '').trim()
      })
    },
    checkModel() {
      return fetchModelCheck(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      })
    },
  }
}

// --- Factory ---

const _providers = new Map<string, AIProvider>()

function createProvider(providerName: string): AIProvider {
  switch (providerName) {
    case 'gemini':
      return createGeminiProvider()
    case 'openai':
    case 'chatgpt':
      return createOpenAIProvider()
    case 'anthropic':
    case 'claude':
      return createAnthropicProvider()
    default:
      throw new Error(
        `Unknown AI provider: "${providerName}". Use: gemini, openai, or anthropic`
      )
  }
}

/**
 * Get the AI provider for a given role (faction or narrator).
 *
 * Resolution order:
 *   1. Per-role env var: NATO_AI_PROVIDER, RUSSIA_AI_PROVIDER, CHINA_AI_PROVIDER, NARRATOR_AI_PROVIDER
 *   2. Global fallback: AI_PROVIDER (defaults to "gemini")
 *
 * Providers are cached - same provider name reuses the same instance.
 */
export function getProvider(role?: string): AIProvider {
  const globalDefault = (process.env.AI_PROVIDER || 'gemini').toLowerCase()

  let providerName = globalDefault
  if (role) {
    const roleKey = `${role.toUpperCase()}_AI_PROVIDER`
    const roleOverride = process.env[roleKey]
    if (roleOverride) {
      providerName = roleOverride.toLowerCase()
    }
  }

  let provider = _providers.get(providerName)
  if (!provider) {
    provider = createProvider(providerName)
    _providers.set(providerName, provider)
    console.log(`AI Provider initialized: ${providerName}${role ? ` (for ${role})` : ''}`)
  }

  return provider
}

const ROLES = ['nato', 'russia', 'china', 'narrator']

/**
 * Validate every provider the game will use, once, at server boot.
 *
 * 1. Constructs the provider for each role (fails on a missing API key or an
 *    unknown provider name) - synchronous, no network.
 * 2. Asks each distinct provider whether its configured model id exists, via
 *    that provider's model-metadata endpoint (no tokens spent):
 *      - model confirmed         -> continue
 *      - model not found (404)   -> throw, naming the *_MODEL env var to change
 *      - API key rejected        -> throw, naming the *_API_KEY env var
 *      - anything else (offline, timeout, 5xx, 429, or an OpenAI-compatible
 *        server with no models endpoint) -> warn and continue; a real problem
 *        will then show up on the first turn instead
 *    Set SKIP_MODEL_CHECK=1 to skip step 2 entirely (e.g. fully offline setups).
 */
export async function validateProviders(): Promise<void> {
  const providers = new Set<AIProvider>([getProvider(), ...ROLES.map((r) => getProvider(r))])

  if (process.env.SKIP_MODEL_CHECK === '1') {
    console.warn('SKIP_MODEL_CHECK=1 - model ids were not verified against the providers.')
    return
  }

  const results = await Promise.all(
    [...providers].map(async (p) => ({ p, check: await p.checkModel() }))
  )

  const errors: string[] = []
  for (const { p, check } of results) {
    const detail = check.detail ? `\n    ${check.detail}` : ''
    switch (check.status) {
      case 'ok':
        console.log(`Model verified: ${p.name} -> ${p.model}`)
        break
      case 'bad-model':
        errors.push(
          `${p.name}: model "${p.model}" does not exist or is not available to this API key. ` +
            `Set ${p.modelEnvVar} in .env to a current model id.${detail}`
        )
        break
      case 'bad-key':
        errors.push(`${p.name}: the API key was rejected. Check ${p.keyEnvVar} in .env.${detail}`)
        break
      case 'unverified':
        console.warn(
          `WARNING: could not verify ${p.name} model "${p.model}" at startup - continuing. ` +
            `If turns fail, check ${p.modelEnvVar}.${detail}`
        )
        break
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

/**
 * Log the provider configuration for all roles.
 */
export function logProviderConfig(): void {
  const globalDefault = (process.env.AI_PROVIDER || 'gemini').toLowerCase()
  console.log(`\nAI Provider Configuration:`)
  console.log(`  Default: ${globalDefault}`)

  for (const role of ROLES) {
    const roleKey = `${role.toUpperCase()}_AI_PROVIDER`
    const override = process.env[roleKey]
    if (override) {
      console.log(`  ${role}: ${override.toLowerCase()} (override)`)
    } else {
      console.log(`  ${role}: ${globalDefault}`)
    }
  }
  console.log()
}
