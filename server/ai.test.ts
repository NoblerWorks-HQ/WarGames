/** getFactionOrders / getNarrative with the provider mocked: parsing, caps and usage reporting. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallUsage } from './usage.js'

let reply = ''
let tokens: { inputTokens?: number; outputTokens?: number } = { inputTokens: 1000, outputTokens: 500 }
let prompt = ''
let lastOpts: { schema?: { required?: string[] } } | undefined

vi.mock('./ai-provider.js', () => ({
  getProvider: () => ({
    name: 'gemini',
    model: 'gemini-3.5-flash-lite',
    generateWithUsage: async (p: string, opts?: typeof lastOpts) => {
      prompt = p
      lastOpts = opts
      return { text: reply, ...tokens }
    },
  }),
}))

const { getFactionOrders, getNarrative, MAX_ORDERS, MAX_NOTES_CHARS, ORDERS_SCHEMA } = await import('./ai.js')

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  tokens = { inputTokens: 1000, outputTokens: 500 }
})

const order = (n: number) => ({ action: 'fortify', territory: `t${n}` })

describe('getFactionOrders', () => {
  it('keeps at most MAX_ORDERS orders and strips code fences', async () => {
    reply = '```json\n' + JSON.stringify({ orders: [1, 2, 3, 4, 5].map(order), reasoning: 'r' }) + '\n```'
    const result = await getFactionOrders('nato', 'persona', '{}')
    expect(result.orders).toHaveLength(MAX_ORDERS)
    expect(MAX_ORDERS).toBe(3)
  })

  it('trims notes to the limit and drops notes that are not text', async () => {
    reply = JSON.stringify({ orders: [], notes: '  ' + 'x'.repeat(1000) })
    expect((await getFactionOrders('nato', 'p', '{}')).notes).toHaveLength(MAX_NOTES_CHARS)
    reply = JSON.stringify({ orders: [], notes: { plan: 'object' } })
    expect((await getFactionOrders('nato', 'p', '{}')).notes).toBeUndefined()
  })

  it('forfeits on unparseable output rather than throwing', async () => {
    reply = 'I would like to attack'
    const result = await getFactionOrders('nato', 'p', '{}')
    expect(result.orders).toEqual([])
    expect(result.reasoning).toMatch(/API error/)
  })

  it('tells the model the order cap, the one-action rule and the notes field', async () => {
    reply = JSON.stringify({ orders: [] })
    await getFactionOrders('nato', 'p', '{}')
    expect(prompt).toContain(`At most ${MAX_ORDERS} orders`)
    expect(prompt).toContain('once per turn')
    expect(prompt).toContain('"notes"')
  })

  it('reports tokens, latency and an estimated cost', async () => {
    reply = JSON.stringify({ orders: [] })
    const seen: CallUsage[] = []
    await getFactionOrders('nato', 'p', '{}', u => seen.push(u))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite', inputTokens: 1000, outputTokens: 500 })
    // 1000 in at $0.30/M + 500 out at $2.50/M
    expect(seen[0].costUsd).toBeCloseTo(0.00155, 8)
    expect(seen[0].latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a null cost when the provider returned no token counts', async () => {
    reply = JSON.stringify({ orders: [] })
    tokens = {}
    const seen: CallUsage[] = []
    await getFactionOrders('nato', 'p', '{}', u => seen.push(u))
    expect(seen[0].costUsd).toBeNull()
  })
})

describe('getNarrative', () => {
  it('returns the text, reports usage and asks for continuity and quotes', async () => {
    reply = 'Breaking news.'
    const seen: CallUsage[] = []
    expect(await getNarrative('Turn 1.', u => seen.push(u))).toBe('Breaking news.')
    expect(seen).toHaveLength(1)
    expect(prompt).toContain('previous bulletin')
  })
})

describe('structured output request', () => {
  it('passes the orders schema for factions and none for the narrator', async () => {
    reply = JSON.stringify({ orders: [] })
    await getFactionOrders('nato', 'p', '{}')
    expect(lastOpts?.schema).toBe(ORDERS_SCHEMA)
    expect(ORDERS_SCHEMA.required).toEqual(['orders', 'reasoning'])
    expect(ORDERS_SCHEMA.properties.orders.maxItems).toBe(MAX_ORDERS)
    expect(ORDERS_SCHEMA.properties.orders.items.properties.action.enum).toContain('build_nuke')
    reply = 'bulletin'
    await getNarrative('s')
    expect(lastOpts).toBeUndefined()
  })
})
