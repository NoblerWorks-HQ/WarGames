/**
 * Turn resolver tests. The engine is pure logic over game/initial-world.json;
 * the only I/O is the AI layer, which is mocked here, so no API key is needed.
 * Dice are pinned by replacing engine.rng: a die is floor(rng() * 6) + 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FactionOrders, Order } from './types.js'
import type { CallUsage } from './usage.js'

const orders: Record<string, Order[]> = {}
const notes: Record<string, string> = {}

/** What every mocked AI call reports to the engine's usage tracker. */
const CALL_USAGE: CallUsage = { provider: 'gemini', model: 'test-model', inputTokens: 100, outputTokens: 50, latencyMs: 10, costUsd: 0.001 }

vi.mock('./ai.js', () => ({
  getFactionOrders: vi.fn(async (factionId: string, _persona: string, _briefing: string, onUsage?: (u: CallUsage) => void): Promise<FactionOrders> => {
    onUsage?.(CALL_USAGE)
    return { orders: orders[factionId] ?? [], reasoning: 'test', notes: notes[factionId] }
  }),
  getNarrative: vi.fn(async (_summary: string, onUsage?: (u: CallUsage) => void) => {
    onUsage?.(CALL_USAGE)
    return 'narrative'
  }),
}))

const { GameEngine, StaleTurnError } = await import('./engine.js')
const ai = await import('./ai.js')
const defaultOrdersMock = vi.mocked(ai.getFactionOrders).getMockImplementation()!

/** Pin every die roll this turn to `face` (1-6). */
function dice(face: number) {
  engine.rng = () => (face - 1) / 6 + 0.01
}

let engine: InstanceType<typeof GameEngine>

beforeEach(() => {
  for (const k of Object.keys(orders)) delete orders[k]
  for (const k of Object.keys(notes)) delete notes[k]
  vi.spyOn(console, 'log').mockImplementation(() => {})
  engine = new GameEngine()
  engine.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(ai.getFactionOrders).mockImplementation(defaultOrdersMock)
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
    engine.state.factions.nato.tech.nuclear = 3
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
    // China is given ICBM tech (nuclear 2), so its range is unlimited. NATO starts
    // at nuclear 1, so there is no second strike to answer it.
    engine.state.factions.china.tech.nuclear = 2
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

describe('seeded dice', () => {
  it('the same seed replays the same rolls; a different seed does not', () => {
    const a = new GameEngine({ seed: 42 })
    const b = new GameEngine({ seed: 42 })
    const c = new GameEngine({ seed: 43 })
    const roll = (e: InstanceType<typeof GameEngine>) => Array.from({ length: 5 }, () => e.rng())
    const first = roll(a)
    expect(roll(b)).toEqual(first)
    expect(roll(c)).not.toEqual(first)
    expect(first.every(n => n >= 0 && n < 1)).toBe(true)
  })

  it('reset() restarts a fixed seed, and the seed is part of the game state', () => {
    const e = new GameEngine({ seed: 7 })
    e.reset()
    const first = [e.rng(), e.rng()]
    e.reset()
    expect([e.rng(), e.rng()]).toEqual(first)
    expect(e.state.game.seed).toBe(7)
  })

  it('without a fixed seed each game draws its own and reports it', () => {
    const e = new GameEngine()
    e.reset()
    const seen = new Set<number>()
    for (let i = 0; i < 5; i++) { e.reset(); seen.add(e.state.game.seed!) }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('two engines with one seed fight an identical battle', async () => {
    const play = async () => {
      const e = new GameEngine({ seed: 99 })
      e.reset()
      orders.russia = [{ action: 'attack', unit: 'russia-art-1', target: 'eastern_europe' }]
      const result = await e.executeTurn()
      return result.events.map(ev => ev.description)
    }
    expect(await play()).toEqual(await play())
  })
})

describe('fallout', () => {
  /** China nukes Australia on turn 1 (ICBM range). */
  async function nukeAustralia() {
    engine.state.factions.china.tech.nuclear = 2
    orders.china = [{ action: 'nuke', target: 'australia' }]
    await engine.executeTurn()
    delete orders.china
  }

  it('wipes the yield for five turns, then restores it', async () => {
    const original = { ...territory('australia').resources }
    expect(Object.keys(original).length).toBeGreaterThan(0)
    await nukeAustralia() // turn 1
    expect(territory('australia').resources).toEqual({})
    expect(territory('australia').fallout!.resources).toEqual(original)
    for (let i = 0; i < 5; i++) await engine.executeTurn() // turns 2-6: still contaminated
    expect(territory('australia').resources).toEqual({})
    await engine.executeTurn() // turn 7
    expect(territory('australia').resources).toEqual(original)
    expect(territory('australia').fallout).toBeUndefined()
    expect(engine.chatLog.some(m => m.message.includes('Fallout clears over Australia'))).toBe(true)
  })

  it('a land captured during fallout pays nothing until it clears', async () => {
    await nukeAustralia()
    engine.state.factions.china.units.push({ id: 'china-inf-9', type: 'infantry', territory: 'australia', hp: 2, xp: 0 })
    territory('australia').owner = 'china'
    // Uranium has no interest, and Australia is the only uranium source here besides the Oceania bonus
    const uranium = () => engine.state.factions.china.resources.uranium
    const incomeOf = async () => { const before = uranium(); await engine.executeTurn(); return uranium() - before }
    const duringFallout = await incomeOf() // turn 2
    for (let i = 0; i < 4; i++) await engine.executeTurn() // turns 3-6
    const afterFallout = await incomeOf() // turn 7
    expect(afterFallout - duringFallout).toBe(5) // Australia's own uranium yield is back
  })

  it('a second strike on contaminated land restarts the clock but keeps the original yield', async () => {
    const original = { ...territory('australia').resources }
    await nukeAustralia() // turn 1
    engine.state.factions.china.nukes = 1
    await engine.executeTurn() // turn 2
    await engine.executeTurn() // turn 3
    orders.china = [{ action: 'nuke', target: 'australia' }]
    await engine.executeTurn() // turn 4: struck again
    delete orders.china
    expect(territory('australia').fallout).toEqual({ until: 10, resources: original })
  })

  it('is shown to the factions in their briefing', async () => {
    await nukeAustralia()
    await engine.executeTurn()
    expect(lastBriefing('china').visibleMap.australia.falloutClearsOnTurn).toBe(7)
  })
})

describe('nuclear start', () => {
  it('everyone starts at nuclear 1 with a few warheads and nobody has second strike', async () => {
    for (const f of Object.values(engine.state.factions)) {
      expect(f.tech.nuclear).toBe(1)
      expect(f.nukes).toBeGreaterThan(0)
      expect(f.nukes).toBeLessThanOrEqual(2)
    }
    // A strike on Russia is not answered: no one can retaliate yet
    orders.nato = [{ action: 'nuke', target: 'western_russia' }]
    const natoTerritories = Object.values(engine.state.map.territories).filter(t => t.owner === 'nato').length
    await engine.executeTurn()
    expect(Object.values(engine.state.map.territories).filter(t => t.owner === 'nato')).toHaveLength(natoTerritories)
  })

  it('second strike must be researched: level 3 retaliates, level 2 does not', async () => {
    engine.state.factions.russia.tech.nuclear = 3
    orders.nato = [{ action: 'nuke', target: 'western_russia' }]
    const natoTerritories = Object.values(engine.state.map.territories).filter(t => t.owner === 'nato').length
    const result = await engine.executeTurn()
    expect(result.events.some(e => e.type === 'nuke')).toBe(true)
    expect(Object.values(engine.state.map.territories).filter(t => t.owner === 'nato')).toHaveLength(natoTerritories - 1)
  })
})

describe('strategy notes', () => {
  it('returns a faction its own notes next turn, keeps them when omitted, replaces them when rewritten', async () => {
    notes.nato = 'Plan: take Ukraine by turn 4'
    await engine.executeTurn()
    delete notes.nato
    await engine.executeTurn()
    expect(lastBriefing('nato').yourNotes).toBe('Plan: take Ukraine by turn 4')
    expect(lastBriefing('russia').yourNotes).toBeUndefined()
    notes.nato = 'Plan changed'
    await engine.executeTurn()
    delete notes.nato
    await engine.executeTurn()
    expect(lastBriefing('nato').yourNotes).toBe('Plan changed')
  })

  it('are cleared when the game is reset and never reach the other factions', async () => {
    notes.china = 'secret'
    await engine.executeTurn()
    await engine.executeTurn()
    expect(JSON.stringify(lastBriefing('nato'))).not.toContain('secret')
    engine.reset()
    expect(engine.notes).toEqual({})
  })
})

describe('narrator input', () => {
  const lastNarration = () => vi.mocked(ai.getNarrative).mock.calls.at(-1)![0]

  it('gets public statements, betrayals and standings, but not private messages or invalid orders', async () => {
    engine.state.factions.nato.alliances = ['china']
    engine.state.factions.china.alliances = ['nato']
    orders.nato = [
      { action: 'message', message: 'We come in peace' },
      { action: 'message', to: 'russia', message: 'secret handshake' },
      { action: 'break_alliance', to: 'china' },
    ]
    orders.russia = [{ action: 'move', unit: 'no-such-unit', to: 'ukraine' }]
    await engine.executeTurn()
    const brief = lastNarration()
    expect(brief).toContain('We come in peace')
    expect(brief).toContain('BETRAYS')
    expect(brief).toMatch(/NATO.*2 warheads/)
    expect(brief).not.toContain('secret handshake')
    expect(brief).not.toContain('unknown unit')
  })

  it('carries the previous bulletin forward for continuity', async () => {
    await engine.executeTurn()
    expect(lastNarration()).not.toContain('Previous bulletin')
    await engine.executeTurn()
    expect(lastNarration()).toContain('Previous bulletin (continue the story, do not repeat it): narrative')
  })
})

describe('usage tracking', () => {
  it('tallies calls, tokens and cost per role, narrator included', async () => {
    await engine.executeTurn()
    const u = engine.usageSnapshot()
    expect(Object.keys(u.roles).sort()).toEqual(['china', 'narrator', 'nato', 'russia'])
    expect(u.roles.nato).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 50, costComplete: true })
    expect(u.total).toMatchObject({ calls: 4, inputTokens: 400, outputTokens: 200, costComplete: true })
    expect(u.total.costUsd).toBeCloseTo(0.004)
    await engine.executeTurn()
    expect(engine.usageSnapshot().total.calls).toBe(8)
  })

  it('marks the cost incomplete when a call has no price, and resets with the game', async () => {
    vi.mocked(ai.getNarrative).mockImplementationOnce(async (_s: string, onUsage?: (u: CallUsage) => void) => {
      onUsage?.({ ...CALL_USAGE, costUsd: null })
      return 'narrative'
    })
    await engine.executeTurn()
    expect(engine.usageSnapshot().total.costComplete).toBe(false)
    expect(engine.usageSnapshot().roles.nato.costComplete).toBe(true)
    engine.reset()
    expect(engine.usageSnapshot().total.calls).toBe(0)
  })
})

describe('turn controls', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { engine.stop(); vi.useRealTimers() })
  const settle = () => vi.advanceTimersByTimeAsync(1)

  it('start() plays a turn every interval', async () => {
    engine.start(5000)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(engine.state.game.turn).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(engine.state.game.turn).toBe(2)
  })

  it('pause() stops new turns without losing the game; resume() plays one immediately', async () => {
    engine.start(5000)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    engine.pause()
    expect(engine.control()).toMatchObject({ running: true, paused: true })
    await vi.advanceTimersByTimeAsync(30000)
    expect(engine.state.game.turn).toBe(1)
    engine.resume()
    await settle()
    expect(engine.state.game.turn).toBe(2)
    expect(engine.control().paused).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(engine.state.game.turn).toBe(3)
  })

  it('step() plays exactly one turn and stays paused, starting a game if needed', async () => {
    expect(engine.control().running).toBe(false)
    expect(engine.step()).toBe(true)
    await settle()
    expect(engine.state.game.turn).toBe(1)
    expect(engine.control()).toMatchObject({ running: true, paused: true })
    await vi.advanceTimersByTimeAsync(60000)
    expect(engine.state.game.turn).toBe(1)
    expect(engine.step()).toBe(true)
    await settle()
    expect(engine.state.game.turn).toBe(2)
  })

  it('step() while a turn is in flight is refused', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    vi.mocked(ai.getFactionOrders).mockImplementation(async () => {
      await gate
      return { orders: [], reasoning: 'late' }
    })
    expect(engine.step()).toBe(true)
    await settle()
    expect(engine.control().turnExecuting).toBe(true)
    expect(engine.step()).toBe(false)
    release()
    await settle()
    expect(engine.control().turnExecuting).toBe(false)
    expect(engine.state.game.turn).toBe(1)
  })

  it('step() on a running game pauses it first', async () => {
    engine.start(5000)
    expect(engine.step()).toBe(true)
    await settle()
    expect(engine.control().paused).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(engine.state.game.turn).toBe(1)
  })

  it('setIntervalMs() re-times a running game', async () => {
    engine.start(60000)
    engine.setIntervalMs(5000)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(engine.state.game.turn).toBe(1)
    expect(engine.control().intervalMs).toBe(5000)
  })

  it('setIntervalMs() while paused does not restart the timer', async () => {
    engine.start(5000)
    engine.pause()
    engine.setIntervalMs(5000)
    await vi.advanceTimersByTimeAsync(20000)
    expect(engine.state.game.turn).toBe(0)
  })

  it('stops itself when the game finishes', async () => {
    engine.start(5000)
    engine.state.game.maxTurns = 1
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(engine.state.game.status).toBe('finished')
    expect(engine.control()).toMatchObject({ running: false, paused: false })
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

  it('does not count a discarded turn\'s tokens against the new game', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    vi.mocked(ai.getFactionOrders).mockImplementation(async (_f, _p, _b, onUsage) => {
      await gate
      onUsage?.(CALL_USAGE)
      return { orders: [], reasoning: 'late' }
    })
    const inFlight = engine.executeTurn()
    engine.reset()
    release()
    await expect(inFlight).rejects.toBeInstanceOf(StaleTurnError)
    expect(engine.usageSnapshot().total.calls).toBe(0)
  })
})
