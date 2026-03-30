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

export interface AIProvider {
  name: string
  generate(prompt: string): Promise<string>
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

  let client: any = null

  return {
    name: 'gemini',
    async generate(prompt: string): Promise<string> {
      if (!client) {
        const { GoogleGenerativeAI } = await import('@google/generative-ai')
        client = new GoogleGenerativeAI(key)
      }
      const model = client.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0.7,
          // @ts-ignore - disable thinking to save tokens
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
      const result: any = await withTimeout(model.generateContent(prompt), 15000, 'gemini')
      return result.response.text().trim()
    },
  }
}

// --- OpenAI ---

function createOpenAIProvider(): AIProvider {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set. Get one at https://platform.openai.com/api-keys')

  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

  return {
    name: 'openai',
    async generate(prompt: string): Promise<string> {
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
            max_tokens: 4096,
            temperature: 0.7,
          }),
        }),
        15000,
        'openai'
      )
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`OpenAI API error ${res.status}: ${err.slice(0, 200)}`)
      }
      const data = (await res.json()) as any
      return (data.choices?.[0]?.message?.content || '').trim()
    },
  }
}

// --- Anthropic ---

function createAnthropicProvider(): AIProvider {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set. Get one at https://console.anthropic.com/settings/keys')

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

  return {
    name: 'anthropic',
    async generate(prompt: string): Promise<string> {
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
            temperature: 0.7,
          }),
        }),
        15000,
        'anthropic'
      )
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Anthropic API error ${res.status}: ${err.slice(0, 200)}`)
      }
      const data = (await res.json()) as any
      const textBlock = data.content?.find((b: any) => b.type === 'text')
      return (textBlock?.text || '').trim()
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

/**
 * Validate that at least the default provider can be created.
 * Called at startup to fail fast.
 */
export function validateProvider(): void {
  getProvider()
}

/**
 * Log the provider configuration for all roles.
 */
export function logProviderConfig(): void {
  const globalDefault = (process.env.AI_PROVIDER || 'gemini').toLowerCase()
  const roles = ['nato', 'russia', 'china', 'narrator']

  console.log(`\nAI Provider Configuration:`)
  console.log(`  Default: ${globalDefault}`)

  for (const role of roles) {
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
