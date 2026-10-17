/** Elo leaderboard over saved games. Games are built by hand: only seats, scores and the victor matter. */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rate, leaderboardFrom, leaderboardMarkdown, START_RATING, K } from './leaderboard.js'
import { SaveStore } from './saves.js'
import type { SavedGame } from './engine.js'

let n = 0
function game(seats: [string, string, string], scores: [number, number, number], victor: string | null, status: 'finished' | 'active' = 'finished'): SavedGame {
  const ids = ['nato', 'russia', 'china']
  n++
  return {
    version: 1,
    id: `g${n}`,
    savedAt: `2026-10-18T00:00:${String(n).padStart(2, '0')}Z`,
    state: {
      game: { name: '', turn: 20, maxTurns: 20, status, startedAt: null, victor, seats: Object.fromEntries(ids.map((id, i) => { const [provider, model] = seats[i].split('/'); return [id, { provider, model }] })) },
      map: { territories: {}, adjacency: {}, continents: {} },
      factions: Object.fromEntries(ids.map((id, i) => [id, { name: id, score: scores[i], territoryCount: 0, units: [] }])),
      victoryConditions: {},
    },
    turnHistory: [],
    chatLog: [],
    recentEvents: [],
    pendingAlliances: [],
    allianceSince: [],
    inbox: {},
    pendingIntel: {},
    intel: {},
    unitSerial: {},
    surpriseAttackBonus: {},
    notes: {},
    usage: {},
    seed: 1,
    rngState: null,
    intervalMs: 1000,
  } as unknown as SavedGame
}

const byModel = (lb: ReturnType<typeof rate>) => Object.fromEntries(lb.ratings.map(r => [r.model, r]))

describe('rate', () => {
  it('a win moves the winner up by the expected amount from equal ratings', () => {
    const lb = rate([game(['a/1', 'b/1', 'c/1'], [50, 40, 30], 'nato')])
    const r = byModel(lb)
    // Equal start: each pairing is worth K/2 * 0.5. a beats b and c; b beats c.
    expect(r['a/1'].rating).toBe(Math.round(START_RATING + K / 2))
    expect(r['b/1'].rating).toBe(START_RATING)
    expect(r['c/1'].rating).toBe(Math.round(START_RATING - K / 2))
    expect(r['a/1']).toMatchObject({ games: 1, wins: 1, losses: 0, pairWins: 2 })
    expect(r['b/1']).toMatchObject({ wins: 0, losses: 1, pairWins: 1, pairLosses: 1 })
    expect(lb.ratings.map(x => x.model)).toEqual(['a/1', 'b/1', 'c/1'])
  })

  it('the victor beats a higher-scoring seat (victory conditions can beat score)', () => {
    const r = byModel(rate([game(['a/1', 'b/1', 'c/1'], [10, 90, 30], 'nato')]))
    expect(r['a/1'].rating).toBeGreaterThan(r['b/1'].rating)
    expect(r['b/1'].rating).toBeGreaterThan(r['c/1'].rating)
  })

  it('a draw on equal scores leaves equal ratings unchanged', () => {
    const r = byModel(rate([game(['a/1', 'b/1', 'c/1'], [40, 40, 40], null)]))
    for (const m of ['a/1', 'b/1', 'c/1']) expect(r[m]).toMatchObject({ rating: START_RATING, draws: 1, pairDraws: 2 })
  })

  it('ratings are zero-sum and rotation-fair: three rotated games with one winning seat cancel out', () => {
    const games = [
      game(['a/1', 'b/1', 'c/1'], [50, 40, 30], 'nato'),
      game(['b/1', 'c/1', 'a/1'], [50, 40, 30], 'nato'),
      game(['c/1', 'a/1', 'b/1'], [50, 40, 30], 'nato'),
    ]
    const lb = rate(games)
    expect(lb.ratings.reduce((s, r) => s + r.rating, 0)).toBeCloseTo(3 * START_RATING, -1)
    const spread = Math.max(...lb.ratings.map(r => r.rating)) - Math.min(...lb.ratings.map(r => r.rating))
    expect(spread).toBeLessThan(5)
  })

  it('skips unfinished games and games with one model in every seat; self-play pairs are not rated', () => {
    const lb = rate([
      game(['a/1', 'a/1', 'a/1'], [50, 40, 30], 'nato'),
      game(['a/1', 'b/1', 'c/1'], [50, 40, 30], null, 'active'),
      game(['a/1', 'a/1', 'b/1'], [50, 40, 30], 'nato'),
    ])
    expect(lb).toMatchObject({ gamesRated: 1, gamesSkipped: 1 })
    const r = byModel(lb)
    expect(r['a/1']).toMatchObject({ games: 1, wins: 1, pairWins: 2, pairLosses: 0 })
    expect(r['b/1']).toMatchObject({ games: 1, losses: 1, pairLosses: 2 })
  })
})

describe('leaderboardFrom', () => {
  it('reads the games folder and every tournament in it, and renders a table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wargames-lb-'))
    try {
      new SaveStore(dir).save(game(['a/1', 'b/1', 'c/1'], [50, 40, 30], 'nato'))
      new SaveStore(join(dir, 'tournaments', 't1')).save(game(['b/1', 'c/1', 'a/1'], [50, 40, 30], 'nato'))
      const lb = leaderboardFrom(dir)
      expect(lb.gamesRated).toBe(2)
      expect(lb.sources).toEqual(['.', 'tournaments/t1'])
      const md = leaderboardMarkdown(lb)
      expect(md).toContain('| 1 | ')
      expect(md).toContain('2 finished games rated')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
