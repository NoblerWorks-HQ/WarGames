import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { GameEngine, listScenarios } from './engine.js'
import { clampInterval, isAllowedOrigin, isSameOrigin } from './http.js'
import { parseSeed } from './rng.js'
import { SaveStore } from './saves.js'
import { buildScorecard } from './scorecard.js'
import { renderRecap } from './recap.js'
import { leaderboardFrom } from './leaderboard.js'

// Validate AI provider on startup
import { validateProviders, logProviderConfig, structuredOutputEnabled, listVendors, parseProviderSpec, providerFor, seatFor, setRoleProviders } from './ai-provider.js'
import type { ProviderSpec } from './ai-provider.js'
// READ_ONLY=1: a public showcase of saved games. No API keys, no model calls, nothing a visitor
// can change: every non-GET request is refused, and the browser views games locally.
const READ_ONLY = /^(1|true|yes|on)$/i.test(process.env.READ_ONLY ?? '')
try {
  if (READ_ONLY) console.log('READ_ONLY: serving saved games only; providers are not used.')
  else {
    logProviderConfig()
    await validateProviders()
  }
} catch (err) {
  console.error(`\n${'='.repeat(60)}`)
  console.error('AI PROVIDER NOT CONFIGURED')
  console.error('='.repeat(60))
  console.error(err instanceof Error ? err.message : String(err))
  console.error('\nCopy .env.example to .env and add your API key.')
  console.error('See README.md for setup instructions.')
  console.error('='.repeat(60) + '\n')
  process.exit(1)
}

const app = express()
const PORT = Number(process.env.PORT) || 3001
// Loopback only by default: every game spends the user's provider key.
// Set HOST=0.0.0.0 to expose it on the LAN deliberately.
const HOST = process.env.HOST || '127.0.0.1'

// Reject cross-site browser requests outright (a text/plain form POST skips the
// CORS preflight), then allow CORS only for the local UI.
app.use((req, res, next) => {
  if (!isAllowedOrigin(req.headers.origin) && !(READ_ONLY && isSameOrigin(req.headers.origin, req.headers.host))) {
    res.status(403).json({ error: 'origin not allowed' })
    return
  }
  next()
})
// Cross-origin reads stay limited to the local UI; same-origin requests need no CORS headers.
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }))
app.use(express.json())
app.use((req, res, next) => {
  if (READ_ONLY && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(403).json({ error: 'this is a read-only demo' })
    return
  }
  next()
})

app.get('/api/config', (_req, res) => {
  res.json({ readOnly: READ_ONLY })
})

// SEED=<number or any text> makes every game roll the same dice, so a game can be replayed.
const seed = parseSeed(process.env.SEED)
if (seed !== undefined) console.log(`Dice seeded with ${seed} (SEED=${process.env.SEED})`)
// SCENARIO=mirror starts every faction level (see game/scenarios/); the default is the lopsided real-world map.
const scenario = process.env.SCENARIO?.trim() || 'default'
if (!listScenarios().includes(scenario)) {
  console.error(`Unknown SCENARIO "${scenario}". Available: ${listScenarios().join(', ')}`)
  process.exit(1)
}
const engine = new GameEngine({ seed, scenario, structuredOutput: structuredOutputEnabled() })

// Every finished turn is written to games/<id>.json, so a game can be reloaded, resumed or compared later.
const gamesDir = process.env.GAMES_DIR ? resolve(process.env.GAMES_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), '../games')
const saves = new SaveStore(gamesDir)
engine.onTurnComplete = () => saves.save(engine.snapshot())

// Get current game state
app.get('/api/state', (_req, res) => {
  res.json({ ...engine.state, recentEvents: engine.recentEvents, control: engine.control(), usage: engine.usageSnapshot() })
})

// Results so far for the current game: per-seat provider, score, valid-order rate, cost, latency
app.get('/api/scorecard', (_req, res) => {
  res.json(buildScorecard(engine.state, engine.turnHistory, engine.usageSnapshot()))
})

app.get('/api/scenarios', (_req, res) => {
  res.json({ scenarios: listScenarios(), current: engine.scenario })
})

// A self-contained HTML recap of the current game, or of a saved one (?id=...)
app.get('/api/recap', (req, res) => {
  const id = req.query.id
  let game
  try {
    game = typeof id === 'string' && id ? saves.load(id) : engine.snapshot()
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.type('html')
  if (req.query.download !== undefined) res.attachment(`wargames-${game.id || 'game'}.html`)
  // The page has no scripts; forbid them outright in case a browser ever finds one.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
  res.send(renderRecap(game))
})

// Elo per provider/model across every finished saved game, tournaments included
// Saved games never change in read-only mode, so the ratings are computed once.
let leaderboardCache: ReturnType<typeof leaderboardFrom> | null = null
app.get('/api/leaderboard', (_req, res) => {
  const lb = leaderboardCache ?? leaderboardFrom(gamesDir)
  if (READ_ONLY) leaderboardCache = lb
  res.json(lb)
})

// One saved game in full, for viewing it in the browser without loading it into the shared engine
app.get('/api/games/:id', (req, res) => {
  try {
    res.json(saves.load(req.params.id))
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Saved games, newest first
app.get('/api/games', (_req, res) => {
  res.json(saves.list())
})

// Load a saved game. An unfinished one comes back paused; Resume or Step carries on.
app.post('/api/load', (req, res) => {
  const id = req.body?.id
  if (typeof id !== 'string') {
    res.status(400).json({ error: 'id required' })
    return
  }
  try {
    engine.restore(saves.load(id))
    // Carry on with the models that played it; older saves fall back to the env configuration.
    const seats = engine.state.game.seats
    setRoleProviders(seats ? Object.fromEntries(Object.entries(seats).map(([seat, m]) => [seat, { provider: m.provider, model: m.model }])) : null)
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json({ status: 'loaded', id, ...engine.control() })
})

// Get chat log (index-based to avoid duplicates)
app.get('/api/chat', (req, res) => {
  const since = parseInt(req.query.since as string) || 0
  const messages = engine.chatLog.slice(since)
  res.json({ messages, total: engine.chatLog.length })
})

// Get turn history
app.get('/api/turns', (req, res) => {
  const since = parseInt(req.query.since as string) || 0
  const turns = since > 0
    ? engine.turnHistory.filter(t => t.turn > since)
    : engine.turnHistory
  res.json(turns)
})

const SEATS = ['nato', 'russia', 'china']

/**
 * Optional per-seat models from the browser: { nato: "anthropic:claude-opus-5", russia: "gemini", ... }.
 * A seat left out (or empty) uses the env configuration. Returns an error message, or null when applied.
 */
async function applySeats(raw: unknown): Promise<string | null> {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null)) return 'seats must be an object'
  const pins: Record<string, ProviderSpec> = {}
  for (const [seat, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (!SEATS.includes(seat)) return `unknown seat "${seat}"`
    if (value === '' || value === null || value === undefined) continue
    if (typeof value !== 'string' || value.length > 120) return `seat ${seat}: expected "provider" or "provider:model"`
    try {
      pins[seat] = parseProviderSpec(value)
      const p = providerFor(pins[seat])
      // A model typed in the browser is checked once, before any turn spends money on it.
      const check = await p.checkModel()
      if (check.status === 'bad-model' || check.status === 'bad-key') return `seat ${seat}: ${p.name} ${check.status === 'bad-key' ? 'rejected the API key' : `has no model "${p.model}"`}`
    } catch (err) {
      return `seat ${seat}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  setRoleProviders(pins)
  engine.seats = Object.fromEntries(SEATS.map(seat => [seat, seatFor(seat)]))
  return null
}

// Which vendors can play (key set) and what each seat uses now
app.get('/api/providers', (_req, res) => {
  res.json({ vendors: listVendors(), seats: Object.fromEntries(SEATS.map(seat => [seat, seatFor(seat)])) })
})

// Start game
app.post('/api/start', async (req, res) => {
  const intervalMs = clampInterval(req.body?.intervalMs)
  const requested = req.body?.scenario
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !listScenarios().includes(requested)) {
      res.status(400).json({ error: `unknown scenario; available: ${listScenarios().join(', ')}` })
      return
    }
    if (!engine.running) engine.scenario = requested
  }
  if (!engine.running) {
    const error = await applySeats(req.body?.seats)
    if (error) {
      res.status(400).json({ error })
      return
    }
  }
  console.log(`\n>>> /api/start called with intervalMs=${intervalMs}`)
  engine.start(intervalMs)
  console.log(`>>> Game started, running=${engine.running}`)
  res.json({ status: 'started', intervalMs })
})

// Pause between turns (a turn already in flight still finishes)
app.post('/api/pause', (_req, res) => {
  engine.pause()
  res.json({ status: 'paused', ...engine.control() })
})

// Resume a paused game: the next turn starts immediately
app.post('/api/resume', (_req, res) => {
  engine.resume()
  res.json({ status: 'resumed', ...engine.control() })
})

// Play exactly one turn, then stay paused. Starts a new game if none is running.
app.post('/api/step', async (req, res) => {
  if (!engine.running && !engine.turnExecuting) {
    const error = await applySeats(req.body?.seats)
    if (error) {
      res.status(400).json({ error })
      return
    }
  }
  if (!engine.step()) {
    res.status(409).json({ error: 'a turn is already in progress' })
    return
  }
  res.json({ status: 'stepping', ...engine.control() })
})

// Change the turn speed; takes effect immediately
app.post('/api/interval', (req, res) => {
  engine.setIntervalMs(clampInterval(req.body?.intervalMs))
  res.json({ status: 'ok', ...engine.control() })
})

// Stop game
app.post('/api/stop', (_req, res) => {
  engine.stop()
  res.json({ status: 'stopped' })
})

// Reset game
app.post('/api/reset', (req, res) => {
  const requested = req.body?.scenario
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !listScenarios().includes(requested)) {
      res.status(400).json({ error: `unknown scenario; available: ${listScenarios().join(', ')}` })
      return
    }
    engine.scenario = requested
  }
  engine.stop()
  engine.reset()
  res.json({ status: 'reset' })
})

// Production: serve the built client (npm run build) from the same origin.
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
if (existsSync(resolve(distDir, 'index.html'))) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: distDir }))
}

app.listen(PORT, HOST, () => {
  console.log(`War Games server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  console.log('Endpoints:')
  console.log('  GET  /api/state  - Current game state')
  console.log('  GET  /api/chat   - Chat log')
  console.log('  GET  /api/turns  - Turn history')
  console.log('  POST /api/start  - Start game')
  console.log('  POST /api/pause  - Pause between turns')
  console.log('  POST /api/resume - Resume a paused game')
  console.log('  POST /api/step   - Play one turn, then pause')
  console.log('  POST /api/interval - Change turn speed')
  console.log('  GET  /api/providers - Vendors and seat models')
  console.log('  GET  /api/games  - Saved games')
  console.log('  GET  /api/recap  - Shareable HTML recap')
  console.log('  GET  /api/leaderboard - Elo per model')
  console.log('  POST /api/load   - Load a saved game')
  console.log('  GET  /api/scorecard - Per-seat results')
  console.log('  POST /api/stop   - Stop game')
  console.log('  POST /api/reset  - Reset game')
})
