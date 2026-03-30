# War Games - AI Strategy Simulation

## Overview

Turn-based military/geopolitical strategy game where AI agents command 3 great powers.
NATO, Russia, and China compete on a Leaflet flat map for territory, resources, and dominance.
Realistic starting positions reflect real-world geopolitics: NATO controls the transatlantic (NA + W. Europe), Russia holds Eurasia, China dominates the Indo-Pacific.

## Architecture

- **Frontend**: Vite + TypeScript + Leaflet map with territory overlays, combat effects, and game summary
- **Backend**: Express server (port 3001) with game engine and AI provider abstraction
- **AI**: Direct API calls to Gemini, OpenAI, or Anthropic (no agent framework - just raw API)
- **State**: In-memory game state, turn history stored per-game
- **Dev**: `npm run dev` runs both client (Vite) and server (tsx watch) via concurrently

## AI Provider System

Multi-provider abstraction in `server/ai-provider.ts` with a unified `AIProvider` interface:

```
interface AIProvider {
  name: string
  generate(prompt: string): Promise<string>
}
```

### Supported Providers

| Provider | Default Model | Env Var (key) | Env Var (model override) |
|----------|--------------|---------------|--------------------------|
| **Gemini** (default) | `gemini-2.5-flash` | `GEMINI_API_KEY` | `GEMINI_MODEL` |
| **OpenAI** | `gpt-4o-mini` | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| **Anthropic** | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |

Select global default via `AI_PROVIDER` env var (defaults to `gemini`). OpenAI also supports `OPENAI_BASE_URL` override.

### Per-Faction Provider Overrides

Each faction (and the narrator) can use a different AI provider:
- `NATO_AI_PROVIDER` - override for NATO
- `RUSSIA_AI_PROVIDER` - override for Russia
- `CHINA_AI_PROVIDER` - override for China
- `NARRATOR_AI_PROVIDER` - override for the narrator

Falls back to `AI_PROVIDER` if no per-faction override is set. Providers are cached by name so the same provider isn't instantiated twice.

### API Key Handling

All keys loaded from `.env` via `dotenv`. No keys are hardcoded. You need an API key for each provider you use (if all factions use Gemini, you only need `GEMINI_API_KEY`). Each provider validates its key on first use and throws if missing.

## Game Engine

`server/engine.ts` runs the turn loop:

1. Build a briefing for each faction (visible territories, resources, units, valid actions)
2. Call `getFactionOrders()` in parallel for all 3 factions (from `server/ai.ts`)
3. Parse JSON responses, resolve orders (movement, combat, research, diplomacy, nukes, etc.)
4. Call `getNarrative()` for a dramatic news-style recap
5. Store turn history, broadcast state to clients via polling

### AI Calls

- **`getFactionOrders(factionId, persona, briefing)`** - each faction gets its persona (`game/factions/*.md`) + game state, returns JSON orders
- **`getNarrative(eventSummary)`** - generates CNN-style breaking news recap
- All calls have 15-second timeouts
- Max 3 orders per faction per turn
- Temperature: 0.7, thinking disabled for Gemini to save tokens

## Factions

| Faction | Persona File | Leader |
|---------|-------------|--------|
| NATO | `game/factions/nato.md` | President Trump |
| Russia | `game/factions/russia.md` | President Putin |
| China | `game/factions/china.md` | President Xi Jinping |

## Project Structure

```
server/
  index.ts          - Express server setup, dotenv loading, API routes
  ai-provider.ts    - Multi-provider abstraction (Gemini/OpenAI/Anthropic)
  ai.ts             - High-level AI functions (getFactionOrders, getNarrative)
  engine.ts         - Game engine, turn resolution, combat, diplomacy
  types.ts          - TypeScript interfaces for game state, orders, events
  gemini.ts         - Legacy Gemini-only implementation (deprecated)
src/
  main.ts           - Frontend entry point
  flatmap.ts        - Leaflet map rendering, territory overlays, UI
  style.css         - Styles
game/
  factions/         - Faction persona markdown files
  initial-world.json - Starting game state and map configuration
```

## Cost Controls

- Default to cheapest models (Gemini Flash, GPT-4o-mini)
- maxOutputTokens: 8192 (Gemini), 4096 (OpenAI/Anthropic)
- Compact JSON format for all orders (no prose in game data)
- Gemini thinking budget set to 0 to save tokens
- 15-second timeouts prevent runaway calls

## Development

```bash
npm run dev      # Start both client + server in dev mode
npm run server   # Server only (tsx watch)
npm run client   # Vite dev server only
npm run build    # Production build
npm start        # Production server
```
