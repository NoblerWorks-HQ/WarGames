/** Saved games on disk: one JSON file per game in games/, rewritten after every turn. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { SavedGame } from './engine.js'
import { buildScorecard } from './scorecard.js'
import type { Scorecard } from './scorecard.js'

/** Ids become file names, so allow nothing that could climb out of the folder. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface SaveSummary {
  id: string
  savedAt: string
  seed: number
  turn: number
  maxTurns: number
  status: 'active' | 'finished'
  victor: string | null
  /** Faction -> "provider/model", for the load list. */
  models: Record<string, string>
}

export interface SavedFile extends SavedGame {
  /** Results so far; recomputed on every save so finished games can be compared without replaying. */
  scorecard: Scorecard
}

export class SaveStore {
  constructor(private dir: string) {}

  save(game: SavedGame): void {
    if (!SAFE_ID.test(game.id)) throw new Error(`Refusing to save a game with id "${game.id}"`)
    mkdirSync(this.dir, { recursive: true })
    const file: SavedFile = {
      ...game,
      scorecard: buildScorecard(game.state, game.turnHistory, { roles: game.usage }),
    }
    // Write beside the target, then rename, so a crash never leaves half a save.
    const target = resolve(this.dir, `${game.id}.json`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, target)
  }

  load(id: string): SavedGame {
    if (!SAFE_ID.test(id)) throw new Error('Invalid game id')
    const path = resolve(this.dir, `${id}.json`)
    if (!existsSync(path)) throw new Error(`No saved game "${id}"`)
    const data = JSON.parse(readFileSync(path, 'utf-8')) as SavedFile
    if (data.version !== 1 || !data.state || !Array.isArray(data.turnHistory)) throw new Error(`"${id}" is not a valid save`)
    return data
  }

  /** Newest first. Unreadable files are skipped rather than breaking the list. */
  list(): SaveSummary[] {
    if (!existsSync(this.dir)) return []
    const out: SaveSummary[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const d = this.load(name.slice(0, -5))
        out.push({
          id: d.id,
          savedAt: d.savedAt,
          seed: d.seed,
          turn: d.state.game.turn,
          maxTurns: d.state.game.maxTurns,
          status: d.state.game.status,
          victor: d.state.game.victor,
          models: Object.fromEntries(Object.entries(d.usage).filter(([r]) => r !== 'narrator').map(([r, u]) => [r, `${u.provider}/${u.model}`])),
        })
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }
}
