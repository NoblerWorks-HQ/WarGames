export interface Territory {
  name: string
  terrain: 'plains' | 'mountains' | 'coast'
  continent: string
  lat: number
  lng: number
  owner: string | null
  fortified: boolean
  resources: Record<string, number>
  mercenaries: number
}

export interface Unit {
  id: string
  type: 'infantry' | 'armor' | 'artillery'
  territory: string
  hp: number
  xp: number
}

export interface Faction {
  name: string
  agent: string
  resources: { gold: number; food: number; iron: number; influence: number; knowledge: number; uranium: number }
  units: Unit[]
  tech: { military: number; economic: number; intelligence: number; nuclear: number }
  nukes: number
  oathbreaker: boolean
  alliances: string[]
  pacts: string[]
  territoryCount: number
  score: number
}

export interface ContinentBonus {
  name: string
  bonus: Record<string, number>
  territories: string[]
}

export interface GameState {
  game: {
    name: string
    turn: number
    maxTurns: number
    status: 'active' | 'finished'
    startedAt: string | null
    victor: string | null
  }
  map: {
    territories: Record<string, Territory>
    adjacency: Record<string, string[]>
    continents: Record<string, ContinentBonus>
  }
  factions: Record<string, Faction>
  victoryConditions: {
    domination: { territoriesRequired: number }
    economic: { goldRequired: number; coastTerritoriesRequired: number }
    diplomatic: { alliancesRequired: number; turnsRequired: number }
  }
}

export interface Order {
  action: string
  unit?: string
  to?: string
  target?: string
  territory?: string
  type?: string
  cost?: Record<string, number>
  offer?: Record<string, number>
  request?: Record<string, number>
  tech?: string
  proposal?: string
  duration?: number
  message?: string
}

export interface FactionOrders {
  orders: Order[]
  reasoning?: string
}

export interface TurnResult {
  turn: number
  timestamp: string
  orders: Record<string, FactionOrders>
  events: GameEvent[]
  narrative?: string
}

export interface GameEvent {
  type: 'move' | 'attack' | 'fortify' | 'recruit' | 'trade' | 'spy' | 'research' | 'diplomacy' | 'combat' | 'capture' | 'victory' | 'forfeit' | 'invalid' | 'nuke' | 'build_nuke' | 'betrayal' | 'message' | 'hire_mercenary'
  faction: string
  description: string
  from?: string
  to?: string
  details?: Record<string, unknown>
}

export interface ChatMessage {
  turn: number
  timestamp: string
  agent: string
  agentName: string
  channel: 'command' | 'nato' | 'russia' | 'china' | 'diplomacy' | 'observer'
  message: string
}
