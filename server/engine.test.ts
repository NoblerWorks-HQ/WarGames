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

const { GameEngine, StaleTurnError } = await import('./engine.js')
const ai = await import('./ai.js')

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

  it('floors food at zero and damages the units it cannot feed', async () => {
    engine.state.factions.russia.resources.food = 4
    for (const t of Object.values(engine.state.map.territories)) {
      if (t.owner === 'russia') t.resources = {}
    }
    const result = await engine.executeTurn()
    const russia = engine.state.factions.russia
    expect(russia.resources.food).toBe(0)
    // 6 units, 4 food: the two newest go hungry
    expect(russia.units.map(u => u.hp)).toEqual([2, 2, 2, 2, 1, 1])
    expect(result.events.find(e => e.type === 'attrition')!.faction).toBe('russia')

    await engine.executeTurn() // no food at all: every unit loses 1 hp, the two at 1 hp die
    expect(russia.units).toHaveLength(4)
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

describe('order validation', () => {
  it('rejects unknown unit ids instead of guessing a unit', async () => {
    orders.nato = [{ action: 'move', unit: 'inf-1', to: 'alaska' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('invalid')
    expect(unit('nato', 'nato-inf-1')!.territory).toBe('western_na')
  })

  it('does not swap in another unit when the named one cannot reach', async () => {
    // nato-inf-5 (eastern_europe) could reach scandinavia; nato-inf-1 cannot
    orders.nato = [{ action: 'move', unit: 'nato-inf-1', to: 'scandinavia' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('invalid')
    expect(unit('nato', 'nato-inf-5')!.territory).toBe('eastern_europe')
  })

  it('lets each unit move or attack only once per turn', async () => {
    orders.nato = [
      { action: 'move', unit: 'nato-inf-1', to: 'alaska' },
      { action: 'move', unit: 'nato-inf-1', to: 'western_na' },
    ]
    const result = await engine.executeTurn()
    expect(result.events.filter(e => e.faction === 'nato').map(e => e.type)).toEqual(['move', 'invalid'])
    expect(unit('nato', 'nato-inf-1')!.territory).toBe('alaska')
  })

  it('armor moves two territories through its own land; infantry cannot', async () => {
    orders.nato = [
      { action: 'move', unit: 'nato-arm-1', to: 'western_na' }, // western_europe -> eastern_na -> western_na
      { action: 'move', unit: 'nato-inf-4', to: 'western_na' },
    ]
    const result = await engine.executeTurn()
    expect(result.events.filter(e => e.faction === 'nato').map(e => e.type)).toEqual(['move', 'invalid'])
    expect(unit('nato', 'nato-arm-1')!.territory).toBe('western_na')
    expect(unit('nato', 'nato-inf-4')!.territory).toBe('western_europe')
  })

  it('gives every recruit a unique id that continues the faction numbering', async () => {
    orders.nato = [
      { action: 'recruit', type: 'infantry', territory: 'western_na' },
      { action: 'recruit', type: 'infantry', territory: 'eastern_na' },
    ]
    await engine.executeTurn()
    const ids = engine.state.factions.nato.units.map(u => u.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.slice(-2)).toEqual(['nato-inf-8', 'nato-inf-9'])
  })

  it('recruits only in a territory the faction owns', async () => {
    orders.nato = [{ action: 'recruit', type: 'infantry', territory: 'siberia' }]
    const result = await engine.executeTurn()
    expect(result.events.find(e => e.faction === 'nato')!.type).toBe('invalid')
    expect(engine.state.factions.nato.units.some(u => u.territory === 'siberia')).toBe(false)
  })

  it('rotates which faction resolves first each turn', async () => {
    orders.nato = [{ action: 'fortify', territory: 'western_na' }]
    orders.russia = [{ action: 'fortify', territory: 'siberia' }]
    orders.china = [{ action: 'fortify', territory: 'east_asia' }]
    const firstMover = async () => (await engine.executeTurn()).events.find(e => e.type === 'fortify')!.faction
    expect(await firstMover()).toBe('nato')
    expect(await firstMover()).toBe('russia')
    expect(await firstMover()).toBe('china')
    expect(await firstMover()).toBe('nato')
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

/** The briefing a faction was given on its most recent turn. */
function lastBriefing(fid: string) {
  const calls = vi.mocked(ai.getFactionOrders).mock.calls.filter(c => c[0] === fid)
  return JSON.parse(calls.at(-1)![2])
}

describe('diplomacy', () => {
  it('shows an alliance proposal to its target, and lets it lapse unanswered', async () => {
    orders.nato = [{ action: 'diplomacy', to: 'china', proposal: 'alliance' }]
    await engine.executeTurn()
    delete orders.nato
    await engine.executeTurn()
    const brief = lastBriefing('china')
    expect(brief.incomingAllianceProposals).toEqual([{ from: 'nato', turn: 1 }])
    expect(brief.inbox[0]).toMatchObject({ from: 'nato', kind: 'alliance_proposal' })
    expect(lastBriefing('nato').yourPendingProposals).toEqual([{ to: 'china', turn: 1 }])

    await engine.executeTurn() // turn 3: still open
    expect(lastBriefing('china').incomingAllianceProposals).toHaveLength(1)
    await engine.executeTurn() // turn 4: lapsed
    expect(lastBriefing('china').incomingAllianceProposals).toEqual([])
  })

  it('delivers messages: broadcast to everyone else, or privately with "to"', async () => {
    orders.nato = [
      { action: 'message', message: 'hello world' },
      { action: 'message', to: 'russia', message: 'just you' },
    ]
    await engine.executeTurn()
    delete orders.nato
    await engine.executeTurn()
    expect(lastBriefing('russia').inbox.map((m: { text: string }) => m.text)).toEqual(['hello world', 'just you'])
    expect(lastBriefing('china').inbox.map((m: { text: string }) => m.text)).toEqual(['hello world'])
    expect(lastBriefing('nato').inbox).toEqual([])
  })

  it('allies cannot attack, invade or nuke each other without breaking the alliance', async () => {
    engine.state.factions.nato.alliances = ['russia']
    engine.state.factions.russia.alliances = ['nato']
    dice(6)
    orders.russia = [
      { action: 'attack', unit: 'russia-art-1', target: 'eastern_europe' },
      { action: 'move', unit: 'russia-arm-1', to: 'eastern_europe' },
      { action: 'nuke', target: 'eastern_europe' },
    ]
    const result = await engine.executeTurn()
    expect(result.events.filter(e => e.faction === 'russia').map(e => e.type)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(territory('eastern_europe').owner).toBe('nato')
    expect(unit('nato', 'nato-inf-5')).toMatchObject({ hp: 2 })
  })


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

describe('spying', () => {
  it('reveals the target territory in the next briefing only', async () => {
    orders.china = [{ action: 'spy', target: 'western_na' }]
    await engine.executeTurn()
    expect(lastBriefing('china').visibleMap.western_na).toBeUndefined()
    delete orders.china
    await engine.executeTurn()
    expect(lastBriefing('china').visibleMap.western_na).toMatchObject({ owner: 'nato' })
    await engine.executeTurn()
    expect(lastBriefing('china').visibleMap.western_na).toBeUndefined()
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

  it('a diplomatic victory needs the alliances held for turnsRequired turns', async () => {
    const { turnsRequired } = engine.state.victoryConditions.diplomatic
    for (const [id, f] of Object.entries(engine.state.factions)) f.alliances = ['nato', 'russia', 'china'].filter(o => o !== id)
    const ally = (since: number) => {
      for (const k of ['china|nato', 'china|russia', 'nato|russia']) engine.allianceSince.set(k, since)
    }
    engine.state.game.turn = turnsRequired - 1
    ally(turnsRequired - 1) // formed last turn
    await engine.executeTurn()
    expect(engine.state.game.status).toBe('active')

    ally(0) // held since the start
    await engine.executeTurn()
    expect(engine.state.game.status).toBe('finished')
    // all three qualify at once: the highest score wins, not the first faction listed
    const best = Object.entries(engine.state.factions).reduce((a, b) => (b[1].score > a[1].score ? b : a))[0]
    expect(engine.state.game.victor).toBe(best)
  })

  it('updates territory counts and scores every turn', async () => {
    await engine.executeTurn()
    const nato = engine.state.factions.nato
    const owned = Object.values(engine.state.map.territories).filter(t => t.owner === 'nato').length
    expect(nato.territoryCount).toBe(owned)
    expect(nato.score).toBeGreaterThan(owned * 3)
  })
})

describe('stop -> start mid-turn', () => {
  it('discards a turn that was in flight when the game was reset', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    vi.mocked(ai.getFactionOrders).mockImplementation(async () => {
      await gate
      return { orders: [], reasoning: 'late' }
    })
    const inFlight = engine.executeTurn()
    engine.reset() // what start() does while the old turn awaits the AI
    release()
    await expect(inFlight).rejects.toBeInstanceOf(StaleTurnError)
    expect(engine.state.game.turn).toBe(0)
    expect(engine.turnHistory).toHaveLength(0)
    expect(engine.chatLog.some(m => m.message.includes('late') || m.message.includes('forfeit'))).toBe(false)
  })
})
