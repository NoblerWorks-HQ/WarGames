import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { GameState, Unit, Order, FactionOrders, TurnResult, GameEvent, ChatMessage } from './types.js'
import { getFactionOrders, getNarrative } from './ai.js'

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

export class GameEngine {
  state: GameState
  turnHistory: TurnResult[] = []
  chatLog: ChatMessage[] = []
  recentEvents: GameEvent[] = []
  pendingAlliances: Set<string> = new Set()
  surpriseAttackBonus: Record<string, number> = {}
  running = false
  turnExecuting = false
  turnInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    const raw = readFileSync(resolve(__dirname, '../game/initial-world.json'), 'utf-8')
    this.state = JSON.parse(raw)
  }

  reset() {
    const raw = readFileSync(resolve(__dirname, '../game/initial-world.json'), 'utf-8')
    this.state = JSON.parse(raw)
    this.turnHistory = []
    this.chatLog = []
    this.pendingAlliances = new Set()
    this.surpriseAttackBonus = {}
    this.state.game.startedAt = new Date().toISOString()
    this.state.game.turn = 0
    this.state.game.status = 'active'
    this.state.game.victor = null
  }

  start(intervalMs: number = 10000) {
    console.log(`engine.start() called, running=${this.running}, intervalMs=${intervalMs}`)
    if (this.running) return
    this.reset()
    this.running = true
    this.turnExecuting = false
    this.addChat('command', 'gm', 'The Arbiter', 'WAR GAMES INITIATED. Three factions claim their territories across the globe...')

    console.log(`Setting up turn interval every ${intervalMs}ms...`)
    this.turnInterval = setInterval(async () => {
      console.log(`>>> setInterval fired! status=${this.state.game.status}, turnExecuting=${this.turnExecuting}`)
      if (this.state.game.status !== 'active') {
        this.stop()
        return
      }
      // Skip if previous turn is still executing
      if (this.turnExecuting) {
        console.log('Previous turn still executing, skipping...')
        return
      }
      this.turnExecuting = true
      try {
        await this.executeTurn()
      } catch (err) {
        console.error('Turn error:', err)
      } finally {
        this.turnExecuting = false
      }
    }, intervalMs)
  }

  stop() {
    this.running = false
    if (this.turnInterval) {
      clearInterval(this.turnInterval)
      this.turnInterval = null
    }
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
    const unitActions: Record<string, { location: string; canMoveTo: string[]; canAttack: string[] }> = {}
    for (const unit of faction.units) {
      const adj = this.state.map.adjacency[unit.territory] || []
      const canMoveTo: string[] = []
      const canAttack: string[] = []
      for (const tId of adj) {
        const t = this.state.map.territories[tId]
        if (!t) continue
        // Can attack if enemy units or mercenaries are there
        const hasEnemyUnits = Object.entries(this.state.factions).some(([fid, f]) =>
          fid !== factionId && f.units.some(u => u.territory === tId)
        )
        const hasMercs = (t.mercenaries || 0) > 0 && t.owner !== factionId
        if (hasEnemyUnits || hasMercs) {
          canAttack.push(tId)
        }
        // Can move to if no enemy units (or empty)
        if (!hasEnemyUnits) {
          canMoveTo.push(tId)
        }
      }
      unitActions[unit.id] = { location: unit.territory, canMoveTo, canAttack }
    }

    const turnsLeft = this.state.game.maxTurns - this.state.game.turn
    return JSON.stringify({
      turn: this.state.game.turn,
      maxTurns: this.state.game.maxTurns,
      turnsRemaining: turnsLeft,
      urgency: turnsLeft <= 5 ? 'CRITICAL - game ends soon, act decisively!' : turnsLeft <= 10 ? 'Time is running out - be aggressive!' : 'Play aggressively - this is a short game.',
      you: factionId,
      resources: faction.resources,
      tech: faction.tech,
      nukes: faction.nukes || 0,
      oathbreaker: faction.oathbreaker || false,
      units: faction.units,
      unitActions,
      territoryCount: faction.territoryCount,
      continentsControlled: continentControl,
      visibleMap: territoryStates,
      alliances: faction.alliances,
      victoryConditions: this.state.victoryConditions,
      recentEvents: this.turnHistory.slice(-3).flatMap(t => t.events.filter(e => e.faction === factionId || e.type === 'combat').map(e => e.description))
    })
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

    return Array.from(visible)
  }

  async executeTurn(): Promise<TurnResult> {
    this.state.game.turn++
    const turn = this.state.game.turn
    const events: GameEvent[] = []
    const allOrders: Record<string, FactionOrders> = {}

    console.log(`\n=== EXECUTING TURN ${turn} ===`)

    // Decrement surprise attack bonuses (they last 1 turn)
    for (const fid of Object.keys(this.surpriseAttackBonus)) {
      delete this.surpriseAttackBonus[fid]
    }

    this.addChat('command', 'gm', 'The Arbiter', `--- TURN ${turn} ---`)

    // Collect resources from owned territories
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      let foodCost = faction.units.length
      faction.resources.food -= foodCost
      if (faction.resources.food < 0) faction.resources.food = 0
      faction.resources.knowledge += 1

      // Territory resources
      for (const [tId, territory] of Object.entries(this.state.map.territories)) {
        if (territory.owner === factionId) {
          for (const [res, amount] of Object.entries(territory.resources)) {
            (faction.resources as Record<string, number>)[res] = ((faction.resources as Record<string, number>)[res] || 0) + amount
          }
        }
      }

      // Continent bonus
      for (const [contId, cont] of Object.entries(this.state.map.continents)) {
        if (cont.territories.every(t => this.state.map.territories[t]?.owner === factionId)) {
          for (const [res, amount] of Object.entries(cont.bonus)) {
            (faction.resources as Record<string, number>)[res] = ((faction.resources as Record<string, number>)[res] || 0) + amount
          }
        }
      }

      // Trade Networks (economic tech 1) - coastal territories produce +1 gold
      if (faction.tech.economic >= 1) {
        for (const [tId, territory] of Object.entries(this.state.map.territories)) {
          if (territory.owner === factionId && territory.terrain === 'coast') {
            faction.resources.gold += 1
          }
        }
      }

      // Central Banking (economic tech 2) - 10% interest on gold
      if (faction.tech.economic >= 2) {
        faction.resources.gold += Math.floor(faction.resources.gold * 0.1)
      }
    }

    // Get orders from each faction (parallel)
    console.log(`[turn ${turn}] Requesting orders from ${Object.keys(this.state.factions).length} factions...`)
    const orderPromises = Object.keys(this.state.factions).map(async (factionId) => {
      const briefing = this.buildBriefing(factionId)
      console.log(`[turn ${turn}] Calling getFactionOrders for ${factionId}...`)
      const orders = await getFactionOrders(factionId, personas[factionId], briefing)
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
    console.log(`[turn ${turn}] All faction orders received`)

    // Resolve orders
    for (const [factionId, factionOrders] of Object.entries(allOrders)) {
      for (const order of factionOrders.orders) {
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
      faction.score = (count * 3) + Math.floor(
        (faction.resources.gold + faction.resources.food + faction.resources.iron + faction.resources.influence + faction.resources.knowledge) / 5
      ) + ((faction.tech.military + faction.tech.economic + faction.tech.intelligence) * 2)
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
    const narrative = await getNarrative(
      `Turn ${turn}. Events: ${eventSummary}. ` +
      Object.entries(this.state.factions).map(([id, f]) => `${f.name}: ${f.territoryCount} territories, ${f.resources.gold}g`).join('. ')
    )
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

  private resolveOrder(factionId: string, order: Order): GameEvent | null {
    const faction = this.state.factions[factionId]
    const fName = faction.name

    switch (order.action) {
      case 'move': {
        // Accept to OR target field
        const moveTo = order.to || order.target
        // Find unit by exact ID or fuzzy match
        let unit = faction.units.find(u => u.id === order.unit)
        if (!unit && order.unit) {
          unit = faction.units.find(u => u.id.includes(order.unit!) || order.unit!.includes(u.id))
        }
        // If no unit found, pick one that can reach the destination
        if (!unit && moveTo) {
          unit = faction.units.find(u => {
            const adj = this.state.map.adjacency[u.territory]
            return adj?.includes(moveTo)
          })
        }
        if (!unit || !moveTo) return { type: 'invalid', faction: factionId, description: `${fName}: invalid move - no unit or destination` }
        const adj = this.state.map.adjacency[unit.territory]
        if (!adj?.includes(moveTo)) {
          // Try to find ANY unit that can reach
          const altUnit = faction.units.find(u => {
            const uAdj = this.state.map.adjacency[u.territory]
            return uAdj?.includes(moveTo)
          })
          if (altUnit) {
            unit = altUnit
          } else {
            return { type: 'invalid', faction: factionId, description: `${fName}: no units can reach ${moveTo}` }
          }
        }

        const oldTerritory = unit.territory
        unit.territory = moveTo

        const territory = this.state.map.territories[moveTo]
        if (territory && !territory.owner) {
          // Check for mercenary defenders
          if (territory.mercenaries && territory.mercenaries > 0) {
            const mercResult = this.resolveMercenaryCombat(factionId, unit, moveTo)
            return mercResult
          }
          territory.owner = factionId
          const tName = territory.name
          return { type: 'capture', faction: factionId, description: `${fName} captures neutral ${tName}`, from: oldTerritory, to: moveTo }
        } else if (territory && territory.owner && territory.owner !== factionId) {
          const defenders = this.getUnitsAtTerritory(moveTo).filter(u => u.owner !== factionId)
          if (defenders.length > 0) {
            return this.resolveCombat(factionId, unit, defenders[0].owner, defenders[0].unit, moveTo)
          } else {
            const prevOwner = territory.owner
            territory.owner = factionId
            const tName = territory.name
            return { type: 'capture', faction: factionId, description: `${fName} captures undefended ${tName}`, from: oldTerritory, to: moveTo }
          }
        }

        const tName = this.state.map.territories[moveTo]?.name || moveTo
        return { type: 'move', faction: factionId, description: `${fName} moves unit to ${tName}`, from: oldTerritory, to: moveTo }
      }

      case 'attack': {
        // Accept target OR to field (AI often confuses them)
        const attackTarget = order.target || order.to
        // Find unit by exact ID, or fuzzy match (AI sometimes drops prefix or uses wrong format)
        let unit = faction.units.find(u => u.id === order.unit)
        if (!unit && order.unit) {
          // Try partial match
          unit = faction.units.find(u => u.id.includes(order.unit!) || order.unit!.includes(u.id))
        }
        // If no unit specified or not found, pick closest unit that can reach the target
        if (!unit && attackTarget) {
          unit = faction.units.find(u => {
            const adj = this.state.map.adjacency[u.territory]
            return adj?.includes(attackTarget)
          })
        }
        if (!unit || !attackTarget) return { type: 'invalid', faction: factionId, description: `${fName}: invalid attack - no unit or target` }
        const attackFrom = unit.territory
        const adj = this.state.map.adjacency[unit.territory]
        if (!adj?.includes(attackTarget)) {
          // Try to find ANY unit that can reach the target
          const altUnit = faction.units.find(u => {
            const uAdj = this.state.map.adjacency[u.territory]
            return uAdj?.includes(attackTarget)
          })
          if (altUnit) {
            unit = altUnit
          } else {
            return { type: 'invalid', faction: factionId, description: `${fName}: no units adjacent to ${attackTarget}` }
          }
        }

        const defenders = this.getUnitsAtTerritory(attackTarget).filter(u => u.owner !== factionId)
        if (defenders.length === 0) {
          const territory = this.state.map.territories[attackTarget]
          // Check for mercenary defenders in neutral territory
          if (territory && !territory.owner && territory.mercenaries && territory.mercenaries > 0) {
            return this.resolveMercenaryCombat(factionId, unit, attackTarget)
          }
          unit.territory = attackTarget
          if (territory && territory.owner !== factionId) territory.owner = factionId
          const tName = territory?.name || attackTarget
          return { type: 'capture', faction: factionId, description: `${fName} takes undefended ${tName}`, from: attackFrom, to: attackTarget }
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

        const tId = order.territory || order.to || order.target || faction.units[0]?.territory
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: no territory for recruitment` }

        faction.resources.gold -= stats.cost.gold
        faction.resources.iron -= stats.cost.iron
        const newUnit = { id: `${factionId}-${unitType[0]}-${Date.now()}`, type: unitType as 'infantry' | 'armor' | 'artillery', territory: tId, hp: 2, xp: 0 }
        faction.units.push(newUnit)
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
        const cost = faction.tech.intelligence >= 1 ? 1 : 2
        if (faction.resources.influence < cost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough influence to spy` }
        faction.resources.influence -= cost
        return { type: 'spy', faction: factionId, description: `${fName} sends spies to ${order.target}`, to: order.target }
      }

      case 'trade': {
        if (!order.to || !order.offer) return { type: 'invalid', faction: factionId, description: `${fName}: invalid trade` }
        const target = this.state.factions[order.to]
        if (!target) return { type: 'invalid', faction: factionId, description: `${fName}: unknown trade target` }

        for (const [res, amount] of Object.entries(order.offer)) {
          const fRes = faction.resources as Record<string, number>
          if ((fRes[res] || 0) < (amount as number)) return { type: 'invalid', faction: factionId, description: `${fName}: can't afford trade` }
          fRes[res] -= amount as number;
          (target.resources as Record<string, number>)[res] = ((target.resources as Record<string, number>)[res] || 0) + (amount as number)
        }

        this.addChat('diplomacy', factionId, fName, `Sends ${JSON.stringify(order.offer)} to ${target.name}`)
        return { type: 'trade', faction: factionId, description: `${fName} trades ${JSON.stringify(order.offer)} to ${target.name}` }
      }

      case 'diplomacy': {
        if (!order.to || !order.proposal) return { type: 'invalid', faction: factionId, description: `${fName}: invalid diplomacy` }
        if (order.proposal === 'alliance') {
          const target = this.state.factions[order.to]
          if (!target) return { type: 'invalid', faction: factionId, description: `${fName}: unknown faction ${order.to}` }
          // Oathbreakers cannot form alliances
          if (faction.oathbreaker) return { type: 'invalid', faction: factionId, description: `${fName}: marked as Oathbreaker — no faction will accept your alliance` }
          if (target.oathbreaker) return { type: 'invalid', faction: factionId, description: `${fName}: ${target.name} is an Oathbreaker — alliance refused` }
          // Alliance requires mutual proposal — track pending proposals
          const pendingKey = `${factionId}->${order.to}`
          const reverseKey = `${order.to}->${factionId}`
          this.pendingAlliances.add(pendingKey)

          if (this.pendingAlliances.has(reverseKey)) {
            // Both sides have proposed — form the alliance
            if (!faction.alliances.includes(order.to)) faction.alliances.push(order.to)
            if (!target.alliances.includes(factionId)) target.alliances.push(factionId)
            this.pendingAlliances.delete(pendingKey)
            this.pendingAlliances.delete(reverseKey)
            this.addChat('diplomacy', factionId, fName, `Alliance formed with ${target.name}!`)
            return { type: 'diplomacy', faction: factionId, description: `${fName} and ${target.name} form an alliance!` }
          } else {
            this.addChat('diplomacy', factionId, fName, `Proposes alliance with ${target.name}`)
            return { type: 'diplomacy', faction: factionId, description: `${fName} proposes alliance with ${target.name}` }
          }
        }
        return { type: 'diplomacy', faction: factionId, description: `${fName} proposes ${order.proposal} with ${this.state.factions[order.to]?.name || order.to}` }
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

        faction.nukes--

        const tName = targetTerritory.name
        const targetOwner = targetTerritory.owner

        // Destroy ALL units in the territory
        for (const [fid, f] of Object.entries(this.state.factions)) {
          f.units = f.units.filter(u => u.territory !== targetTId)
        }

        // Remove fortification and set territory to irradiated (no owner, no resources for 5 turns)
        targetTerritory.fortified = false
        targetTerritory.owner = null
        const originalResources = { ...targetTerritory.resources }
        targetTerritory.resources = {}

        this.addChat('command', 'gm', 'The Arbiter', `NUCLEAR STRIKE: ${fName} launches a nuclear warhead at ${tName}! All units destroyed. Territory irradiated.`)
        this.addChat('diplomacy', factionId, fName, `We have unleashed nuclear fire upon ${tName}. Let this be a warning.`)

        // Second Strike retaliation check
        if (targetOwner && targetOwner !== factionId) {
          const defender = this.state.factions[targetOwner]
          if (defender && defender.tech.nuclear >= 3 && defender.nukes > 0) {
            // Auto-retaliate against a random attacker territory
            const attackerTerritories = Object.entries(this.state.map.territories)
              .filter(([_, t]) => t.owner === factionId)
            if (attackerTerritories.length > 0) {
              const [retaliationTId, retaliationTerritory] = attackerTerritories[Math.floor(Math.random() * attackerTerritories.length)]
              defender.nukes--
              // Destroy units in retaliation territory
              for (const [fid, f] of Object.entries(this.state.factions)) {
                f.units = f.units.filter(u => u.territory !== retaliationTId)
              }
              retaliationTerritory.fortified = false
              retaliationTerritory.owner = null
              retaliationTerritory.resources = {}
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
        }

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
        this.addChat('diplomacy', factionId, fName, msg)
        return { type: 'message', faction: factionId, description: `${fName} sends a diplomatic message` }
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
        const mercUnit = { id: `${factionId}-merc-${Date.now()}`, type: 'infantry' as const, territory: tId, hp: 2, xp: 0 }
        faction.units.push(mercUnit)

        // Claim the territory if neutral
        if (!territory.owner) territory.owner = factionId

        const tName = territory.name
        return { type: 'hire_mercenary', faction: factionId, description: `${fName} hires a mercenary at ${tName}`, to: tId }
      }

      default:
        return { type: 'invalid', faction: factionId, description: `${fName}: unknown action ${order.action}` }
    }
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

    const roll = Math.floor(Math.random() * 6) + 1 + (attackStrength - defendStrength)

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

    const roll = Math.floor(Math.random() * 6) + 1 + (attackStrength - mercDefense)

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
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      // Domination
      if (faction.territoryCount >= this.state.victoryConditions.domination.territoriesRequired) {
        return { faction: factionId, type: 'domination' }
      }
      // Economic
      let coastCount = 0
      for (const territory of Object.values(this.state.map.territories)) {
        if (territory.owner === factionId && territory.terrain === 'coast') coastCount++
      }
      if (faction.resources.gold >= this.state.victoryConditions.economic.goldRequired && coastCount >= this.state.victoryConditions.economic.coastTerritoriesRequired) {
        return { faction: factionId, type: 'economic' }
      }
      // Diplomatic (must hold alliances for minimum turns)
      if (faction.alliances.length >= this.state.victoryConditions.diplomatic.alliancesRequired &&
          this.state.game.turn >= this.state.victoryConditions.diplomatic.turnsRequired) {
        return { faction: factionId, type: 'diplomatic' }
      }
    }
    return null
  }
}
