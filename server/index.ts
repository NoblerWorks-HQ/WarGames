import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { GameEngine } from './engine.js'

// Validate AI provider on startup
import { validateProvider, logProviderConfig } from './ai-provider.js'
try {
  validateProvider()
  logProviderConfig()
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

app.use(cors())
app.use(express.json())

const engine = new GameEngine()

// Get current game state
app.get('/api/state', (_req, res) => {
  res.json({ ...engine.state, recentEvents: engine.recentEvents })
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
  const intervalMs = req.body?.intervalMs || 10000
  console.log(`\n>>> /api/start called with intervalMs=${intervalMs}`)
  engine.start(intervalMs)
  console.log(`>>> Game started, running=${engine.running}`)
  res.json({ status: 'started', intervalMs })
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

app.listen(PORT, () => {
  console.log(`War Games server running on http://localhost:${PORT}`)
  console.log('Endpoints:')
  console.log('  GET  /api/state  - Current game state')
  console.log('  GET  /api/chat   - Chat log')
  console.log('  GET  /api/turns  - Turn history')
  console.log('  POST /api/start  - Start game')
  console.log('  POST /api/stop   - Stop game')
  console.log('  POST /api/reset  - Reset game')
})
