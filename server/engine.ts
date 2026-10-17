import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { GameState, Unit, Order, FactionOrders, TurnResult, GameEvent, ChatMessage } from './types.js'
import { getFactionOrders, getNarrative } from './ai.js'
import { mulberry32, randomSeed } from './rng.js'
import { UsageTracker } from './usage.js'
import type { UsageSnapshot } from './usage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const UNIT_STATS: Record<string, { attack: number; defense: number; movement: number; cost: { gold: number; iron: number } }> = {
  infantry: { attack: 2, defense: 2, movement: 1, cost: { gold: 2, iron: 1 } },
  armor: { attack: 3, defense: 1, movement: 2, cost: { gold: 4, iron: 2 } },
  artillery: { attack: 4, defense: 1, movement: 1, cost: { gold: 5, iron: 3 } }
}

const TERRAIN_DEFENSE: Record<string, number> = {
  mountains: 2,
  plains: 0,
  coast: 0
}

// Load faction personas
function loadPersona(faction: string): string {
  try {
    return readFileSync(resolve(__dirname, `../game/factions/${faction}.md`), 'utf-8')
  } catch {
    return `You are the leader of the ${faction} faction. Respond only in JSON.`
  }
}

const personas: Record<string, string> = {
  nato: loadPersona('nato'),
  russia: loadPersona('russia'),
  china: loadPersona('china')
}

/** Turns of lost yield after a nuclear strike (the next FALLOUT_TURNS turns pay nothing). */
const FALLOUT_TURNS = 5

/** Turns an unanswered alliance proposal stays open. */
const PROPOSAL_TTL = 2

/** Event types every faction hears about, whoever caused them. */
const PUBLIC_EVENTS = new Set<GameEvent['type']>(['combat', 'capture', 'nuke', 'betrayal', 'build_nuke', 'victory'])

const UNIT_ABBR: Record<string, string> = { infantry: 'inf', armor: 'arm', artillery: 'art' }

interface InboxItem {
  turn: number
  from: string
  kind: 'message' | 'alliance_proposal' | 'trade'
  text: string
}

/** Thrown when a game was reset (stop -> start) while a turn was awaiting the AI. */
export class StaleTurnError extends Error {
  constructor(turn: number) {
    super(`Turn ${turn} discarded: the game was reset while it was in flight`)
    this.name = 'StaleTurnError'
  }
}

export class GameEngine {
  state: GameState
  turnHistory: TurnResult[] = []
  chatLog: ChatMessage[] = []
  recentEvents: GameEvent[] = []
  /** "proposer->target" -> turn the proposal was made. Expires after PROPOSAL_TTL turns. */
  pendingAlliances: Map<string, number> = new Map()
  /** "a|b" (sorted) -> turn the alliance formed; the diplomatic victory clock. */
  allianceSince: Map<string, number> = new Map()
  /** Diplomatic messages and proposals each faction will see in its next briefing. */
  inbox: Record<string, InboxItem[]> = {}
  /** Territories revealed by spying: written this turn, shown in next turn's briefing. */
  pendingIntel: Record<string, Set<string>> = {}
  intel: Record<string, Set<string>> = {}
  /** Units that have already moved or attacked this turn. */
  actedUnits: Set<string> = new Set()
  /** Last unit number issued per "faction-type" prefix, so ids never repeat. */
  unitSerial: Record<string, number> = {}
  surpriseAttackBonus: Record<string, number> = {}
  /** Private memo each faction asked to get back next turn. */
  notes: Record<string, string> = {}
  /** Public statements made this turn, for the narrator. */
  turnMessages: { from: string; text: string }[] = []
  /** Tokens, latency and estimated cost per AI role for the current game. */
  usage = new UsageTracker()
  /** Source of every die roll; seeded so a game can be replayed. Tests may replace it. */
  rng: () => number
  seed: number
  private fixedSeed: number | undefined
  running = false
  /** True while a started game is suspended between turns (pause/step). */
  paused = false
  turnExecuting = false
  intervalMs = 10000
  turnInterval: ReturnType<typeof setInterval> | null = null
  /** Bumped by reset(); a turn that started under an older generation is discarded. */
  generation = 0

  /** With a `seed`, every game rolls the same dice stream; otherwise each game draws a fresh seed. */
  constructor(opts: { seed?: number } = {}) {
    this.fixedSeed = opts.seed
    this.seed = opts.seed ?? randomSeed()
    this.rng = mulberry32(this.seed)
    const raw = readFileSync(resolve(__dirname, '../game/initial-world.json'), 'utf-8')
    this.state = JSON.parse(raw)
    this.state.game.seed = this.seed
  }

  reset() {
    this.generation++
    const raw = readFileSync(resolve(__dirname, '../game/initial-world.json'), 'utf-8')
    this.state = JSON.parse(raw)
    this.turnHistory = []
    this.chatLog = []
    this.pendingAlliances = new Map()
    this.allianceSince = new Map()
    this.inbox = {}
    this.pendingIntel = {}
    this.intel = {}
    this.actedUnits = new Set()
    this.unitSerial = {}
    this.surpriseAttackBonus = {}
    this.notes = {}
    this.turnMessages = []
    this.usage = new UsageTracker()
    this.paused = false
    this.seed = this.fixedSeed ?? randomSeed()
    this.rng = mulberry32(this.seed)
    this.state.game.seed = this.seed
    this.state.game.startedAt = new Date().toISOString()
    this.state.game.turn = 0
    this.state.game.status = 'active'
    this.state.game.victor = null
  }

  /** Begin a fresh game and run a turn every `intervalMs`. */
  start(intervalMs: number = this.intervalMs) {
    console.log(`engine.start() called, running=${this.running}, intervalMs=${intervalMs}`)
    if (this.running) return
    this.begin(intervalMs)
    this.schedule()
  }

  private begin(intervalMs: number) {
    this.intervalMs = intervalMs
    this.reset()
    this.running = true
    this.turnExecuting = false
    this.addChat('command', 'gm', 'The Arbiter', `WAR GAMES INITIATED (seed ${this.seed}). Three factions claim their territories across the globe...`)
  }

  private schedule() {
    this.clearTimer()
    this.turnInterval = setInterval(() => void this.tick(), this.intervalMs)
  }

  private clearTimer() {
    if (this.turnInterval) {
      clearInterval(this.turnInterval)
      this.turnInterval = null
    }
  }

  /** Run one turn if the game is live and no turn is in flight; stops the game once it finishes. */
  private async tick() {
    if (this.state.game.status !== 'active') {
      this.stop()
      return
    }
    if (this.turnExecuting) {
      console.log('Previous turn still executing, skipping...')
      return
    }
    const gen = this.generation
    this.turnExecuting = true
    try {
      await this.executeTurn()
    } catch (err) {
      if (err instanceof StaleTurnError) console.log(err.message)
      else console.error('Turn error:', err)
    } finally {
      // A turn from a previous game must not clear the flag for the new game's turn.
      if (gen === this.generation) {
        this.turnExecuting = false
        if (this.state.game.status !== 'active') this.stop()
      }
    }
  }

  /** Suspend the turn timer; the game, and any turn already in flight, carry on. */
  pause() {
    if (!this.running || this.paused) return
    this.paused = true
    this.clearTimer()
  }

  /** Resume a paused game: the next turn starts now, then every interval. */
  resume() {
    if (!this.running || !this.paused) return
    this.paused = false
    this.schedule()
    void this.tick()
  }

  /**
   * Play exactly one turn and stay paused. Starts a fresh game first if none is
   * running. Returns false (and does nothing) while a turn is still in flight.
   */
  step(): boolean {
    if (this.turnExecuting) return false
    if (!this.running) this.begin(this.intervalMs)
    this.pause()
    void this.tick()
    return true
  }

  /** Change the turn interval; takes effect immediately for a running game. */
  setIntervalMs(ms: number) {
    this.intervalMs = ms
    if (this.running && !this.paused) this.schedule()
  }

  control() {
    return { running: this.running, paused: this.paused, turnExecuting: this.turnExecuting, intervalMs: this.intervalMs }
  }

  usageSnapshot(): UsageSnapshot {
    return this.usage.snapshot()
  }

  stop() {
    this.running = false
    this.paused = false
    this.clearTimer()
  }

  private addChat(channel: ChatMessage['channel'], agent: string, agentName: string, message: string) {
    this.chatLog.push({
      turn: this.state.game.turn,
      timestamp: new Date().toISOString(),
      agent,
      agentName,
      channel,
      message
    })
  }

  private buildBriefing(factionId: string): string {
    const faction = this.state.factions[factionId]
    const visibleTerritories = this.getVisibleTerritories(factionId)
    const territoryStates: Record<string, unknown> = {}

    for (const tId of visibleTerritories) {
      const territory = this.state.map.territories[tId]
      const unitsHere: { id: string; type: string; owner: string }[] = []
      for (const [fid, f] of Object.entries(this.state.factions)) {
        for (const u of f.units) {
          if (u.territory === tId) unitsHere.push({ id: u.id, type: u.type, owner: fid })
        }
      }
      territoryStates[tId] = {
        name: territory.name,
        terrain: territory.terrain,
        continent: territory.continent,
        owner: territory.owner,
        fortified: territory.fortified,
        mercenaries: territory.mercenaries || 0,
        ...(territory.fallout ? { falloutClearsOnTurn: territory.fallout.until } : {}),
        units: unitsHere,
        adjacent: this.state.map.adjacency[tId]
      }
    }

    // Check continent control
    const continentControl: string[] = []
    for (const [contId, cont] of Object.entries(this.state.map.continents)) {
      if (cont.territories.every(t => this.state.map.territories[t]?.owner === factionId)) {
        continentControl.push(contId)
      }
    }

    // Build per-unit action hints so AI knows valid moves/attacks
    const unitActions: Record<string, { type: string; location: string; canMoveTo: string[]; canAttack: string[] }> = {}
    for (const unit of faction.units) {
      const canAttack = (this.state.map.adjacency[unit.territory] || []).filter(tId => {
        const t = this.state.map.territories[tId]
        if (!t || this.isAllied(factionId, t.owner)) return false
        const hasEnemyUnits = this.getUnitsAtTerritory(tId).some(u => u.owner !== factionId)
        const hasMercs = (t.mercenaries || 0) > 0 && t.owner !== factionId
        return hasEnemyUnits || hasMercs
      })
      unitActions[unit.id] = { type: unit.type, location: unit.territory, canMoveTo: this.reachable(factionId, unit), canAttack }
    }

    // Diplomacy: what others said to you, and alliance proposals waiting on an answer
    const incomingProposals: { from: string; turn: number }[] = []
    const outgoingProposals: { to: string; turn: number }[] = []
    for (const [key, turn] of this.pendingAlliances) {
      const [from, to] = key.split('->')
      if (to === factionId) incomingProposals.push({ from, turn })
      if (from === factionId) outgoingProposals.push({ to, turn })
    }

    const turnsLeft = this.state.game.maxTurns - this.state.game.turn
    const lastTurn = this.turnHistory.at(-1)
    return JSON.stringify({
      turn: this.state.game.turn,
      maxTurns: this.state.game.maxTurns,
      turnsRemaining: turnsLeft,
      urgency: turnsLeft <= 5 ? 'CRITICAL - game ends soon, act decisively!' : turnsLeft <= 10 ? 'Time is running out - be aggressive!' : 'Play aggressively - this is a short game.',
      you: factionId,
      resources: faction.resources,
      foodUpkeepPerTurn: faction.units.length,
      tech: faction.tech,
      nukes: faction.nukes || 0,
      oathbreaker: faction.oathbreaker || false,
      units: faction.units,
      unitActions,
      territoryCount: faction.territoryCount,
      continentsControlled: continentControl,
      visibleMap: territoryStates,
      alliances: faction.alliances.map(a => ({ with: a, sinceTurn: this.allianceSince.get(this.pairKey(factionId, a)) })),
      incomingAllianceProposals: incomingProposals,
      yourPendingProposals: outgoingProposals,
      inbox: (this.inbox[factionId] || []).slice(-10),
      otherFactions: Object.fromEntries(Object.entries(this.state.factions)
        .filter(([fid]) => fid !== factionId)
        .map(([fid, f]) => [fid, { territoryCount: f.territoryCount, alliances: f.alliances, oathbreaker: f.oathbreaker || false }])),
      yourLastReasoning: lastTurn?.orders[factionId]?.reasoning,
      yourNotes: this.notes[factionId],
      victoryConditions: this.state.victoryConditions,
      recentEvents: this.turnHistory.slice(-3).flatMap(t => t.events
        .filter(e => e.faction === factionId || PUBLIC_EVENTS.has(e.type) || e.details?.to === factionId)
        .map(e => `T${t.turn}: ${e.description}`))
    })
  }

  private pairKey(a: string, b: string): string {
    return [a, b].sort().join('|')
  }

  private isAllied(factionId: string, other: string | null | undefined): boolean {
    return !!other && other !== factionId && this.state.factions[factionId].alliances.includes(other)
  }

  /**
   * Territories a unit can move to this turn: adjacent ones with no enemy (or
   * allied) units and no allied owner; units with movement 2 may also pass
   * through one territory the faction owns that holds no other faction's units.
   */
  private reachable(factionId: string, unit: Unit): string[] {
    const enterable = (tId: string) => {
      const t = this.state.map.territories[tId]
      if (!t || this.isAllied(factionId, t.owner)) return false
      return !this.getUnitsAtTerritory(tId).some(u => u.owner !== factionId)
    }
    const result = new Set<string>()
    const adj = this.state.map.adjacency[unit.territory] || []
    for (const tId of adj) if (enterable(tId)) result.add(tId)
    if ((UNIT_STATS[unit.type]?.movement || 1) >= 2) {
      for (const mid of adj) {
        if (this.state.map.territories[mid]?.owner !== factionId || !enterable(mid)) continue
        for (const tId of this.state.map.adjacency[mid] || []) {
          if (tId !== unit.territory && enterable(tId)) result.add(tId)
        }
      }
    }
    return Array.from(result)
  }

  /** Next never-used id for a new unit, e.g. nato-inf-8 after nato-inf-1..7. */
  private nextUnitId(factionId: string, abbr: string): string {
    const prefix = `${factionId}-${abbr}-`
    if (this.unitSerial[prefix] === undefined) {
      let max = 0
      for (const u of this.state.factions[factionId].units) {
        if (u.id.startsWith(prefix)) max = Math.max(max, Number(u.id.slice(prefix.length)) || 0)
      }
      this.unitSerial[prefix] = max
    }
    return `${prefix}${++this.unitSerial[prefix]}`
  }

  /** Find the ordered unit by exact id, rejecting unknown ids and units that already acted. */
  private orderedUnit(factionId: string, order: Order): Unit | GameEvent {
    const fName = this.state.factions[factionId].name
    if (!order.unit) return { type: 'invalid', faction: factionId, description: `${fName}: ${order.action} order names no unit` }
    const unit = this.state.factions[factionId].units.find(u => u.id === order.unit)
    if (!unit) return { type: 'invalid', faction: factionId, description: `${fName}: unknown unit ${order.unit}` }
    if (this.actedUnits.has(unit.id)) return { type: 'invalid', faction: factionId, description: `${fName}: ${unit.id} already acted this turn` }
    return unit
  }

  private getVisibleTerritories(factionId: string): string[] {
    const visible = new Set<string>()
    const faction = this.state.factions[factionId]

    // Add owned territories and their neighbors
    for (const [tId, territory] of Object.entries(this.state.map.territories)) {
      if (territory.owner === factionId) {
        visible.add(tId)
        for (const adj of this.state.map.adjacency[tId] || []) {
          visible.add(adj)
        }
      }
    }

    // Add territories around units
    for (const unit of faction.units) {
      visible.add(unit.territory)
      for (const adj of this.state.map.adjacency[unit.territory] || []) {
        visible.add(adj)
      }
    }

    // Alliance shared vision
    for (const allyId of faction.alliances) {
      const ally = this.state.factions[allyId]
      if (!ally) continue
      for (const [tId, territory] of Object.entries(this.state.map.territories)) {
        if (territory.owner === allyId) visible.add(tId)
      }
    }

    // Spy reports from last turn
    for (const tId of this.intel[factionId] || []) visible.add(tId)

    return Array.from(visible)
  }

  async executeTurn(): Promise<TurnResult> {
    const gen = this.generation
    this.state.game.turn++
    const turn = this.state.game.turn
    const events: GameEvent[] = []
    const allOrders: Record<string, FactionOrders> = {}

    console.log(`\n=== EXECUTING TURN ${turn} ===`)

    // Decrement surprise attack bonuses (they last 1 turn)
    for (const fid of Object.keys(this.surpriseAttackBonus)) {
      delete this.surpriseAttackBonus[fid]
    }
    this.actedUnits.clear()
    this.turnMessages = []
    // Fallout lifts: the yield a strike wiped comes back to whoever holds the land
    for (const [tId, t] of Object.entries(this.state.map.territories)) {
      if (t.fallout && turn >= t.fallout.until) {
        t.resources = t.fallout.resources
        delete t.fallout
        this.addChat('command', 'gm', 'The Arbiter', `Fallout clears over ${t.name}: its resources are usable again.`)
        console.log(`[turn ${turn}] fallout cleared at ${tId}`)
      }
    }
    // Last turn's spy reports become this turn's vision
    this.intel = this.pendingIntel
    this.pendingIntel = {}
    // Unanswered alliance proposals lapse
    for (const [key, proposed] of this.pendingAlliances) {
      if (turn - proposed > PROPOSAL_TTL) this.pendingAlliances.delete(key)
    }

    this.addChat('command', 'gm', 'The Arbiter', `--- TURN ${turn} ---`)

    // Collect resources from owned territories, then pay food upkeep
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      faction.resources.knowledge += 1

      // Territory resources
      for (const territory of Object.values(this.state.map.territories)) {
        if (territory.owner === factionId) {
          for (const [res, amount] of Object.entries(territory.resources)) {
            (faction.resources as Record<string, number>)[res] = ((faction.resources as Record<string, number>)[res] || 0) + amount
          }
        }
      }

      // Continent bonus
      for (const cont of Object.values(this.state.map.continents)) {
        if (cont.territories.every(t => this.state.map.territories[t]?.owner === factionId)) {
          for (const [res, amount] of Object.entries(cont.bonus)) {
            (faction.resources as Record<string, number>)[res] = ((faction.resources as Record<string, number>)[res] || 0) + amount
          }
        }
      }

      // Trade Networks (economic tech 1) - coastal territories produce +1 gold
      if (faction.tech.economic >= 1) {
        for (const territory of Object.values(this.state.map.territories)) {
          if (territory.owner === factionId && territory.terrain === 'coast') {
            faction.resources.gold += 1
          }
        }
      }

      // Central Banking (economic tech 2) - 10% interest on gold
      if (faction.tech.economic >= 2) {
        faction.resources.gold += Math.floor(faction.resources.gold * 0.1)
      }

      // Upkeep: 1 food per unit. Each unit that can't be fed (newest first) loses 1 hp.
      const upkeep = faction.units.length
      const shortfall = Math.max(0, upkeep - faction.resources.food)
      faction.resources.food = Math.max(0, faction.resources.food - upkeep)
      if (shortfall > 0) {
        const hungry = faction.units.slice(-shortfall)
        for (const u of hungry) u.hp -= 1
        const lost = hungry.filter(u => u.hp <= 0).length
        faction.units = faction.units.filter(u => u.hp > 0)
        events.push({
          type: 'attrition',
          faction: factionId,
          description: `${faction.name} cannot feed ${shortfall} unit${shortfall > 1 ? 's' : ''}` + (lost ? ` - ${lost} lost to starvation` : ''),
        })
      }
    }

    // Get orders from each faction (parallel)
    console.log(`[turn ${turn}] Requesting orders from ${Object.keys(this.state.factions).length} factions...`)
    const orderPromises = Object.keys(this.state.factions).map(async (factionId) => {
      const briefing = this.buildBriefing(factionId)
      console.log(`[turn ${turn}] Calling getFactionOrders for ${factionId}...`)
      const orders = await getFactionOrders(factionId, personas[factionId], briefing, u => {
        if (gen === this.generation) this.usage.record(factionId, u)
      })
      if (gen !== this.generation) return
      if (orders.notes) this.notes[factionId] = orders.notes
      console.log(`[turn ${turn}] Got orders for ${factionId}: ${orders.orders.length} orders`)
      allOrders[factionId] = orders

      const fName = this.state.factions[factionId].name
      if (orders.orders.length === 0) {
        events.push({ type: 'forfeit', faction: factionId, description: `${fName} forfeits their turn` })
        this.addChat(factionId as ChatMessage['channel'], factionId, fName, `[No orders — ${orders.reasoning || 'forfeit'}]`)
      } else {
        const orderSummary = orders.orders.map(o => o.action).join(', ')
        this.addChat(factionId as ChatMessage['channel'], factionId, fName, `Orders: ${orderSummary}${orders.reasoning ? ` — ${orders.reasoning}` : ''}`)
      }
    })

    await Promise.all(orderPromises)
    if (gen !== this.generation) throw new StaleTurnError(turn)
    console.log(`[turn ${turn}] All faction orders received`)

    // Resolve orders. The faction that resolves first rotates every turn so no
    // seat (and no provider) always gets the first move.
    const seats = Object.keys(this.state.factions)
    const shift = (turn - 1) % seats.length
    for (const factionId of [...seats.slice(shift), ...seats.slice(0, shift)]) {
      for (const order of allOrders[factionId]?.orders || []) {
        const result = this.resolveOrder(factionId, order)
        if (result) events.push(result)
      }
    }

    // Update territory counts and scores
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      let count = 0
      for (const territory of Object.values(this.state.map.territories)) {
        if (territory.owner === factionId) count++
      }
      faction.territoryCount = count
      const r = faction.resources
      const t = faction.tech
      faction.score = (count * 3) + Math.floor(
        (r.gold + r.food + r.iron + r.influence + r.knowledge + (r.uranium || 0)) / 5
      ) + ((t.military + t.economic + t.intelligence + (t.nuclear || 0)) * 2)
    }

    // Check victory
    const victor = this.checkVictory()
    if (victor) {
      this.state.game.status = 'finished'
      this.state.game.victor = victor.faction
      events.push({ type: 'victory', faction: victor.faction, description: `${this.state.factions[victor.faction].name} achieves ${victor.type} victory!` })
      this.addChat('command', 'gm', 'The Arbiter', `VICTORY: ${this.state.factions[victor.faction].name} wins by ${victor.type}!`)
    }

    if (turn >= this.state.game.maxTurns) {
      this.state.game.status = 'finished'
      let best = { id: '', score: -1 }
      for (const [id, f] of Object.entries(this.state.factions)) {
        if (f.score > best.score) best = { id, score: f.score }
      }
      this.state.game.victor = best.id
      events.push({ type: 'victory', faction: best.id, description: `${this.state.factions[best.id].name} wins by highest score (${best.score})!` })
    }

    // Post turn summary to command
    const eventSummary = events.map(e => e.description).join('. ')
    this.addChat('command', 'gm', 'The Arbiter', eventSummary || 'A quiet turn — no significant events.')

    // Get narrative
    const narrative = await getNarrative(this.narratorBrief(turn, events), u => {
      if (gen === this.generation) this.usage.record('narrator', u)
    })
    if (gen !== this.generation) throw new StaleTurnError(turn)
    this.addChat('observer', 'narrator', 'The Chronicler', narrative)

    // Store recent events for globe animation
    this.recentEvents = events

    const turnResult: TurnResult = {
      turn,
      timestamp: new Date().toISOString(),
      orders: allOrders,
      events,
      narrative
    }
    this.turnHistory.push(turnResult)

    return turnResult
  }

  /** What the narrator is told about a turn: public events and statements only, never private reasoning or notes. */
  private narratorBrief(turn: number, events: GameEvent[]): string {
    const happened = events.filter(e => e.type !== 'invalid' && e.type !== 'message').map(e => e.description)
    const lines = [`Turn ${turn} of ${this.state.game.maxTurns}.`, `Events: ${happened.join('. ') || 'a quiet turn, nothing of note'}.`]
    if (this.turnMessages.length) {
      lines.push('Public statements: ' + this.turnMessages.map(m => `${this.state.factions[m.from].name} said "${m.text}"`).join(' | '))
    }
    lines.push('Standings: ' + Object.values(this.state.factions).map(f => {
      const allies = f.alliances.map(a => this.state.factions[a].name).join(' and ')
      return `${f.name} - ${f.territoryCount} territories, ${f.resources.gold} gold, ${f.nukes || 0} warheads` + (allies ? `, allied with ${allies}` : '')
    }).join('; '))
    const previous = this.turnHistory.at(-1)?.narrative
    if (previous) lines.push(`Previous bulletin (continue the story, do not repeat it): ${previous}`)
    return lines.join('\n')
  }

  /** A nuclear strike: fortification and owner are lost and the yield is wiped for FALLOUT_TURNS turns. */
  private irradiate(tId: string) {
    const t = this.state.map.territories[tId]
    t.fortified = false
    t.owner = null
    // A second strike on contaminated land extends the fallout but keeps the original yield
    const original = t.fallout?.resources ?? { ...t.resources }
    t.fallout = { until: this.state.game.turn + FALLOUT_TURNS + 1, resources: original }
    t.resources = {}
  }

  private resolveOrder(factionId: string, order: Order): GameEvent | null {
    const faction = this.state.factions[factionId]
    const fName = faction.name

    switch (order.action) {
      case 'move': {
        // Accept to OR target field
        const moveTo = order.to || order.target
        if (!moveTo) return { type: 'invalid', faction: factionId, description: `${fName}: move order has no destination` }
        const found = this.orderedUnit(factionId, order)
        if (!('hp' in found)) return found
        const unit = found
        const territory = this.state.map.territories[moveTo]
        if (!territory) return { type: 'invalid', faction: factionId, description: `${fName}: unknown territory ${moveTo}` }
        if (this.isAllied(factionId, territory.owner)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: ${territory.name} belongs to an ally - break_alliance first` }
        }
        const adjacent = this.state.map.adjacency[unit.territory]?.includes(moveTo)
        const defenders = this.getUnitsAtTerritory(moveTo).filter(u => u.owner !== factionId)
        if (defenders.some(d => this.isAllied(factionId, d.owner))) {
          return { type: 'invalid', faction: factionId, description: `${fName}: allied units hold ${territory.name} - break_alliance first` }
        }
        // Moving into enemy units is an attack, which needs adjacency; otherwise use the unit's movement range
        if (defenders.length > 0 ? !adjacent : !this.reachable(factionId, unit).includes(moveTo)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: ${unit.id} cannot reach ${territory.name} from ${unit.territory}` }
        }
        this.actedUnits.add(unit.id)

        const oldTerritory = unit.territory
        if (defenders.length > 0) {
          return this.resolveCombat(factionId, unit, defenders[0].owner, defenders[0].unit, moveTo)
        }
        if (!territory.owner && territory.mercenaries > 0) {
          return this.resolveMercenaryCombat(factionId, unit, moveTo)
        }
        unit.territory = moveTo
        if (territory.owner !== factionId) {
          const was = territory.owner ? 'undefended' : 'neutral'
          territory.owner = factionId
          return { type: 'capture', faction: factionId, description: `${fName} captures ${was} ${territory.name}`, from: oldTerritory, to: moveTo }
        }
        return { type: 'move', faction: factionId, description: `${fName} moves unit to ${territory.name}`, from: oldTerritory, to: moveTo }
      }

      case 'attack': {
        // Accept target OR to field (AI often confuses them)
        const attackTarget = order.target || order.to
        if (!attackTarget) return { type: 'invalid', faction: factionId, description: `${fName}: attack order has no target` }
        const found = this.orderedUnit(factionId, order)
        if (!('hp' in found)) return found
        const unit = found
        const territory = this.state.map.territories[attackTarget]
        if (!territory) return { type: 'invalid', faction: factionId, description: `${fName}: unknown territory ${attackTarget}` }
        if (!this.state.map.adjacency[unit.territory]?.includes(attackTarget)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: ${unit.id} at ${unit.territory} is not adjacent to ${territory.name}` }
        }
        if (territory.owner === factionId) return { type: 'invalid', faction: factionId, description: `${fName}: can't attack your own ${territory.name}` }
        const defenders = this.getUnitsAtTerritory(attackTarget).filter(u => u.owner !== factionId)
        if (this.isAllied(factionId, territory.owner) || defenders.some(d => this.isAllied(factionId, d.owner))) {
          return { type: 'invalid', faction: factionId, description: `${fName}: ${territory.name} is held by an ally - break_alliance first` }
        }
        this.actedUnits.add(unit.id)
        const attackFrom = unit.territory

        if (defenders.length === 0) {
          // Mercenary defenders in neutral territory
          if (!territory.owner && territory.mercenaries > 0) {
            return this.resolveMercenaryCombat(factionId, unit, attackTarget)
          }
          unit.territory = attackTarget
          territory.owner = factionId
          return { type: 'capture', faction: factionId, description: `${fName} takes undefended ${territory.name}`, from: attackFrom, to: attackTarget }
        }

        return this.resolveCombat(factionId, unit, defenders[0].owner, defenders[0].unit, attackTarget)
      }

      case 'fortify': {
        const tId = order.territory
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: invalid fortify` }
        const territory = this.state.map.territories[tId]
        if (!territory || territory.owner !== factionId) return { type: 'invalid', faction: factionId, description: `${fName}: can't fortify ${tId}` }
        if (faction.resources.iron < 2) return { type: 'invalid', faction: factionId, description: `${fName}: not enough iron to fortify` }
        faction.resources.iron -= 2
        territory.fortified = true
        return { type: 'fortify', faction: factionId, description: `${fName} fortifies ${territory.name}`, to: tId }
      }

      case 'recruit': {
        const unitType = order.type || 'infantry'
        const stats = UNIT_STATS[unitType]
        if (!stats) return { type: 'invalid', faction: factionId, description: `${fName}: unknown unit type ${unitType}` }
        if (faction.resources.gold < stats.cost.gold || faction.resources.iron < stats.cost.iron) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't afford ${unitType}` }
        }
        if (unitType === 'armor' && faction.tech.military < 1) return { type: 'invalid', faction: factionId, description: `${fName}: mechanized infantry not researched` }
        if (unitType === 'artillery' && faction.tech.military < 2) return { type: 'invalid', faction: factionId, description: `${fName}: precision strike not researched` }

        const tId = order.territory || order.to || order.target
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: recruit order names no territory` }
        if (this.state.map.territories[tId]?.owner !== factionId) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can only recruit in a territory you own, not ${tId}` }
        }

        faction.resources.gold -= stats.cost.gold
        faction.resources.iron -= stats.cost.iron
        const newUnit = { id: this.nextUnitId(factionId, UNIT_ABBR[unitType]), type: unitType as 'infantry' | 'armor' | 'artillery', territory: tId, hp: 2, xp: 0 }
        faction.units.push(newUnit)
        this.actedUnits.add(newUnit.id) // fresh recruits act from next turn
        const tName = this.state.map.territories[tId]?.name || tId
        return { type: 'recruit', faction: factionId, description: `${fName} recruits ${unitType} at ${tName}`, to: tId }
      }

      case 'research': {
        const tech = order.tech
        if (!tech || !['military', 'economic', 'intelligence', 'nuclear'].includes(tech)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: invalid research target` }
        }
        const currentLevel = (faction.tech as Record<string, number>)[tech]
        if (currentLevel >= 3) return { type: 'invalid', faction: factionId, description: `${fName}: ${tech} already maxed` }

        // Nuclear tech has special costs (knowledge + uranium)
        if (tech === 'nuclear') {
          const nuclearKnowledgeCosts = [5, 8, 10]
          const nuclearUraniumCosts = [3, 5, 8]
          const kCost = nuclearKnowledgeCosts[currentLevel]
          const uCost = nuclearUraniumCosts[currentLevel]
          if (faction.resources.knowledge < kCost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough knowledge for nuclear research` }
          if (faction.resources.uranium < uCost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough uranium for nuclear research` }
          faction.resources.knowledge -= kCost
          faction.resources.uranium -= uCost
        } else {
          const costs = [3, 5, 8]
          const cost = costs[currentLevel]
          if (faction.resources.knowledge < cost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough knowledge for ${tech}` }
          faction.resources.knowledge -= cost
        }

        ;(faction.tech as Record<string, number>)[tech] = currentLevel + 1
        return { type: 'research', faction: factionId, description: `${fName} researches ${tech} level ${currentLevel + 1}`, to: faction.units[0]?.territory }
      }

      case 'spy': {
        const spyTarget = order.target || order.territory || order.to
        if (!spyTarget || !this.state.map.territories[spyTarget]) {
          return { type: 'invalid', faction: factionId, description: `${fName}: spy needs a territory target` }
        }
        const cost = faction.tech.intelligence >= 1 ? 1 : 2
        if (faction.resources.influence < cost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough influence to spy` }
        faction.resources.influence -= cost
        ;(this.pendingIntel[factionId] ??= new Set()).add(spyTarget)
        return { type: 'spy', faction: factionId, description: `${fName} sends spies to ${this.state.map.territories[spyTarget].name}`, to: spyTarget }
      }

      case 'trade': {
        if (!order.to || !order.offer) return { type: 'invalid', faction: factionId, description: `${fName}: invalid trade` }
        const target = this.state.factions[order.to]
        if (!target) return { type: 'invalid', faction: factionId, description: `${fName}: unknown trade target` }

        if (order.to === factionId) return { type: 'invalid', faction: factionId, description: `${fName}: can't trade with yourself` }
        const fRes = faction.resources as Record<string, number>
        const tRes = target.resources as Record<string, number>
        const offer = Object.entries(order.offer)
        if (offer.some(([res, amount]) => !(res in fRes) || typeof amount !== 'number' || amount <= 0 || fRes[res] < amount)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't afford trade` }
        }
        for (const [res, amount] of offer) {
          fRes[res] -= amount
          tRes[res] = (tRes[res] || 0) + amount
        }
        this.notify(order.to, factionId, 'trade', `${fName} sent you ${JSON.stringify(order.offer)}`)

        this.addChat('diplomacy', factionId, fName, `Sends ${JSON.stringify(order.offer)} to ${target.name}`)
        return { type: 'trade', faction: factionId, description: `${fName} trades ${JSON.stringify(order.offer)} to ${target.name}`, details: { to: order.to } }
      }

      case 'diplomacy': {
        if (!order.to || !order.proposal) return { type: 'invalid', faction: factionId, description: `${fName}: invalid diplomacy` }
        const target = this.state.factions[order.to]
        if (!target || order.to === factionId) return { type: 'invalid', faction: factionId, description: `${fName}: unknown faction ${order.to}` }
        if (order.proposal === 'alliance') {
          if (faction.alliances.includes(order.to)) return { type: 'invalid', faction: factionId, description: `${fName}: already allied with ${target.name}` }
          // Oathbreakers cannot form alliances
          if (faction.oathbreaker) return { type: 'invalid', faction: factionId, description: `${fName}: marked as Oathbreaker — no faction will accept your alliance` }
          if (target.oathbreaker) return { type: 'invalid', faction: factionId, description: `${fName}: ${target.name} is an Oathbreaker — alliance refused` }
          // Alliance requires mutual proposal — the target sees this one in its next briefing
          const pendingKey = `${factionId}->${order.to}`
          const reverseKey = `${order.to}->${factionId}`

          if (this.pendingAlliances.has(reverseKey)) {
            // Both sides have proposed — form the alliance
            faction.alliances.push(order.to)
            if (!target.alliances.includes(factionId)) target.alliances.push(factionId)
            this.pendingAlliances.delete(pendingKey)
            this.pendingAlliances.delete(reverseKey)
            this.allianceSince.set(this.pairKey(factionId, order.to), this.state.game.turn)
            this.notify(order.to, factionId, 'message', `${fName} accepted your alliance`)
            this.addChat('diplomacy', factionId, fName, `Alliance formed with ${target.name}!`)
            return { type: 'diplomacy', faction: factionId, description: `${fName} and ${target.name} form an alliance!`, details: { to: order.to } }
          }
          this.pendingAlliances.set(pendingKey, this.state.game.turn)
          this.notify(order.to, factionId, 'alliance_proposal', `${fName} proposes an alliance - propose one back to ${factionId} within ${PROPOSAL_TTL} turns to accept`)
          this.addChat('diplomacy', factionId, fName, `Proposes alliance with ${target.name}`)
          return { type: 'diplomacy', faction: factionId, description: `${fName} proposes alliance with ${target.name}`, details: { to: order.to } }
        }
        this.notify(order.to, factionId, 'message', `${fName} proposes: ${order.proposal}`)
        return { type: 'diplomacy', faction: factionId, description: `${fName} proposes ${order.proposal} with ${target.name}`, details: { to: order.to } }
      }

      case 'build_nuke': {
        if (faction.tech.nuclear < 1) return { type: 'invalid', faction: factionId, description: `${fName}: nuclear tech not researched` }
        const nukeCostGold = faction.tech.nuclear >= 2 ? 8 : 10
        const nukeCostUranium = faction.tech.nuclear >= 2 ? 3 : 5
        if (faction.resources.gold < nukeCostGold || faction.resources.uranium < nukeCostUranium) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't afford nuclear warhead (need ${nukeCostGold}g + ${nukeCostUranium}u)` }
        }
        faction.resources.gold -= nukeCostGold
        faction.resources.uranium -= nukeCostUranium
        faction.nukes = (faction.nukes || 0) + 1

        // Deterrence effect at nuclear level 3: other factions lose influence
        if (faction.tech.nuclear >= 3) {
          for (const [otherId, otherFaction] of Object.entries(this.state.factions)) {
            if (otherId !== factionId) {
              otherFaction.resources.influence = Math.max(0, otherFaction.resources.influence - 5)
            }
          }
        }

        this.addChat('command', 'gm', 'The Arbiter', `NUCLEAR ALERT: ${fName} has built a nuclear warhead!`)
        return { type: 'build_nuke', faction: factionId, description: `${fName} builds a nuclear warhead! (arsenal: ${faction.nukes})`, to: faction.units[0]?.territory }
      }

      case 'nuke': {
        if (!faction.nukes || faction.nukes < 1) return { type: 'invalid', faction: factionId, description: `${fName}: no nuclear warheads available` }
        const targetTId = order.target
        if (!targetTId) return { type: 'invalid', faction: factionId, description: `${fName}: invalid nuke target` }
        const targetTerritory = this.state.map.territories[targetTId]
        if (!targetTerritory) return { type: 'invalid', faction: factionId, description: `${fName}: unknown territory ${targetTId}` }

        // Without ICBM tech (nuclear >= 2), can only nuke adjacent territories
        if (faction.tech.nuclear < 2) {
          const ownedTerritories = Object.entries(this.state.map.territories)
            .filter(([_, t]) => t.owner === factionId)
            .map(([id]) => id)
          const adjacentToOwned = new Set<string>()
          for (const ownedT of ownedTerritories) {
            for (const adj of this.state.map.adjacency[ownedT] || []) {
              adjacentToOwned.add(adj)
            }
          }
          if (!adjacentToOwned.has(targetTId)) {
            return { type: 'invalid', faction: factionId, description: `${fName}: ${targetTId} not in range (need ICBM tech)` }
          }
        }

        // Can't nuke your own territory
        if (targetTerritory.owner === factionId) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't nuke your own territory` }
        }
        if (this.isAllied(factionId, targetTerritory.owner)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: ${targetTerritory.name} belongs to an ally - break_alliance first` }
        }

        faction.nukes--

        const tName = targetTerritory.name
        const targetOwner = targetTerritory.owner

        // Destroy ALL units in the territory
        for (const f of Object.values(this.state.factions)) {
          f.units = f.units.filter(u => u.territory !== targetTId)
        }

        this.irradiate(targetTId)

        this.addChat('command', 'gm', 'The Arbiter', `NUCLEAR STRIKE: ${fName} launches a nuclear warhead at ${tName}! All units destroyed. Territory irradiated for ${FALLOUT_TURNS} turns.`)
        this.addChat('diplomacy', factionId, fName, `We have unleashed nuclear fire upon ${tName}. Let this be a warning.`)

        // Second Strike retaliation check
        if (targetOwner && targetOwner !== factionId) {
          const defender = this.state.factions[targetOwner]
          if (defender && defender.tech.nuclear >= 3 && defender.nukes > 0) {
            // Auto-retaliate against a random attacker territory
            const attackerTerritories = Object.entries(this.state.map.territories)
              .filter(([_, t]) => t.owner === factionId)
            if (attackerTerritories.length > 0) {
              const [retaliationTId, retaliationTerritory] = attackerTerritories[Math.floor(this.rng() * attackerTerritories.length)]
              defender.nukes--
              // Destroy units in retaliation territory
              for (const f of Object.values(this.state.factions)) {
                f.units = f.units.filter(u => u.territory !== retaliationTId)
              }
              this.irradiate(retaliationTId)
              this.addChat('command', 'gm', 'The Arbiter', `SECOND STRIKE: ${defender.name} retaliates with a nuclear strike on ${retaliationTerritory.name}!`)
            }
          }
        }

        return {
          type: 'nuke',
          faction: factionId,
          description: `${fName} NUKES ${tName}! All units destroyed, territory irradiated.`,
          from: Object.entries(this.state.map.territories).find(([_, t]) => t.owner === factionId)?.[0],
          to: targetTId
        }
      }

      case 'break_alliance': {
        if (!order.to) return { type: 'invalid', faction: factionId, description: `${fName}: invalid break_alliance` }
        const allyIndex = faction.alliances.indexOf(order.to)
        if (allyIndex === -1) return { type: 'invalid', faction: factionId, description: `${fName}: no alliance with ${order.to} to break` }

        // Remove alliance from both sides
        faction.alliances.splice(allyIndex, 1)
        const target = this.state.factions[order.to]
        if (target) {
          const reverseIndex = target.alliances.indexOf(factionId)
          if (reverseIndex !== -1) target.alliances.splice(reverseIndex, 1)
          this.notify(order.to, factionId, 'message', `${fName} has broken your alliance`)
        }
        this.allianceSince.delete(this.pairKey(factionId, order.to))

        // Mark as oathbreaker permanently — no future alliances
        faction.oathbreaker = true
        // Grant surprise attack bonus for this turn
        this.surpriseAttackBonus[factionId] = 3

        this.addChat('diplomacy', factionId, fName, `BETRAYAL! ${fName} breaks their alliance with ${target?.name || order.to}!`)
        this.addChat('command', 'gm', 'The Arbiter', `OATHBREAKER: ${fName} has broken their alliance with ${target?.name || order.to}!`)
        return { type: 'betrayal', faction: factionId, description: `${fName} BETRAYS ${target?.name || order.to}! Alliance broken. Surprise attack bonus granted.`, to: faction.units[0]?.territory, details: { targetFaction: order.to } }
      }

      case 'message': {
        const msg = order.message
        if (!msg) return { type: 'invalid', faction: factionId, description: `${fName}: empty message` }
        // "to" a faction id sends privately; otherwise every other faction receives it
        const text = String(msg).slice(0, 280)
        const direct = order.to && order.to !== factionId && this.state.factions[order.to] ? order.to : null
        const recipients = direct ? [direct] : Object.keys(this.state.factions).filter(f => f !== factionId)
        for (const r of recipients) this.notify(r, factionId, 'message', text)
        if (!direct) this.turnMessages.push({ from: factionId, text })
        this.addChat('diplomacy', factionId, fName, direct ? `(to ${this.state.factions[direct].name}) ${text}` : text)
        return { type: 'message', faction: factionId, description: `${fName} sends a diplomatic message`, details: direct ? { to: direct } : undefined }
      }

      case 'hire_mercenary': {
        const tId = order.territory
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: invalid hire_mercenary — no territory` }
        const territory = this.state.map.territories[tId]
        if (!territory) return { type: 'invalid', faction: factionId, description: `${fName}: unknown territory ${tId}` }
        if (!territory.mercenaries || territory.mercenaries < 1) return { type: 'invalid', faction: factionId, description: `${fName}: no mercenaries in ${territory.name}` }

        // Must be adjacent to owned territory or have a unit there
        const hasAccess = faction.units.some(u => u.territory === tId) ||
          Object.entries(this.state.map.territories).some(([tid, t]) =>
            t.owner === factionId && (this.state.map.adjacency[tid] || []).includes(tId)
          )
        if (!hasAccess) return { type: 'invalid', faction: factionId, description: `${fName}: no access to ${territory.name} to hire mercenaries` }

        const hireCost = 5
        if (faction.resources.gold < hireCost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough gold to hire mercenary (need ${hireCost})` }

        faction.resources.gold -= hireCost
        territory.mercenaries--
        const mercUnit = { id: this.nextUnitId(factionId, 'merc'), type: 'infantry' as const, territory: tId, hp: 2, xp: 0 }
        faction.units.push(mercUnit)
        this.actedUnits.add(mercUnit.id)

        // Claim the territory if neutral
        if (!territory.owner) territory.owner = factionId

        const tName = territory.name
        return { type: 'hire_mercenary', faction: factionId, description: `${fName} hires a mercenary at ${tName}`, to: tId }
      }

      default:
        return { type: 'invalid', faction: factionId, description: `${fName}: unknown action ${order.action}` }
    }
  }

  private notify(to: string, from: string, kind: InboxItem['kind'], text: string) {
    const box = (this.inbox[to] ??= [])
    box.push({ turn: this.state.game.turn, from, kind, text })
    if (box.length > 20) box.splice(0, box.length - 20)
  }

  private getUnitsAtTerritory(tId: string): { owner: string; unit: Unit }[] {
    const results: { owner: string; unit: Unit }[] = []
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      for (const unit of faction.units) {
        if (unit.territory === tId) results.push({ owner: factionId, unit })
      }
    }
    return results
  }

  private resolveCombat(attackerId: string, attackerUnit: Unit, defenderId: string, defenderUnit: Unit, tId: string): GameEvent {
    const attackerFaction = this.state.factions[attackerId]
    const defenderFaction = this.state.factions[defenderId]
    const territory = this.state.map.territories[tId]
    const tName = territory?.name || tId
    const attackerFrom = attackerUnit.territory

    const aStats = UNIT_STATS[attackerUnit.type]
    const dStats = UNIT_STATS[defenderUnit.type]
    const terrainBonus = TERRAIN_DEFENSE[territory.terrain] || 0
    // Precision Strike (military tech 2): artillery ignores fortification
    const artilleryBypass = attackerUnit.type === 'artillery' && attackerFaction.tech.military >= 2
    const fortBonus = (territory.fortified && !artilleryBypass) ? 2 : 0

    const xpBonus = (unit: Unit) => Math.floor((unit.xp || 0) / 1) // +1 attack per XP
    const surpriseBonus = this.surpriseAttackBonus[attackerId] || 0

    // Combined Arms Doctrine (military tech 3): +1 attack, veterans get +1 defense
    const attackStrength = aStats.attack + (attackerFaction.tech.military >= 3 ? 1 : 0) + xpBonus(attackerUnit) + surpriseBonus
    const veteranDefBonus = (defenderFaction.tech.military >= 3 && defenderUnit.xp > 0) ? 1 : 0
    const defendStrength = dStats.defense + terrainBonus + fortBonus + (defenderFaction.tech.military >= 3 ? 1 : 0) + veteranDefBonus + xpBonus(defenderUnit)

    const roll = Math.floor(this.rng() * 6) + 1 + (attackStrength - defendStrength)

    if (roll >= 7) {
      defenderUnit.hp -= 2
      if (defenderUnit.hp <= 0) {
        defenderFaction.units = defenderFaction.units.filter(u => u.id !== defenderUnit.id)
      } else {
        const retreatTerritory = (this.state.map.adjacency[tId] || []).find(t => this.state.map.territories[t]?.owner === defenderId)
        if (retreatTerritory) defenderUnit.territory = retreatTerritory
        else defenderFaction.units = defenderFaction.units.filter(u => u.id !== defenderUnit.id)
      }
      attackerUnit.territory = tId
      territory.owner = attackerId
      territory.fortified = false
      // Attacker gains XP for winning
      if (attackerUnit.hp > 0) attackerUnit.xp = (attackerUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} defeats ${defenderFaction.name} at ${tName}! (roll: ${roll})`, from: attackerFrom, to: tId }
    } else if (roll >= 4) {
      attackerUnit.hp -= 1
      defenderUnit.hp -= 1
      if (attackerUnit.hp <= 0) attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
      else attackerUnit.xp = (attackerUnit.xp || 0) + 1
      if (defenderUnit.hp <= 0) defenderFaction.units = defenderFaction.units.filter(u => u.id !== defenderUnit.id)
      else defenderUnit.xp = (defenderUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `Battle at ${tName}: ${attackerFaction.name} vs ${defenderFaction.name} — draw!`, to: tId }
    } else {
      attackerUnit.hp -= 2
      if (attackerUnit.hp <= 0) {
        attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
      }
      // Defender gains XP for repelling
      defenderUnit.xp = (defenderUnit.xp || 0) + 1
      return { type: 'combat', faction: defenderId, description: `${defenderFaction.name} repels ${attackerFaction.name} at ${tName}!`, to: tId }
    }
  }

  private resolveMercenaryCombat(attackerId: string, attackerUnit: Unit, tId: string): GameEvent {
    const attackerFaction = this.state.factions[attackerId]
    const territory = this.state.map.territories[tId]
    const tName = territory?.name || tId
    const attackFrom = attackerUnit.territory

    const aStats = UNIT_STATS[attackerUnit.type]
    const terrainBonus = TERRAIN_DEFENSE[territory.terrain] || 0
    const xpBonus = Math.floor((attackerUnit.xp || 0) / 1)
    const surpriseBonus = this.surpriseAttackBonus[attackerId] || 0

    // Mercenaries fight as infantry
    const mercDefense = UNIT_STATS.infantry.defense + terrainBonus
    const attackStrength = aStats.attack + (attackerFaction.tech.military >= 3 ? 1 : 0) + xpBonus + surpriseBonus

    const roll = Math.floor(this.rng() * 6) + 1 + (attackStrength - mercDefense)

    if (roll >= 5) {
      // Attacker wins — clear mercenaries, capture territory
      territory.mercenaries = 0
      attackerUnit.territory = tId
      territory.owner = attackerId
      attackerUnit.xp = (attackerUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} defeats mercenaries at ${tName}!`, from: attackFrom, to: tId }
    } else if (roll >= 3) {
      // Partial — kill some mercenaries but take damage
      territory.mercenaries = Math.max(0, territory.mercenaries - 1)
      attackerUnit.hp -= 1
      if (attackerUnit.hp <= 0) {
        attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
        return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} fights mercenaries at ${tName} — mutual destruction!`, to: tId }
      }
      attackerUnit.xp = (attackerUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} clashes with mercenaries at ${tName} — both sides take losses`, to: tId }
    } else {
      // Attacker repelled
      attackerUnit.hp -= 1
      if (attackerUnit.hp <= 0) {
        attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
      }
      return { type: 'combat', faction: attackerId, description: `Mercenaries at ${tName} repel ${attackerFaction.name}!`, to: tId }
    }
  }

  private checkVictory(): { faction: string; type: string } | null {
    const vc = this.state.victoryConditions
    const turn = this.state.game.turn
    const winners: { faction: string; type: string }[] = []
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      // Domination
      if (faction.territoryCount >= vc.domination.territoriesRequired) {
        winners.push({ faction: factionId, type: 'domination' })
        continue
      }
      // Economic
      let coastCount = 0
      for (const territory of Object.values(this.state.map.territories)) {
        if (territory.owner === factionId && territory.terrain === 'coast') coastCount++
      }
      if (faction.resources.gold >= vc.economic.goldRequired && coastCount >= vc.economic.coastTerritoriesRequired) {
        winners.push({ faction: factionId, type: 'economic' })
        continue
      }
      // Diplomatic: enough alliances, each held for turnsRequired turns
      const held = faction.alliances.filter(a => {
        const since = this.allianceSince.get(this.pairKey(factionId, a))
        return since !== undefined && turn - since >= vc.diplomatic.turnsRequired
      })
      if (held.length >= vc.diplomatic.alliancesRequired) {
        winners.push({ faction: factionId, type: 'diplomatic' })
      }
    }
    // Simultaneous winners: highest score takes it, so faction order never decides
    winners.sort((a, b) => this.state.factions[b.faction].score - this.state.factions[a.faction].score)
    return winners[0] ?? null
  }
}
