import { describe, expect, it } from 'vitest'
import { estimateCost, priceFor } from './pricing.js'
import { UsageTracker } from './usage.js'
import { mulberry32, parseSeed } from './rng.js'

describe('pricing', () => {
  it('knows the default model of each provider', () => {
    expect(priceFor('gemini', 'gemini-3.5-flash-lite', {})).toEqual({ inputPerM: 0.3, outputPerM: 2.5 })
    expect(priceFor('openai', 'gpt-5.6-luna', {})).toEqual({ inputPerM: 0.2, outputPerM: 1.2 })
    expect(priceFor('anthropic', 'claude-sonnet-5', {})).toEqual({ inputPerM: 2, outputPerM: 10 })
  })

  it('has no price for an unknown model, so no cost is invented', () => {
    expect(priceFor('openai', 'some-local-llama', {})).toBeNull()
    expect(estimateCost('openai', 'some-local-llama', 100, 100, {})).toBeNull()
  })

  it('can be overridden per provider, but only when both prices are set', () => {
    const env = { OPENAI_PRICE_INPUT_PER_M: '1', OPENAI_PRICE_OUTPUT_PER_M: '4' }
    expect(priceFor('openai', 'some-local-llama', env)).toEqual({ inputPerM: 1, outputPerM: 4 })
    expect(priceFor('openai', 'some-local-llama', { OPENAI_PRICE_INPUT_PER_M: '1' })).toBeNull()
    expect(priceFor('openai', 'gpt-5.6-luna', { OPENAI_PRICE_INPUT_PER_M: 'abc', OPENAI_PRICE_OUTPUT_PER_M: '4' })).toEqual({ inputPerM: 0.2, outputPerM: 1.2 })
  })

  it('prices a call from its tokens', () => {
    expect(estimateCost('anthropic', 'claude-sonnet-5', 1_000_000, 100_000, {})).toBeCloseTo(3)
    expect(estimateCost('anthropic', 'claude-sonnet-5', undefined, 5, {})).toBeNull()
  })
})

describe('UsageTracker', () => {
  const call = (costUsd: number | null) => ({ provider: 'p', model: 'm', inputTokens: 10, outputTokens: 5, latencyMs: 100, costUsd })

  it('sums per role and in total', () => {
    const t = new UsageTracker()
    t.record('nato', call(0.5))
    t.record('nato', call(0.25))
    t.record('russia', call(1))
    const s = t.snapshot()
    expect(s.roles.nato).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10, latencyMs: 200, costUsd: 0.75, costComplete: true })
    expect(s.total).toMatchObject({ calls: 3, inputTokens: 30, costUsd: 1.75, costComplete: true })
  })

  it('flags an unpriced call as an incomplete (lower-bound) cost', () => {
    const t = new UsageTracker()
    t.record('nato', call(0.5))
    t.record('nato', call(null))
    const s = t.snapshot()
    expect(s.roles.nato).toMatchObject({ costUsd: 0.5, costComplete: false })
    expect(s.total.costComplete).toBe(false)
  })

  it('hands out a copy, not its own state', () => {
    const t = new UsageTracker()
    t.record('nato', call(1))
    t.snapshot().roles.nato.calls = 99
    expect(t.snapshot().roles.nato.calls).toBe(1)
  })
})

describe('seed parsing', () => {
  it('uses integers as given and hashes any other text', () => {
    expect(parseSeed('42')).toBe(42)
    expect(parseSeed(' 7 ')).toBe(7)
    expect(parseSeed('banana')).toBe(parseSeed('banana'))
    expect(parseSeed('banana')).not.toBe(parseSeed('apple'))
  })
  it('treats missing or empty as unseeded', () => {
    expect(parseSeed(undefined)).toBeUndefined()
    expect(parseSeed('')).toBeUndefined()
    expect(parseSeed('  ')).toBeUndefined()
  })
  it('is a deterministic generator that spreads over [0, 1)', () => {
    const r = mulberry32(1)
    const values = Array.from({ length: 2000 }, r)
    expect(values.every(v => v >= 0 && v < 1)).toBe(true)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
    const dice = values.map(v => Math.floor(v * 6) + 1)
    for (let face = 1; face <= 6; face++) expect(dice.filter(d => d === face).length).toBeGreaterThan(250)
  })
})
