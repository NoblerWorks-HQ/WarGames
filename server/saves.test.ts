/** Save/load and scorecard tests. The AI layer is mocked, so no API key is needed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { FactionOrders, Order } from './types.js'
import type { CallUsage } from './usage.js'

const orders: Record<string, Order[]> = {}
const CALLS: Record<string, CallUsage> = {
  nato: { provider: 'gemini', model: 'g-model', inputTokens: 100, outputTokens: 50, latencyMs: 20, costUsd: 0.001 },
  russia: { provider: 'openai', model: 'o-model', inputTokens: 200, outputTokens: 80, latencyMs: 40, costUsd: 0.002 },
  china: { provider: 'anthropic', model: 'a-model', inputTokens: 300, outputTokens: 90, latencyMs: 60, costUsd: 0.003 },
  narrator: { provider: 'gemini', model: 'g-model', inputTokens: 10, outputTokens: 10, latencyMs: 5, costUsd: 0.0001 },
}

vi.mock('./ai.js', () => ({
  getFactionOrders: vi.fn(async (factionId: string, _p: string, _b: string, onUsage?: (u: CallUsage) => void): Promise<FactionOrders> => {
    onUsage?.(CALLS[factionId])
    return { orders: orders[factionId] ?? [], reasoning: 'test', notes: `note-${factionId}` }
  }),
  getNarrative: vi.fn(async (_s: string, onUsage?: (u: CallUsage) => void) => {
    onUsage?.(CALLS.narrator)
    return 'narrative'
  }),
}))

const { GameEngine } = await import('./engine.js')
const { SaveStore } = await import('./saves.js')
const { buildScorecard } = await import('./scorecard.js')
const { mulberry32 } = await import('./rng.js')

let dir: string
beforeEach(() => {
  for (const k of Object.keys(orders)) delete orders[k]
  dir = mkdtempSync(join(tmpdir(), 'wargames-saves-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Strip wall-clock fields so two runs of the same game can be compared. */
const stable = (e: InstanceType<typeof GameEngine>) => {
  const s = e.snapshot() as unknown as Record<string, unknown>
  delete s.savedAt
  const clean = JSON.parse(JSON.stringify(s), (k, v) => (k === 'timestamp' ? undefined : v))
  return clean
}

describe('seeded rng state', () => {
  it('restoring the state continues the same stream', () => {
    const a = mulberry32(5)
    a(); a()
    const saved = a.getState()
    const expected = [a(), a(), a()]
    const b = mulberry32(5)
    b.setState(saved)
    expect([b(), b(), b()]).toEqual(expected)
  })
})

describe('save and load', () => {
  function play(e: InstanceType<typeof GameEngine>) {
    // Dice-heavy and stateful: attacks, notes, a proposal, a spy report, a unit id counter
    orders.russia = [{ action: 'attack', unit: 'russia-art-1', target: 'eastern_europe' }, { action: 'diplomacy', to: 'china', proposal: 'alliance' }]
    orders.nato = [{ action: 'recruit', type: 'infantry', territory: 'western_na' }, { action: 'spy', target: 'china' }]
    return e.executeTurn()
  }

  it('a game restored from a snapshot plays on exactly like the original', async () => {
    const original = new GameEngine({ seed: 1234 })
    original.reset()
    await play(original)
    const snap = original.snapshot()

    const copy = new GameEngine({ seed: 999 })
    copy.restore(JSON.parse(JSON.stringify(snap)))
    expect(stable(copy)).toEqual(stable(original))

    await play(original)
    await play(copy)
    expect(stable(copy)).toEqual(stable(original))
  })

  it('a snapshot is independent of the engine that made it', async () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    const snap = e.snapshot()
    await play(e)
    expect(snap.state.game.turn).toBe(0)
    expect(snap.turnHistory).toHaveLength(0)
  })

  it('an unfinished game comes back paused; a finished one does not run', () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    const snap = e.snapshot()
    e.restore(snap)
    expect(e.control()).toMatchObject({ running: true, paused: true, turnExecuting: false })

    snap.state.game.status = 'finished'
    e.restore(snap)
    expect(e.control()).toMatchObject({ running: false, paused: false })
  })

  it('discards a turn that was in flight when the game was loaded', async () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    const snap = e.snapshot()
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const ai = await import('./ai.js')
    vi.mocked(ai.getFactionOrders).mockImplementationOnce(async () => {
      await gate
      return { orders: [], reasoning: '' }
    })
    const inFlight = e.executeTurn().catch(err => err)
    e.restore(snap)
    release()
    expect((await inFlight).name).toBe('StaleTurnError')
    expect(e.state.game.turn).toBe(0)
    expect(e.turnHistory).toHaveLength(0)
  })

  it('autosaves through onTurnComplete and lists, loads and rejects bad ids', async () => {
    const store = new SaveStore(dir)
    const e = new GameEngine({ seed: 77 })
    e.reset()
    e.onTurnComplete = () => store.save(e.snapshot())
    await play(e)
    await play(e)

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toBe(`${e.gameId}.json`)

    const [summary] = store.list()
    expect(summary).toMatchObject({ id: e.gameId, seed: 77, turn: 2, status: 'active' })
    expect(summary.models).toEqual({ nato: 'gemini/g-model', russia: 'openai/o-model', china: 'anthropic/a-model' })

    const loaded = new GameEngine()
    loaded.restore(store.load(e.gameId))
    expect(stable(loaded)).toEqual(stable(e))

    expect(() => store.load('../../etc/passwd')).toThrow('Invalid game id')
    expect(() => store.load('nope')).toThrow('No saved game')
  })

  it('a save that fails does not break the turn, and bad files are skipped in the list', async () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    e.onTurnComplete = () => {
      throw new Error('disk full')
    }
    await expect(e.executeTurn()).resolves.toBeDefined()
    expect(e.state.game.turn).toBe(1)

    writeFileSync(join(dir, 'broken.json'), '{not json')
    writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ version: 2 }))
    expect(new SaveStore(dir).list()).toEqual([])
  })

  it('refuses to save under an unsafe id', () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    expect(() => new SaveStore(dir).save({ ...e.snapshot(), id: '../escape' })).toThrow('Refusing')
    expect(() => new SaveStore(dir).save({ ...e.snapshot(), id: '' })).toThrow('Refusing')
  })
})

describe('scorecard', () => {
  it('reports provider, score, rank, valid-order rate and cost per seat', async () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    orders.nato = [{ action: 'move', unit: 'nato-inf-1', to: 'nowhere' }, { action: 'recruit', type: 'infantry', territory: 'western_na' }]
    orders.russia = []
    await e.executeTurn()

    const card = buildScorecard(e.state, e.turnHistory, e.usageSnapshot())
    expect(card).toMatchObject({ seed: 1, turns: 1, status: 'active', victor: null })
    const row = (id: string) => card.rows.find(r => r.faction === id)!

    expect(row('nato')).toMatchObject({ provider: 'gemini', model: 'g-model', orders: 2, invalid: 1, validRate: 0.5, calls: 1, inputTokens: 100, outputTokens: 50, avgLatencyMs: 20, costUsd: 0.001 })
    expect(row('russia')).toMatchObject({ provider: 'openai', orders: 0, forfeits: 1, validRate: null })
    expect(row('china')).toMatchObject({ provider: 'anthropic', avgLatencyMs: 60 })
    // The narrator is not a seat
    expect(card.rows.map(r => r.faction).sort()).toEqual(['china', 'nato', 'russia'])
    // NATO starts far ahead, so it ranks first
    expect(row('nato').rank).toBe(1)
    expect(row('nato').won).toBe(false)
  })

  it('shares a rank on a tie, marks the winner, and counts nukes and betrayals', () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    for (const f of Object.values(e.state.factions)) f.score = 10
    e.state.factions.china.score = 4
    e.state.game.status = 'finished'
    e.state.game.victor = 'nato'
    const history = [{
      turn: 1, timestamp: '', orders: {}, narrative: '',
      events: [
        { type: 'nuke' as const, faction: 'russia', description: '' },
        { type: 'betrayal' as const, faction: 'russia', description: '' },
      ],
    }]
    const card = buildScorecard(e.state, history, { roles: {} })
    const rank = Object.fromEntries(card.rows.map(r => [r.faction, r.rank]))
    expect(rank).toEqual({ nato: 1, russia: 1, china: 3 })
    expect(card.rows.find(r => r.faction === 'nato')!.won).toBe(true)
    expect(card.rows.find(r => r.faction === 'russia')).toMatchObject({ nukesLaunched: 1, betrayals: 1, won: false, provider: null })
  })
})
