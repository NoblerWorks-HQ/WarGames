import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { GameEngine } from './engine.js'
import { clampInterval, isAllowedOrigin } from './http.js'
import { parseSeed } from './rng.js'

// Validate AI provider on startup
import { validateProviders, logProviderConfig } from './ai-provider.js'
try {
  logProviderConfig()
  await validateProviders()
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
const PORT = 3001
// Loopback only by default: every game spends the user's provider key.
// Set HOST=0.0.0.0 to expose it on the LAN deliberately.
const HOST = process.env.HOST || '127.0.0.1'

// Reject cross-site browser requests outright (a text/plain form POST skips the
// CORS preflight), then allow CORS only for the local UI.
app.use((req, res, next) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ error: 'origin not allowed' })
    return
  }
  next()
})
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }))
app.use(express.json())

// SEED=<number or any text> makes every game roll the same dice, so a game can be replayed.
const seed = parseSeed(process.env.SEED)
if (seed !== undefined) console.log(`Dice seeded with ${seed} (SEED=${process.env.SEED})`)
const engine = new GameEngine({ seed })

// Get current game state
app.get('/api/state', (_req, res) => {
  res.json({ ...engine.state, recentEvents: engine.recentEvents, control: engine.control(), usage: engine.usageSnapshot() })
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

// Start game
app.post('/api/start', (req, res) => {
  const intervalMs = clampInterval(req.body?.intervalMs)
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
app.post('/api/step', (_req, res) => {
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
app.post('/api/reset', (_req, res) => {
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
  console.log('  POST /api/stop   - Stop game')
  console.log('  POST /api/reset  - Reset game')
})
