/** Tournament schedule, runner, budget and resume. The AI layer is mocked: no keys, no spend. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CallUsage } from './usage.js'

const COST_PER_CALL = 0.001
vi.mock('./ai.js', () => ({
  getFactionOrders: vi.fn(async (_f: string, _p: string, _b: string, onUsage?: (u: CallUsage) => void) => {
    onUsage?.({ provider: 'test', model: 'm', inputTokens: 10, outputTokens: 5, latencyMs: 100, costUsd: COST_PER_CALL })
    return { orders: [], reasoning: '' }
  }),
  getNarrative: vi.fn(async () => 'narrative'),
}))

const { GameEngine } = await import('./engine.js')
const { SaveStore } = await import('./saves.js')
const { makeEntrants, schedule, runTournament, resultsMarkdown, SEATS } = await import('./tournament.js')
const ai = await import('./ai.js')
type Cfg = Parameters<typeof runTournament>[0]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wargames-tourney-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(ai.getNarrative).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const entrants = makeEntrants([{ provider: 'gemini' }, { provider: 'openai' }, { provider: 'anthropic', model: 'x' }], s => `${s.provider}-default`)
const cfg = (over: Partial<Cfg> = {}): Cfg => ({
  id: 't1', entrants, scenarios: ['default', 'mirror'], rounds: 1, maxTurns: 2, budgetUsd: 100, narrate: false, structuredOutput: false, ...over,
})
const deps = (pins: Record<string, unknown>[] = [], sub = '') => ({
  makeEngine: (g: { seed: number; scenario: string }) => new GameEngine({ seed: g.seed, scenario: g.scenario, narrate: false }),
  store: new SaveStore(join(dir, sub)),
  pinSeats: (p: Record<string, unknown>) => void pins.push(p),
})

describe('makeEntrants', () => {
  it('labels by provider/model and numbers repeats', () => {
    expect(entrants.map(e => e.label)).toEqual(['gemini/gemini-default', 'openai/openai-default', 'anthropic/x'])
    const self = makeEntrants([{ provider: 'gemini' }, { provider: 'gemini' }, { provider: 'openai' }], () => 'm')
    expect(self.map(e => e.label)).toEqual(['gemini/m', 'gemini/m#2', 'openai/m'])
  })
})

describe('schedule', () => {
  it('puts every entrant in every seat once per scenario and round, with one seed per round', () => {
    const games = schedule({ id: 't', entrants, scenarios: ['default', 'mirror'], rounds: 2 })
    expect(games).toHaveLength(12)
    for (const round of [1, 2]) {
      const inRound = games.filter(g => g.round === round)
      expect(new Set(inRound.map(g => g.seed)).size).toBe(1)
      for (const sc of ['default', 'mirror']) {
        const set = inRound.filter(g => g.scenario === sc)
        for (const seat of SEATS) expect(new Set(set.map(g => g.seats[seat])).size).toBe(3)
        for (const g of set) expect(new Set(Object.values(g.seats)).size).toBe(3)
      }
    }
    expect(games[0].seed).not.toBe(games[11].seed)
    expect(new Set(games.map(g => g.id)).size).toBe(12)
  })

  it('needs exactly three entrants', () => {
    expect(() => schedule({ id: 't', entrants: entrants.slice(0, 2), scenarios: ['default'], rounds: 1 })).toThrow('exactly 3')
  })
})

describe('runTournament', () => {
  it('plays every game to the end, pins seats per game, and credits wins to the model in the seat', async () => {
    const pins: Record<string, unknown>[] = []
    const r = await runTournament(cfg({ scenarios: ['default'] }), deps(pins))
    expect(r).toMatchObject({ scheduled: 3, finished: 3, incomplete: 0, stoppedForBudget: false })
    expect(pins).toHaveLength(3)
    expect(pins[0]).toEqual({ nato: entrants[0].spec, russia: entrants[1].spec, china: entrants[2].spec })
    // Nobody acts and the game ends on turn 2 by score: NATO's head start wins every game,
    // so each model wins exactly the game it sat in NATO's chair.
    for (const g of r.games) expect(g).toMatchObject({ finished: true, turns: 2, victor: 'nato', winner: g.seats.nato })
    for (const e of r.entrants) {
      expect(e).toMatchObject({ games: 3, wins: 1, draws: 0, winRate: 1 / 3, forfeits: 6, avgLatencyMs: 100 })
      expect(e.bySeat).toEqual({ nato: { games: 1, wins: 1 }, russia: { games: 1, wins: 0 }, china: { games: 1, wins: 0 } })
      expect(e.costUsd).toBeCloseTo(6 * COST_PER_CALL)
    }
    expect(r.seatWinRate).toEqual({ nato: 1, russia: 0, china: 0 })
    expect(r.costUsd).toBeCloseTo(18 * COST_PER_CALL)
    // No narrator calls when narration is off
    expect(ai.getNarrative).not.toHaveBeenCalled()
  })

  it('stops at the budget, and re-running with the same id resumes to the same result', async () => {
    const full = await runTournament(cfg(), deps([], 'uninterrupted'))

    // Each turn costs 3 calls = $0.003; stop partway through the second game.
    const partial = await runTournament(cfg({ budgetUsd: 0.008 }), deps([], 'resumed'))
    expect(partial.stoppedForBudget).toBe(true)
    expect(partial.finished).toBe(1)
    expect(partial.games[1]).toMatchObject({ finished: false, turns: 1 })
    expect(partial.games.slice(2).every(g => !g.finished && g.turns === 0)).toBe(true)

    const resumed = await runTournament(cfg(), deps([], 'resumed'))
    expect(resumed.stoppedForBudget).toBe(false)
    expect(resumed.finished).toBe(6)
    expect(resumed).toEqual(full)
  })

  it('writes a results page with every model and game', async () => {
    const r = await runTournament(cfg(), deps())
    const md = resultsMarkdown(r)
    for (const e of entrants) expect(md).toContain(`| ${e.label} |`)
    for (const g of r.games) expect(md).toContain(g.id)
    expect(md).toContain('6 of 6 games finished')
    // Nobody acts, so every mirror game is a dead heat
    for (const g of r.games.filter(x => x.scenario === 'mirror')) expect(g).toMatchObject({ victor: null, winner: null })
    for (const e of r.entrants) expect(e.draws).toBe(3)
  })
})
