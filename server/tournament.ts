/**
 * Tournament mode: play many games with the same models rotated through every seat, then
 * aggregate the scorecards per model. Rotation matters because the seats are not equal:
 * on the default map NATO starts far ahead, and even the mirror map's terrain differs.
 *
 * Within a round every game uses the same dice seed, so each model faces the same luck in
 * each seat. Games are saved as they go; re-running with the same id resumes.
 */

import type { GameEngine } from './engine.js'
import type { ProviderSpec } from './ai-provider.js'
import { parseSeed } from './rng.js'
import { buildScorecard } from './scorecard.js'
import type { Scorecard } from './scorecard.js'
import type { SaveStore } from './saves.js'

export const SEATS = ['nato', 'russia', 'china'] as const

export interface Entrant {
  /** Unique display name, e.g. "anthropic/claude-sonnet-5" (with "#2" for a repeated entry). */
  label: string
  spec: ProviderSpec
}

export interface ScheduledGame {
  id: string
  round: number
  scenario: string
  /** Rotation index: 0..2, which shift of the lineup sits in which seat. */
  rotation: number
  seed: number
  /** Seat -> entrant label. */
  seats: Record<string, string>
}

export interface TournamentConfig {
  id: string
  entrants: Entrant[]
  scenarios: string[]
  rounds: number
  /** Overrides the scenario's turn limit (20) for cheaper runs. */
  maxTurns?: number
  /** Stop starting new turns once the estimated spend reaches this (USD). */
  budgetUsd: number
  narrate: boolean
  structuredOutput: boolean
}

export interface GameRecord {
  game: ScheduledGame
  scorecard: Scorecard
  finished: boolean
}

export interface EntrantStats {
  label: string
  /** Finished games only; unfinished ones are counted in `incomplete`. */
  games: number
  wins: number
  /** Finished games that ended in a draw (exact score tie). */
  draws: number
  winRate: number | null
  avgScore: number | null
  avgRank: number | null
  orders: number
  invalid: number
  validRate: number | null
  forfeits: number
  betrayals: number
  nukesLaunched: number
  costUsd: number
  costComplete: boolean
  avgLatencyMs: number | null
  byScenario: Record<string, { games: number; wins: number; avgScore: number | null }>
  bySeat: Record<string, { games: number; wins: number }>
}

export interface TournamentResults {
  id: string
  config: Omit<TournamentConfig, 'entrants'> & { entrants: { label: string; provider: string; model?: string }[] }
  scheduled: number
  finished: number
  incomplete: number
  /** True when the budget ran out before every game finished. */
  stoppedForBudget: boolean
  costUsd: number
  /** Win rate by seat regardless of who sat there: how much the seat itself is worth. */
  seatWinRate: Record<string, number | null>
  entrants: EntrantStats[]
  games: { id: string; scenario: string; round: number; seed: number; seats: Record<string, string>; finished: boolean; turns: number; victor: string | null; winner: string | null }[]
}

/** Labels for a lineup, numbering repeats so self-play keeps the two copies apart. */
export function makeEntrants(specs: ProviderSpec[], defaultModel: (s: ProviderSpec) => string): Entrant[] {
  const seen: Record<string, number> = {}
  return specs.map(spec => {
    const base = `${spec.provider}/${spec.model ?? defaultModel(spec)}`
    seen[base] = (seen[base] ?? 0) + 1
    return { label: seen[base] > 1 ? `${base}#${seen[base]}` : base, spec }
  })
}

/** Every round x scenario x rotation. Each entrant sits in each seat once per round and scenario. */
export function schedule(cfg: Pick<TournamentConfig, 'id' | 'entrants' | 'scenarios' | 'rounds'>): ScheduledGame[] {
  if (cfg.entrants.length !== SEATS.length) throw new Error(`A lineup needs exactly ${SEATS.length} entrants (one per seat); got ${cfg.entrants.length}`)
  const games: ScheduledGame[] = []
  for (let round = 1; round <= cfg.rounds; round++) {
    const seed = parseSeed(`${cfg.id}-round-${round}`)!
    for (const scenario of cfg.scenarios) {
      for (let rotation = 0; rotation < SEATS.length; rotation++) {
        const seats = Object.fromEntries(SEATS.map((seat, i) => [seat, cfg.entrants[(i + rotation) % SEATS.length].label]))
        games.push({ id: `${cfg.id}-r${round}-${scenario}-g${rotation + 1}`, round, scenario, rotation, seed, seats })
      }
    }
  }
  return games
}

export interface RunDeps {
  makeEngine(game: ScheduledGame): GameEngine
  store: SaveStore
  /** Point each seat at its entrant's provider before a game's turns run. */
  pinSeats(pins: Record<string, ProviderSpec>): void
  log?(line: string): void
}

/** Play (or resume) every scheduled game until done or out of budget. */
export async function runTournament(cfg: TournamentConfig, deps: RunDeps): Promise<TournamentResults> {
  const log = deps.log ?? (() => {})
  const games = schedule(cfg)
  const byLabel = Object.fromEntries(cfg.entrants.map(e => [e.label, e.spec]))
  const records: GameRecord[] = []
  let spent = 0
  let stoppedForBudget = false

  for (const game of games) {
    const engine = deps.makeEngine(game)
    let saved = null
    try {
      saved = deps.store.load(game.id)
    } catch {
      /* not started yet */
    }
    if (saved) {
      engine.restore(saved)
      engine.stop()
    } else {
      engine.reset()
      engine.gameId = game.id
      if (cfg.maxTurns) engine.state.game.maxTurns = cfg.maxTurns
    }
    spent += engine.usageSnapshot().total.costUsd

    if (engine.state.game.status === 'active' && !stoppedForBudget) {
      deps.pinSeats(Object.fromEntries(Object.entries(game.seats).map(([seat, label]) => [seat, byLabel[label]])))
      log(`${game.id}: ${Object.entries(game.seats).map(([s, l]) => `${s}=${l}`).join(' ')}${saved ? ` (resuming at turn ${engine.state.game.turn})` : ''}`)
      while (engine.state.game.status === 'active') {
        if (spent >= cfg.budgetUsd) {
          stoppedForBudget = true
          log(`Budget of $${cfg.budgetUsd} reached ($${spent.toFixed(4)} spent): stopping. Re-run with the same --id and a higher --budget to resume.`)
          break
        }
        const before = engine.usageSnapshot().total.costUsd
        await engine.executeTurn()
        deps.store.save(engine.snapshot())
        spent += engine.usageSnapshot().total.costUsd - before
      }
    }

    const scorecard = buildScorecard(engine.state, engine.turnHistory, engine.usageSnapshot())
    const finished = engine.state.game.status === 'finished'
    if (finished) {
      const winner = scorecard.victor ? game.seats[scorecard.victor] : null
      log(`${game.id}: ${winner ? `${winner} (${scorecard.victor}) wins` : 'draw'} on turn ${scorecard.turns}`)
    }
    records.push({ game, scorecard, finished })
  }

  return summarize(cfg, records, spent, stoppedForBudget)
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function summarize(cfg: TournamentConfig, records: GameRecord[], spent: number, stoppedForBudget: boolean): TournamentResults {
  const done = records.filter(r => r.finished)
  const entrants: EntrantStats[] = cfg.entrants.map(({ label }) => {
    const rows = records.flatMap(r =>
      Object.entries(r.game.seats)
        .filter(([, l]) => l === label)
        .map(([seat]) => ({ seat, rec: r, row: r.scorecard.rows.find(x => x.faction === seat)! }))
    )
    const fin = rows.filter(x => x.rec.finished)
    const orders = rows.reduce((n, x) => n + x.row.orders, 0)
    const invalid = rows.reduce((n, x) => n + x.row.invalid, 0)
    const calls = rows.reduce((n, x) => n + x.row.calls, 0)
    const latency = rows.reduce((n, x) => n + (x.row.avgLatencyMs ?? 0) * x.row.calls, 0)
    const byScenario: EntrantStats['byScenario'] = {}
    for (const sc of cfg.scenarios) {
      const s = fin.filter(x => x.rec.game.scenario === sc)
      byScenario[sc] = { games: s.length, wins: s.filter(x => x.row.won).length, avgScore: mean(s.map(x => x.row.score)) }
    }
    const bySeat: EntrantStats['bySeat'] = {}
    for (const seat of SEATS) {
      const s = fin.filter(x => x.seat === seat)
      bySeat[seat] = { games: s.length, wins: s.filter(x => x.row.won).length }
    }
    const wins = fin.filter(x => x.row.won).length
    return {
      label,
      games: fin.length,
      wins,
      draws: fin.filter(x => x.rec.scorecard.victor === null).length,
      winRate: fin.length ? wins / fin.length : null,
      avgScore: mean(fin.map(x => x.row.score)),
      avgRank: mean(fin.map(x => x.row.rank)),
      orders,
      invalid,
      validRate: orders ? Math.max(0, 1 - invalid / orders) : null,
      forfeits: rows.reduce((n, x) => n + x.row.forfeits, 0),
      betrayals: rows.reduce((n, x) => n + x.row.betrayals, 0),
      nukesLaunched: rows.reduce((n, x) => n + x.row.nukesLaunched, 0),
      costUsd: rows.reduce((n, x) => n + x.row.costUsd, 0),
      costComplete: rows.every(x => x.row.costComplete),
      avgLatencyMs: calls ? Math.round(latency / calls) : null,
      byScenario,
      bySeat,
    }
  })
  const seatWinRate = Object.fromEntries(
    SEATS.map(seat => [seat, done.length ? done.filter(r => r.scorecard.victor === seat).length / done.length : null])
  )
  return {
    id: cfg.id,
    config: { ...cfg, entrants: cfg.entrants.map(e => ({ label: e.label, ...e.spec })) },
    scheduled: records.length,
    finished: done.length,
    incomplete: records.length - done.length,
    stoppedForBudget,
    costUsd: spent,
    seatWinRate,
    entrants: [...entrants].sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || (b.avgScore ?? -1) - (a.avgScore ?? -1)),
    games: records.map(r => ({
      id: r.game.id,
      scenario: r.game.scenario,
      round: r.game.round,
      seed: r.game.seed,
      seats: r.game.seats,
      finished: r.finished,
      turns: r.scorecard.turns,
      victor: r.finished ? r.scorecard.victor : null,
      winner: r.finished && r.scorecard.victor ? r.game.seats[r.scorecard.victor] : null,
    })),
  }
}

const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`)
const num = (x: number | null, d = 1) => (x === null ? '-' : x.toFixed(d))
const usd = (x: number, complete: boolean) => `${complete ? '' : '>='}$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`

/** A results page for humans; results.json holds the same data. */
export function resultsMarkdown(r: TournamentResults): string {
  const c = r.config
  const lines = [
    `# Tournament ${r.id}`,
    '',
    `${r.finished} of ${r.scheduled} games finished${r.stoppedForBudget ? ' (stopped at the budget; re-run with the same --id to resume)' : ''}. ` +
      `Scenarios: ${c.scenarios.join(', ')}. Rounds: ${c.rounds}. Turn limit: ${c.maxTurns ?? 'scenario default'}. ` +
      `Structured output: ${c.structuredOutput ? 'on' : 'off'}. Narrator: ${c.narrate ? 'on' : 'off'}. Estimated spend: $${r.costUsd.toFixed(4)}.`,
    '',
    'Each model played every seat equally often, with the same dice per round. Small samples are noisy: treat a gap of one or two wins as a tie.',
    '',
    '| Model | Games | Wins | Draws | Win rate | Avg score | Avg rank | Valid orders | Forfeits | Betrayals | Nukes | Avg latency | Cost |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.entrants.map(e =>
      `| ${e.label} | ${e.games} | ${e.wins} | ${e.draws} | ${pct(e.winRate)} | ${num(e.avgScore)} | ${num(e.avgRank, 2)} | ${pct(e.validRate)} (${e.invalid}/${e.orders} bad) | ${e.forfeits} | ${e.betrayals} | ${e.nukesLaunched} | ${e.avgLatencyMs === null ? '-' : `${(e.avgLatencyMs / 1000).toFixed(1)}s`} | ${usd(e.costUsd, e.costComplete)} |`
    ),
    '',
    '## By scenario (wins / games)',
    '',
    `| Model | ${c.scenarios.join(' | ')} |`,
    `|---|${c.scenarios.map(() => '---').join('|')}|`,
    ...r.entrants.map(e => `| ${e.label} | ${c.scenarios.map(s => `${e.byScenario[s].wins}/${e.byScenario[s].games}`).join(' | ')} |`),
    '',
    '## By seat (wins / games)',
    '',
    `| Model | ${SEATS.join(' | ')} |`,
    `|---|${SEATS.map(() => '---').join('|')}|`,
    ...r.entrants.map(e => `| ${e.label} | ${SEATS.map(s => `${e.bySeat[s].wins}/${e.bySeat[s].games}`).join(' | ')} |`),
    `| _any model_ | ${SEATS.map(s => pct(r.seatWinRate[s])).join(' | ')} |`,
    '',
    '## Games',
    '',
    '| Game | Seed | NATO | Russia | China | Turns | Winner |',
    '|---|---|---|---|---|---|---|',
    ...r.games.map(g => `| ${g.id} | ${g.seed} | ${g.seats.nato} | ${g.seats.russia} | ${g.seats.china} | ${g.turns} | ${g.finished ? (g.winner ? `${g.winner} (${g.victor})` : 'draw') : '_unfinished_'} |`),
    '',
  ]
  return lines.join('\n')
}
