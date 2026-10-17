/** npm run leaderboard: Elo for every model across all saved games; writes games/leaderboard.{md,json}. */
import 'dotenv/config'
import { writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { leaderboardFrom, leaderboardMarkdown } from './leaderboard.js'

const root = process.env.GAMES_DIR ? resolve(process.env.GAMES_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), '../games')
const lb = leaderboardFrom(root)
const md = leaderboardMarkdown(lb)
if (lb.gamesRated) {
  writeFileSync(resolve(root, 'leaderboard.md'), md)
  writeFileSync(resolve(root, 'leaderboard.json'), JSON.stringify(lb, null, 2))
}
console.log(md)
console.log(lb.gamesRated ? `Saved to ${root}/leaderboard.md and .json` : `No finished games with two or more models under ${root}.`)
