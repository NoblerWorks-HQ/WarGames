/**
 * Turn resolver tests. The engine is pure logic over game/initial-world.json;
 * the only I/O is the AI layer, which is mocked here, so no API key is needed.
 * Dice are pinned by mocking Math.random: a die is floor(random * 6) + 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FactionOrders, Order } from './types.js'

const orders: Record<string, Order[]> = {}

vi.mock('./ai.js', () => ({
  getFactionOrders: vi.fn(async (factionId: string): Promise<FactionOrders> => ({
    orders: orders[factionId] ?? [],
    reasoning: 'test',
  })),
  getNarrative: vi.fn(async () => 'narrative'),
}))

const { GameEngine } = await import('./engine.js')

/** Pin every die roll this turn to `face` (1-6). */
function dice(face: number) {
  vi.spyOn(Math, 'random').mockReturnValue((face - 1) / 6 + 0.01)
}

let engine: InstanceType<typeof GameEngine>

beforeEach(() => {
  for (const k of Object.keys(orders)) delete orders[k]
  vi.spyOn(console, 'log').mockImplementation(() => {})
  engine = new GameEngine()
  engine.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const unit = (fid: string, id: string) => engine.state.factions[fid].units.find(u => u.id === id)
const territory = (id: string) => engine.state.map.territories[id]

describe('initial world', () => {
  it('loads three factions on a 25-territory map with symmetric adjacency', () => {
    expect(Object.keys(engine.state.factions)).toEqual(['nato', 'russia', 'china'])
    expect(Object.keys(engine.state.map.territories)).toHaveLength(25)
    for (const [a, adj] of Object.entries(engine.state.map.adjacency)) {
      for (const b of adj) expect(engine.state.map.adjacency[b], `${b} -> ${a}`).toContain(a)
    }
  })

  it('reset() restores a fresh world after a turn has mutated it', async () => {
    orders.nato = [{ action: 'fortify', territory: 'western_na' }]
    await engine.executeTurn()
    engine.reset()
    expect(engine.state.game.turn).toBe(0)
    expect(territory('western_na').fortified).toBe(false)
    expect(engine.turnHistory).toEqual([])
  })
})

describe('resource gain', () => {
  it('pays upkeep, territory yield, trade networks and central banking', async () => {
    await engine.executeTurn()
    const china = engine.state.factions.china.resources
    // gold 20 + east_asia 4 + southeast_asia 3 + 2 coastal (econ 1) = 29, +10% (econ 2) = 31
    expect(china.gold).toBe(31)
    // food 18 - 8 units upkeep + 3 + 3
    expect(china.food).toBe(16)
    // knowledge 6 + 1 per turn + east_asia 2
    expect(china.knowledge).toBe(9)
  })

  it('floors food at zero rather than going negative', async () => {
    engine.state.factions.russia.resources.food = 0
    for (const t of Object.values(engine.state.map.territories)) {
      if (t.owner === 'russia') t.resources = {}
    }
    await engine.executeTurn()
    expect(engine.state.factions.russia.resources.food).toBe(0)
  })

  it('pays a continent bonus only for a whole continent', async () => {
    const before = engine.state.factions.nato.resources.gold
    await engine.executeTurn()
    const noBonus = engine.state.factions.nato.resources.gold - before

    engine.reset()
    territory('central_america').owner = 'nato' // completes North America
    territory('central_america').resources = {}
    const before2 = engine.state.factions.nato.resources.gold
    await engine.executeTurn()
    const withBonus = engine.state.factions.nato.resources.gold - before2
    // +4 gold bonus, +1 coastal (central_america is coast), both before the 10% interest
    expect(withBonus).toBeGreaterThanOrEqual(noBonus + 5)
  })
})

describe('orders', () => {
  it('records a forfeit when a faction returns no orders', async () => {
    const result = await engine.executeTurn()
    expect(result.events.filter(e => e.type === 'forfeit').map(e => e.faction).sort()).toEqual(['china', 'nato', 'russia'])
  })

  it('moves a unit between own territories', async () => {
    orders.nato = [{ action: 'move', unit: 'nato-inf-1', to: 'alaska' }]
    const result = await engine.executeTurn()
    expect(unit('nato', 'nato-inf-1')!.territory).toBe('alaska')
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('move')
  })

  it('rejects a move no unit can reach', async () => {
    orders.nato = [{ action: 'move', unit: 'nato-inf-1', to: 'pakistan' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('invalid')
    expect(unit('nato', 'nato-inf-1')!.territory).toBe('western_na')
  })

  it('fortify costs 2 iron and only works on owned territory', async () => {
    orders.nato = [
      { action: 'fortify', territory: 'western_na' },
      { action: 'fortify', territory: 'siberia' },
    ]
    const ironBefore = engine.state.factions.nato.resources.iron
    const result = await engine.executeTurn()
    expect(territory('western_na').fortified).toBe(true)
    expect(result.events.filter(e => e.faction === 'nato').map(e => e.type)).toEqual(['fortify', 'invalid'])
    // +8 iron income (alaska 1, scandinavia 2, eastern_europe 2, australia 3),
    // -2 for the one fortify that landed
    expect(engine.state.factions.nato.resources.iron).toBe(ironBefore + 8 - 2)
  })

  it('recruit is gated by tech and cost', async () => {
    orders.china = [{ action: 'recruit', type: 'artillery', territory: 'east_asia' }] // military 1 < 2
    orders.nato = [{ action: 'recruit', type: 'artillery', territory: 'western_na' }]
    const natoUnits = engine.state.factions.nato.units.length
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'china')!.type).toBe('invalid')
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('recruit')
    expect(engine.state.factions.nato.units).toHaveLength(natoUnits + 1)
  })

  it('research spends knowledge and raises the level; maxed tech is refused', async () => {
    orders.china = [{ action: 'research', tech: 'military' }]
    orders.nato = [{ action: 'research', tech: 'nuclear' }] // already 3
    await engine.executeTurn()
    expect(engine.state.factions.china.tech.military).toBe(2)
    expect(engine.state.factions.china.resources.knowledge).toBe(9 - 5)
    expect(engine.state.factions.nato.tech.nuclear).toBe(3)
  })
})

describe('combat', () => {
  it('artillery with precision strike ignores the fort and wins on a high roll', async () => {
    dice(6)
    orders.russia = [{ action: 'attack', unit: 'russia-art-1', target: 'eastern_europe' }]
    const result = await engine.executeTurn()
    const ev = result.events.find(e => e.type === 'combat')!
    expect(ev.faction).toBe('russia')
    expect(territory('eastern_europe').owner).toBe('russia')
    expect(territory('eastern_europe').fortified).toBe(false)
    expect(unit('russia', 'russia-art-1')).toMatchObject({ territory: 'eastern_europe', xp: 1 })
    expect(unit('nato', 'nato-inf-5')).toBeUndefined() // took 2 damage, destroyed
  })

  it('a middling roll is a draw: both units damaged, both gain xp', async () => {
    dice(6) // armor 3 vs infantry 2 + fort 2: roll = 6 + (3 - 4) = 5
    orders.russia = [{ action: 'attack', unit: 'russia-arm-1', target: 'eastern_europe' }]
    await engine.executeTurn()
    expect(territory('eastern_europe').owner).toBe('nato')
    expect(unit('russia', 'russia-arm-1')).toMatchObject({ hp: 1, xp: 1 })
    expect(unit('nato', 'nato-inf-5')).toMatchObject({ hp: 1, xp: 1 })
  })

  it('a low roll repels the attacker', async () => {
    dice(1)
    orders.russia = [{ action: 'attack', unit: 'russia-art-1', target: 'eastern_europe' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.type === 'combat')!.faction).toBe('nato')
    expect(unit('russia', 'russia-art-1')).toBeUndefined()
    expect(unit('nato', 'nato-inf-5')!.xp).toBe(1)
    expect(territory('eastern_europe').owner).toBe('nato')
  })

  it('mercenaries defend neutral land and are cleared on a win', async () => {
    dice(6)
    orders.nato = [{ action: 'move', unit: 'nato-inf-5', to: 'ukraine' }]
    await engine.executeTurn()
    expect(territory('ukraine')).toMatchObject({ owner: 'nato', mercenaries: 0 })
    expect(unit('nato', 'nato-inf-5')!.territory).toBe('ukraine')
  })

  it('mercenaries repel a weak attack and keep the territory neutral', async () => {
    dice(1)
    orders.nato = [{ action: 'move', unit: 'nato-inf-5', to: 'ukraine' }]
    await engine.executeTurn()
    expect(territory('ukraine')).toMatchObject({ owner: null, mercenaries: 4 })
    expect(unit('nato', 'nato-inf-5')!.hp).toBe(1)
  })
})

describe('diplomacy', () => {
  it('an alliance forms only when both sides propose', async () => {
    orders.nato = [{ action: 'diplomacy', to: 'china', proposal: 'alliance' }]
    await engine.executeTurn()
    expect(engine.state.factions.nato.alliances).toEqual([])

    orders.china = [{ action: 'diplomacy', to: 'nato', proposal: 'alliance' }]
    delete orders.nato
    await engine.executeTurn()
    expect(engine.state.factions.nato.alliances).toEqual(['china'])
    expect(engine.state.factions.china.alliances).toEqual(['nato'])
  })

  it('breaking an alliance marks the faction an oathbreaker, who can never ally again', async () => {
    engine.state.factions.nato.alliances = ['china']
    engine.state.factions.china.alliances = ['nato']
    orders.nato = [{ action: 'break_alliance', to: 'china' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('betrayal')
    expect(engine.state.factions.nato.oathbreaker).toBe(true)
    expect(engine.state.factions.china.alliances).toEqual([])

    orders.nato = [{ action: 'diplomacy', to: 'russia', proposal: 'alliance' }]
    const next = await engine.executeTurn()
    expect(next.events.find(e => e.faction === 'nato')!.type).toBe('invalid')
  })
})

describe('nukes', () => {
  it('a strike destroys every unit and irradiates the territory', async () => {
    // China has ICBM tech (nuclear 2), so range is unlimited. NATO is dropped to
    // nuclear 2 so its second strike (nuclear 3, random target) stays out of it.
    engine.state.factions.nato.tech.nuclear = 2
    orders.china = [{ action: 'nuke', target: 'australia' }]
    const nukesBefore = engine.state.factions.china.nukes
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'china')!.type).toBe('nuke')
    expect(territory('australia')).toMatchObject({ owner: null, fortified: false, resources: {} })
    expect(engine.state.factions.nato.units.some(u => u.territory === 'australia')).toBe(false)
    expect(engine.state.factions.china.nukes).toBe(nukesBefore - 1)
  })

  it('refuses to nuke your own territory', async () => {
    orders.china = [{ action: 'nuke', target: 'east_asia' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'china')!.type).toBe('invalid')
    expect(territory('east_asia').owner).toBe('china')
  })
})

describe('game end', () => {
  it('ends at maxTurns with the highest score as victor', async () => {
    engine.state.game.turn = engine.state.game.maxTurns - 1
    const result = await engine.executeTurn()
    expect(engine.state.game.status).toBe('finished')
    const scores = Object.entries(engine.state.factions).map(([id, f]) => [id, f.score] as const)
    const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a))
    expect(engine.state.game.victor).toBe(best[0])
    expect(result.events.at(-1)!.type).toBe('victory')
  })

  it('awards a domination victory at the territory threshold', async () => {
    const ids = Object.keys(engine.state.map.territories)
    for (const id of ids.slice(0, engine.state.victoryConditions.domination.territoriesRequired)) {
      territory(id).owner = 'russia'
      territory(id).mercenaries = 0
    }
    await engine.executeTurn()
    expect(engine.state.game.status).toBe('finished')
    expect(engine.state.game.victor).toBe('russia')
  })

  it('updates territory counts and scores every turn', async () => {
    await engine.executeTurn()
    const nato = engine.state.factions.nato
    const owned = Object.values(engine.state.map.territories).filter(t => t.owner === 'nato').length
    expect(nato.territoryCount).toBe(owned)
    expect(nato.score).toBeGreaterThan(owned * 3)
  })
})
