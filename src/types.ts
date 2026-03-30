// Re-export server types for frontend use (keep in sync)
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

export interface GameEvent {
  type: string
  faction: string
  description: string
  from?: string
  to?: string
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
  recentEvents?: GameEvent[]
}

export interface ChatMessage {
  turn: number
  timestamp: string
  agent: string
  agentName: string
  channel: string
  message: string
}
