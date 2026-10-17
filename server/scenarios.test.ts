/** Scenario tests: the mirror start must be level, and every scenario must load and play. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ai.js', () => ({
  getFactionOrders: vi.fn(async () => ({ orders: [], reasoning: '' })),
  getNarrative: vi.fn(async () => 'narrative'),
}))

const { GameEngine, listScenarios } = await import('./engine.js')

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('scenarios', () => {
  it('lists default first, then the files in game/scenarios', () => {
    const names = listScenarios()
    expect(names[0]).toBe('default')
    expect(names).toContain('mirror')
  })

  it('rejects unknown and unsafe names', () => {
    expect(() => new GameEngine({ scenario: 'nope' }).reset()).toThrow('Unknown scenario')
    expect(() => new GameEngine({ scenario: '../game/initial-world' })).toThrow('Invalid scenario')
  })

  it('every scenario loads, is consistent, and survives a turn', async () => {
    for (const name of listScenarios()) {
      const e = new GameEngine({ seed: 1, scenario: name })
      e.reset()
      const s = e.state
      expect(s.game.scenario).toBe(name)
      for (const [id, f] of Object.entries(s.factions)) {
        const owned = Object.values(s.map.territories).filter(t => t.owner === id).length
        expect(f.territoryCount, `${name}/${id} territoryCount`).toBe(owned)
        for (const u of f.units) {
          expect(s.map.territories[u.territory], `${name}/${u.id} location`).toBeDefined()
          expect(u.id.startsWith(`${id}-`)).toBe(true)
        }
        expect(new Set(f.units.map(u => u.id)).size).toBe(f.units.length)
      }
      for (const [tid, t] of Object.entries(s.map.territories)) {
        if (t.owner === null) expect(t.mercenaries, `${name}/${tid} neutral land is held`).toBeGreaterThan(0)
      }
      await e.executeTurn()
      expect(e.state.game.turn).toBe(1)
    }
  })

  it('the mirror start is level: same stock, tech, forces and territory count, same yield, terrain and no continent bonus', () => {
    const e = new GameEngine({ seed: 1, scenario: 'mirror' })
    e.reset()
    const fs = Object.entries(e.state.factions)
    const first = fs[0][1]
    const mix = (f: typeof first) => f.units.map(u => u.type).sort().join()
    const yieldOf = (id: string) =>
      Object.values(e.state.map.territories).filter(t => t.owner === id).reduce((n, t) => n + Object.values(t.resources).reduce((a, b) => a + b, 0), 0)
    for (const [id, f] of fs) {
      expect(f.resources).toEqual(first.resources)
      expect(f.tech).toEqual(first.tech)
      expect(f.nukes).toBe(first.nukes)
      expect(f.territoryCount).toBe(first.territoryCount)
      expect(mix(f)).toBe(mix(first))
      expect(yieldOf(id)).toBe(yieldOf(fs[0][0]))
      const land = Object.values(e.state.map.territories).filter(t => t.owner === id)
      expect(land.map(t => t.terrain)).toEqual(['plains', 'plains', 'plains'])
      const yields = (owner: string) => Object.values(e.state.map.territories).filter(t => t.owner === owner).map(t => JSON.stringify(t.resources)).sort()
      expect(yields(id)).toEqual(yields(fs[0][0]))
    }
    // No continent is worth more to one starting position than another
    expect(Object.values(e.state.map.continents).every(c => Object.keys(c.bonus).length === 0)).toBe(true)
  })

  it('identical play from the mirror start ends level: no seat edge', async () => {
    const ai = await import('./ai.js')
    vi.mocked(ai.getFactionOrders).mockImplementation(async () => ({ orders: [{ action: 'research', tech: 'military' }], reasoning: '' }))
    const e = new GameEngine({ seed: 1, scenario: 'mirror' })
    e.reset()
    e.state.game.maxTurns = 5
    while (e.state.game.status === 'active') await e.executeTurn()
    vi.mocked(ai.getFactionOrders).mockImplementation(async () => ({ orders: [], reasoning: '' }))
    expect(new Set(Object.values(e.state.factions).map(f => f.score)).size).toBe(1)
    expect(e.state.game.victor).toBeNull()
  })

  it('the default scenario is unchanged: NATO 8 territories, Russia 3, China 2', () => {
    const e = new GameEngine({ seed: 1 })
    e.reset()
    expect(Object.values(e.state.factions).map(f => f.territoryCount)).toEqual([8, 3, 2])
    expect(e.state.game.scenario).toBe('default')
  })

  it('the scenario is saved with a game and restored with it', async () => {
    const a = new GameEngine({ seed: 1, scenario: 'mirror' })
    a.reset()
    const b = new GameEngine({ seed: 2 })
    b.restore(a.snapshot())
    expect(b.scenario).toBe('mirror')
    b.reset()
    expect(b.state.game.scenario).toBe('mirror')
  })
})

describe('scenario persona note', () => {
  it('the mirror scenario retracts the default starting claims; the default adds nothing', async () => {
    const ai = await import('./ai.js')
    const personaOf = async (scenario: string) => {
      vi.mocked(ai.getFactionOrders).mockClear()
      const e = new GameEngine({ seed: 1, scenario })
      e.reset()
      await e.executeTurn()
      return vi.mocked(ai.getFactionOrders).mock.calls.find(c => c[0] === 'nato')![1] as string
    }
    const mirror = await personaOf('mirror')
    const plain = await personaOf('default')
    expect(mirror).toContain('SCENARIO OVERRIDE')
    expect(plain).not.toContain('SCENARIO OVERRIDE')
    expect(mirror.startsWith(plain)).toBe(true)
  })
})

describe('structured output flag', () => {
  it('is recorded in the game, survives reset and save/load', () => {
    const a = new GameEngine({ seed: 1, structuredOutput: true })
    a.reset()
    expect(a.state.game.structuredOutput).toBe(true)
    const b = new GameEngine({ seed: 2 })
    b.reset()
    expect(b.state.game.structuredOutput).toBe(false)
    b.restore(a.snapshot())
    b.reset()
    expect(b.state.game.structuredOutput).toBe(true)
  })
})
