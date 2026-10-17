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
  fallout?: { until: number; resources: Record<string, number> }
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
    seed?: number
    /** Starting position this game was set up from. */
    scenario?: string
    /** True when faction replies used native structured output (STRUCTURED_OUTPUT=1). */
    structuredOutput?: boolean
    /** Seat -> provider/model that played it, when known. */
    seats?: Record<string, SeatModel>
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
  control?: GameControl
  usage?: UsageSnapshot
}

export interface GameControl {
  running: boolean
  paused: boolean
  turnExecuting: boolean
  intervalMs: number
}

export interface RoleUsage {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  costComplete: boolean
}

export interface UsageSnapshot {
  roles: Record<string, RoleUsage>
  total: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; costComplete: boolean }
}

export interface TurnResult {
  turn: number
  timestamp: string
  orders: Record<string, { orders: { action: string; [k: string]: unknown }[]; reasoning?: string; notes?: string }>
  events: GameEvent[]
  narrative?: string
  frame?: TurnFrame
}

export interface ChatMessage {
  turn: number
  timestamp: string
  agent: string
  agentName: string
  channel: string
  message: string
}

export interface ScorecardRow {
  faction: string
  provider: string | null
  model: string | null
  rank: number
  won: boolean
  score: number
  territories: number
  orders: number
  invalid: number
  forfeits: number
  validRate: number | null
  betrayals: number
  nukesLaunched: number
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  costComplete: boolean
  avgLatencyMs: number | null
}

export interface Scorecard {
  seed?: number
  scenario?: string
  structuredOutput?: boolean
  turns: number
  status: 'active' | 'finished'
  victor: string | null
  rows: ScorecardRow[]
}

export interface SaveSummary {
  id: string
  savedAt: string
  seed: number
  turn: number
  maxTurns: number
  status: 'active' | 'finished'
  victor: string | null
  models: Record<string, string>
}

/** The board after a turn: just what changes, laid over the game's map to replay it. */
export interface TurnFrame {
  territories: Record<string, { owner: string | null; fortified: boolean; mercenaries: number; fallout?: boolean }>
  factions: Record<string, Pick<Faction, 'units' | 'score' | 'territoryCount' | 'resources' | 'tech' | 'nukes' | 'alliances' | 'oathbreaker'>>
}

/** Which provider and model played a seat. */
export interface SeatModel {
  provider: string
  model: string
}

/** A saved game as the server stores it (the parts the browser uses). */
export interface SavedFile {
  id: string
  savedAt: string
  state: GameState
  turnHistory: TurnResult[]
  chatLog: ChatMessage[]
  recentEvents: GameEvent[]
  usage: Record<string, RoleUsage>
  scorecard: Scorecard
}
