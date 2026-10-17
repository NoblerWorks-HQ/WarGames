/** Per-faction results of one game, with the provider and model that played each seat. */

import type { GameState, TurnResult } from './types.js'
import type { UsageSnapshot } from './usage.js'

export interface ScorecardRow {
  faction: string
  /** Null when no AI call was recorded for this seat (nothing has been played yet). */
  provider: string | null
  model: string | null
  /** 1 = first. Ties share a rank. */
  rank: number
  won: boolean
  score: number
  territories: number
  orders: number
  /** Orders the engine refused (unknown unit, unreachable target, unaffordable...). */
  invalid: number
  /** Turns the faction sent no usable orders. */
  forfeits: number
  /** 1 - invalid/orders; null before any orders. */
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
  status: GameState['game']['status']
  victor: string | null
  rows: ScorecardRow[]
}

export function buildScorecard(state: GameState, turnHistory: TurnResult[], usage: Pick<UsageSnapshot, 'roles'>): Scorecard {
  const rows: ScorecardRow[] = Object.entries(state.factions).map(([id, f]) => {
    let orders = 0
    let invalid = 0
    let forfeits = 0
    let betrayals = 0
    let nukesLaunched = 0
    for (const t of turnHistory) {
      orders += t.orders[id]?.orders.length ?? 0
      for (const e of t.events) {
        if (e.faction !== id) continue
        if (e.type === 'invalid') invalid++
        else if (e.type === 'forfeit') forfeits++
        else if (e.type === 'betrayal') betrayals++
        else if (e.type === 'nuke') nukesLaunched++
      }
    }
    const u = usage.roles[id]
    return {
      faction: id,
      provider: u?.provider ?? null,
      model: u?.model ?? null,
      rank: 0,
      won: state.game.status === 'finished' && state.game.victor === id,
      score: f.score,
      territories: f.territoryCount,
      orders,
      invalid,
      forfeits,
      validRate: orders > 0 ? Math.max(0, 1 - invalid / orders) : null,
      betrayals,
      nukesLaunched,
      calls: u?.calls ?? 0,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      costUsd: u?.costUsd ?? 0,
      costComplete: u?.costComplete ?? true,
      avgLatencyMs: u && u.calls ? Math.round(u.latencyMs / u.calls) : null,
    }
  })
  for (const r of rows) r.rank = 1 + rows.filter(o => o.score > r.score).length
  return { seed: state.game.seed, scenario: state.game.scenario, structuredOutput: state.game.structuredOutput, turns: state.game.turn, status: state.game.status, victor: state.game.victor, rows }
}
