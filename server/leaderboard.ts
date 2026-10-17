/**
 * Elo ratings for every provider/model that has played, from all finished saved games
 * (normal play and tournaments). A three-way game counts as three head-to-head results:
 * the winner beats both other seats, the other two are ordered by final score, and an
 * exact tie is a draw. Games are applied oldest first.
 */

import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import type { SavedGame } from './engine.js'
import { SaveStore } from './saves.js'
import { buildScorecard } from './scorecard.js'

export const START_RATING = 1500
/** Per game. Split across the two pairings each seat is in, so one game moves a rating by at most K. */
export const K = 32

export interface Rating {
  model: string
  rating: number
  games: number
  wins: number
  draws: number
  losses: number
  /** Head-to-head pairings won / drawn / lost (two per game). */
  pairWins: number
  pairDraws: number
  pairLosses: number
}

export interface Leaderboard {
  ratings: Rating[]
  /** Finished games rated; games with fewer than two distinct models are skipped. */
  gamesRated: number
  gamesSkipped: number
  /** Which game sets were read, e.g. ".", "tournaments/t1". */
  sources: string[]
}

/** Seat -> "provider/model", from the recorded seats or (older saves) from usage. */
function seatModels(g: SavedGame): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const seat of Object.keys(g.state.factions)) {
    const s = g.state.game.seats?.[seat]
    const u = g.usage[seat]
    const m = s ? `${s.provider}/${s.model}` : u ? `${u.provider}/${u.model}` : null
    if (!m) return null
    out[seat] = m
  }
  return out
}

export function rate(games: SavedGame[]): Leaderboard {
  const table = new Map<string, Rating>()
  const get = (model: string) => {
    let r = table.get(model)
    if (!r) table.set(model, (r = { model, rating: START_RATING, games: 0, wins: 0, draws: 0, losses: 0, pairWins: 0, pairDraws: 0, pairLosses: 0 }))
    return r
  }
  let rated = 0
  let skipped = 0
  const finished = games.filter(g => g.state.game.status === 'finished').sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  for (const g of finished) {
    const seats = seatModels(g)
    if (!seats || new Set(Object.values(seats)).size < 2) {
      skipped++
      continue
    }
    rated++
    const card = buildScorecard(g.state, g.turnHistory, { roles: g.usage })
    const victor = g.state.game.victor
    // Lower is better. A victory condition can be won without the top score, so the victor is always first.
    const place = Object.fromEntries(card.rows.map(r => [r.faction, r.faction === victor ? -Infinity : -r.score]))
    const ids = Object.keys(seats)
    const delta: Record<string, number> = {}
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]]
        if (seats[a] === seats[b]) continue // a model never plays itself for rating
        const ra = get(seats[a])
        const rb = get(seats[b])
        const expected = 1 / (1 + 10 ** ((rb.rating - ra.rating) / 400))
        const actual = place[a] < place[b] ? 1 : place[a] > place[b] ? 0 : 0.5
        const k = K / (ids.length - 1)
        delta[seats[a]] = (delta[seats[a]] ?? 0) + k * (actual - expected)
        delta[seats[b]] = (delta[seats[b]] ?? 0) - k * (actual - expected)
        const tally = (r: typeof ra, s: number) => (s === 1 ? r.pairWins++ : s === 0 ? r.pairLosses++ : r.pairDraws++)
        tally(ra, actual)
        tally(rb, 1 - actual)
      }
    }
    // Ratings move together after the game, so seat order inside a game doesn't matter.
    for (const [model, d] of Object.entries(delta)) get(model).rating += d
    // Once per model per game, even if it filled two seats
    for (const model of new Set(Object.values(seats))) {
      const r = get(model)
      r.games++
      if (victor === null) r.draws++
      else if (seats[victor] === model) r.wins++
      else r.losses++
    }
  }
  const ratings = [...table.values()].map(r => ({ ...r, rating: Math.round(r.rating) })).sort((a, b) => b.rating - a.rating)
  return { ratings, gamesRated: rated, gamesSkipped: skipped, sources: [] }
}

/** Every save under the games folder: the folder itself and each tournament in it. */
export function loadAllGames(root: string): { games: SavedGame[]; sources: string[] } {
  const dirs: { dir: string; name: string }[] = [{ dir: root, name: '.' }]
  const tdir = resolve(root, 'tournaments')
  if (existsSync(tdir)) {
    for (const d of readdirSync(tdir, { withFileTypes: true })) if (d.isDirectory()) dirs.push({ dir: resolve(tdir, d.name), name: `tournaments/${d.name}` })
  }
  const games: SavedGame[] = []
  const sources: string[] = []
  for (const { dir, name } of dirs) {
    const store = new SaveStore(dir)
    const ids = store.list().map(s => s.id)
    if (ids.length) sources.push(name)
    for (const id of ids) games.push(store.load(id))
  }
  return { games, sources }
}

export function leaderboardFrom(root: string): Leaderboard {
  const { games, sources } = loadAllGames(root)
  return { ...rate(games), sources }
}

export function leaderboardMarkdown(lb: Leaderboard): string {
  return [
    '# War Games leaderboard',
    '',
    `${lb.gamesRated} finished games rated${lb.gamesSkipped ? `, ${lb.gamesSkipped} skipped (one model in every seat)` : ''}. Elo from ${START_RATING}, K=${K} per game; the winner beats both other seats, the rest are ordered by score.`,
    'Ratings from a handful of games mean little: look at the game count before the number.',
    '',
    '| # | Model | Elo | Games | W | D | L | Head-to-head W-D-L |',
    '|---|---|---|---|---|---|---|---|',
    ...lb.ratings.map((r, i) => `| ${i + 1} | ${r.model} | ${r.rating} | ${r.games} | ${r.wins} | ${r.draws} | ${r.losses} | ${r.pairWins}-${r.pairDraws}-${r.pairLosses} |`),
    '',
  ].join('\n')
}
