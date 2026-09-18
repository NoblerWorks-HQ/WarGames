# War Games

AI-powered geopolitical strategy simulation. Three great powers - NATO, Russia, and China - compete for territory, resources, and global dominance on an interactive map. Each faction is controlled by an AI making strategic decisions every turn.

![AI Strategy](https://img.shields.io/badge/AI-Strategy%20Simulation-red)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-199900?logo=leaflet&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?logo=googlegemini&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-412991?logo=openai&logoColor=white)
![Claude](https://img.shields.io/badge/Anthropic%20Claude-D4A574?logo=anthropic&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-green)
![Open Source](https://img.shields.io/badge/Open%20Source-%E2%9D%A4-red)

![Nuclear Launch Detected](screenshots/wargames-nuclear-launch-detected.png)

![Nuclear Explosion](screenshots/wargames-nuke-explosion.png)

![End Game - Victory Screen](screenshots/wargames-endgame.png)

## Quick Start

```bash
# Install dependencies
npm install

# Configure your AI provider (see below)
cp .env.example .env
# Edit .env with your API key

# Run (starts both server + client)
npm run dev
```

Open http://localhost:5173 and click **Start Game**.

## AI Providers

War Games supports three AI providers. Pick whichever you prefer - you only need one.

### Google Gemini (default, cheapest)

1. Get an API key at https://aistudio.google.com/apikey
2. Set in `.env`:
   ```
   AI_PROVIDER=gemini
   GEMINI_API_KEY=your-key-here
   ```

### OpenAI / ChatGPT

1. Get an API key at https://platform.openai.com/api-keys
2. Set in `.env`:
   ```
   AI_PROVIDER=openai
   OPENAI_API_KEY=your-key-here
   ```

### Anthropic / Claude

1. Get an API key at https://console.anthropic.com/settings/keys
2. Set in `.env`:
   ```
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=your-key-here
   ```

### Mix and Match - Different AI per Faction

Want Claude commanding NATO while Gemini runs Russia and ChatGPT leads China? Set per-faction overrides:

```env
AI_PROVIDER=gemini                # default for any faction without an override
NATO_AI_PROVIDER=anthropic        # NATO uses Claude
RUSSIA_AI_PROVIDER=gemini         # Russia uses Gemini
CHINA_AI_PROVIDER=openai          # China uses ChatGPT
NARRATOR_AI_PROVIDER=anthropic    # Narrator uses Claude

# You'll need API keys for each provider you use
GEMINI_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

### Advanced Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `gemini` | Global default: `gemini`, `openai`, or `anthropic` |
| `NATO_AI_PROVIDER` | _(uses global)_ | Override provider for NATO faction |
| `RUSSIA_AI_PROVIDER` | _(uses global)_ | Override provider for Russia faction |
| `CHINA_AI_PROVIDER` | _(uses global)_ | Override provider for China faction |
| `NARRATOR_AI_PROVIDER` | _(uses global)_ | Override provider for the narrator |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model override |
| `OPENAI_MODEL` | `gpt-5.6-luna` | OpenAI model override |
| `OPENAI_REASONING_EFFORT` | `none` | Reasoning effort for GPT-5+ / o-series models (use `minimal` for older GPT-5 models that lack `none`) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint (for local models, Azure, etc.) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Anthropic model override |
| `SKIP_MODEL_CHECK` | _(unset)_ | Set to `1` to skip the startup model check |

The `OPENAI_BASE_URL` option means you can use any OpenAI-compatible API, including local models via Ollama, LM Studio, or vLLM.

**Startup model check.** When the server boots it asks each configured provider whether its model id exists, using the provider's model-metadata endpoint (no tokens are spent). If a model id is unknown or an API key is rejected, the server refuses to start and names the env var to fix. If the provider can't be reached (offline, timeout, rate limit, server error) it logs a warning and starts anyway. With a custom `OPENAI_BASE_URL`, a missing model is only a warning, because not every OpenAI-compatible server implements the models endpoint. Set `SKIP_MODEL_CHECK=1` to skip the check.

## How It Works

Each turn (every 10-15 seconds):

1. The game engine builds a briefing for each faction with visible territories, resources, units, and valid actions
2. All three AI factions receive their briefing and respond with strategic orders (move, attack, fortify, recruit, trade, spy, research, diplomacy, nuke)
3. Orders are resolved - combat, territory changes, resource gains
4. A narrator AI writes a dramatic CNN-style news recap
5. The map updates in real-time

### Factions

| Faction | Leader | Strategy |
|---------|--------|----------|
| **NATO** | President Trump | Tech advantage, coalition warfare, aggressive dealmaking |
| **Russia** | President Putin | Defensive depth, nuclear deterrence, cold calculation |
| **China** | President Xi Jinping | Economic leverage, patience, long-term strategy |

## Architecture

- **Frontend**: Vite + TypeScript + Leaflet map with territory overlays, combat effects, and game summary
- **Backend**: Express server (port 3001) with game engine and AI provider abstraction
- **AI**: Direct API calls to Gemini, OpenAI, or Anthropic (no agent framework - just raw API)
- **State**: In-memory only. The server holds a single `GameEngine` instance (`server/index.ts`) and never writes game state to disk, so restarting the server (including a `tsx watch` reload during `npm run dev`) drops the game in progress and its turn history. There is no save/load.

### Project Structure

```
server/
  index.ts          - Express server setup, dotenv loading, API routes
  ai-provider.ts    - Multi-provider abstraction (Gemini/OpenAI/Anthropic)
  ai.ts             - High-level AI functions (getFactionOrders, getNarrative)
  engine.ts         - Game engine, turn resolution, combat, diplomacy
  types.ts          - TypeScript interfaces for game state, orders, events
src/
  main.ts           - Frontend entry point
  flatmap.ts        - Leaflet map rendering, territory overlays, UI
  effects/          - Map and screen animations (impacts, per-territory effects)
  style.css         - Styles
game/
  factions/         - Faction persona markdown files
  initial-world.json - Starting game state and map configuration
  rules.md          - Full game rules (map, resources, units, combat, victory)
  tech-tree.json    - Research tracks, costs and effects
```

### Modding the game

The game content lives in `game/` and is the place to start if you want to change how War Games plays:

- [`game/rules.md`](game/rules.md) - the rules the factions play by: map, terrain, resources, units, combat and victory conditions.
- [`game/tech-tree.json`](game/tech-tree.json) - the four research tracks (military, economic, intelligence, nuclear), their costs and effects.
- [`game/initial-world.json`](game/initial-world.json) - starting territories, adjacency, resources and units.
- [`game/factions/`](game/factions/) - the persona prompt each faction's AI plays.

Note that `rules.md` and `tech-tree.json` describe the rules; the numbers that are actually enforced (costs, ranges, combat) are in `server/engine.ts`, so change both when you rebalance.

### Nuclear exchange

How nukes resolve in `server/engine.ts`:

1. **Research** - the `nuclear` track has three levels, costing 5/8/10 knowledge plus 3/5/8 uranium.
2. **Build** (`build_nuke`, needs nuclear 1) - a warhead costs 10 gold + 5 uranium, or 8 gold + 3 uranium from nuclear 2. At nuclear 3, every warhead you build also costs each other faction 5 influence (deterrence).
3. **Launch** (`nuke`, needs a warhead in stock) - below nuclear 2 the target must be adjacent to a territory you own; from nuclear 2 (ICBMs) any territory is in range. You cannot nuke your own territory.
4. **Effect** - every unit in the target territory is destroyed, whoever owns it. The territory loses its fortification, becomes unowned, and its resource yield is wiped. It is not restored later: it stays neutral with no yield until someone moves a unit in and captures it.
5. **Second strike** - if the territory belonged to a faction with nuclear 3 and at least one warhead, that faction automatically fires one back at a random territory the attacker owns, with the same effect. Range is not checked for the retaliation, and a retaliation does not trigger another one.

Orders resolve in faction order (NATO, Russia, China) within a turn, so a strike lands before any later faction's orders for that turn are resolved.

### Game Engine

`server/engine.ts` runs the turn loop:

1. Build a briefing for each faction (visible territories, resources, units, valid actions)
2. Call `getFactionOrders()` in parallel for all 3 factions
3. Parse JSON responses, resolve orders (movement, combat, research, diplomacy, nukes, etc.)
4. Call `getNarrative()` for a dramatic news-style recap
5. Store turn history, broadcast state to clients via polling

### Cost Controls

- Default to cheap, fast models (Gemini 3.5 Flash-Lite, GPT-5.6 Luna, Claude Sonnet 5)
- Compact JSON format for all orders (no prose in game data)
- 15-second timeouts prevent runaway calls
- Games end after `maxTurns` turns (20, set in `game/initial-world.json`) and the turn loop stops itself, so one game is at most 80 provider calls (three factions + the narrator per turn)

## Development

```bash
npm run dev      # Client + server (hot reload)
npm run server   # Server only
npm run client   # Vite dev server only
npm run build    # Production build
npm run typecheck # Type-check client + server (tsc --noEmit)
npm test         # Turn-resolver tests (vitest, AI mocked - no API key needed)
npm start        # Production server
```

## License

MIT
