/** Request bodies the three providers send, with and without STRUCTURED_OUTPUT. fetch and the Gemini SDK are faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gemini = { config: undefined as unknown }
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(cfg: { generationConfig: unknown }) {
      gemini.config = cfg.generationConfig
      return { generateContent: async () => ({ response: { text: () => '{"orders":[]}', usageMetadata: { promptTokenCount: 10, totalTokenCount: 15 } } }) }
    }
  },
}))

const { getProvider, structuredOutputEnabled } = await import('./ai-provider.js')
const SCHEMA = { type: 'object', properties: { orders: { type: 'array' } } }

let bodies: Record<string, unknown>[] = []
let replyJson: unknown

beforeEach(() => {
  bodies = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('OPENAI_API_KEY', 'k')
  vi.stubEnv('ANTHROPIC_API_KEY', 'k')
  vi.stubEnv('GEMINI_API_KEY', 'k')
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify(replyJson), { status: 200 })
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('structuredOutputEnabled', () => {
  it('is off unless STRUCTURED_OUTPUT is truthy', () => {
    expect(structuredOutputEnabled()).toBe(false)
    for (const v of ['1', 'true', 'ON', 'yes']) {
      vi.stubEnv('STRUCTURED_OUTPUT', v)
      expect(structuredOutputEnabled()).toBe(true)
    }
    for (const v of ['0', 'false', '']) {
      vi.stubEnv('STRUCTURED_OUTPUT', v)
      expect(structuredOutputEnabled()).toBe(false)
    }
  })
})

describe('openai', () => {
  const ask = async (env: string | undefined, schema?: Record<string, unknown>) => {
    vi.stubEnv('STRUCTURED_OUTPUT', env ?? '')
    vi.stubEnv('AI_PROVIDER', 'openai')
    replyJson = { choices: [{ message: { content: '{"orders":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }
    return getProvider('nato').generateWithUsage('p', schema ? { schema } : undefined)
  }

  it('asks for JSON mode only when enabled and a schema is given', async () => {
    await ask('1', SCHEMA)
    expect(bodies[0].response_format).toEqual({ type: 'json_object' })
    await ask('1')
    expect(bodies[1].response_format).toBeUndefined()
    await ask('0', SCHEMA)
    expect(bodies[2].response_format).toBeUndefined()
  })
})

describe('anthropic', () => {
  const ask = async (env: string, schema?: Record<string, unknown>, reply?: unknown) => {
    vi.stubEnv('STRUCTURED_OUTPUT', env)
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    replyJson = reply ?? { content: [{ type: 'text', text: 'plain text' }], usage: { input_tokens: 3, output_tokens: 4 } }
    return getProvider('china').generateWithUsage('p', schema ? { schema } : undefined)
  }

  it('forces a tool call with the schema and returns the tool input as JSON text', async () => {
    const out = await ask('1', SCHEMA, { content: [{ type: 'tool_use', name: 'submit_orders', input: { orders: [{ action: 'research' }] } }], usage: { input_tokens: 3, output_tokens: 4 } })
    expect(bodies[0].tool_choice).toEqual({ type: 'tool', name: 'submit_orders' })
    expect((bodies[0].tools as { input_schema: unknown }[])[0].input_schema).toEqual(SCHEMA)
    expect(JSON.parse(out.text)).toEqual({ orders: [{ action: 'research' }] })
    expect(out).toMatchObject({ inputTokens: 3, outputTokens: 4 })
  })

  it('sends no tools when disabled, and still reads plain text', async () => {
    const out = await ask('0', SCHEMA)
    expect(bodies[0].tools).toBeUndefined()
    expect(bodies[0].tool_choice).toBeUndefined()
    expect(out.text).toBe('plain text')
  })
})

describe('gemini', () => {
  it('sets responseMimeType only when enabled and a schema is given', async () => {
    vi.stubEnv('AI_PROVIDER', 'gemini')
    vi.stubEnv('STRUCTURED_OUTPUT', '1')
    const p = getProvider('russia')
    await p.generateWithUsage('p', { schema: SCHEMA })
    expect(gemini.config).toMatchObject({ responseMimeType: 'application/json' })
    await p.generateWithUsage('p')
    expect(gemini.config).not.toHaveProperty('responseMimeType')
    vi.stubEnv('STRUCTURED_OUTPUT', '0')
    await p.generateWithUsage('p', { schema: SCHEMA })
    expect(gemini.config).not.toHaveProperty('responseMimeType')
  })
})
