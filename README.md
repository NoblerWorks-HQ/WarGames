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

Open http://localhost:3000 and click **Start**. The API server listens on 127.0.0.1:3001 only (set `HOST=0.0.0.0` to expose it on your network - every game spends your provider key).

### Controls

| Control | What it does |
|---------|--------------|
| **Start** | Begin a fresh game and play a turn every N seconds |
| **Pause / Resume** | Suspend the turn timer without losing the game; a turn already in flight still finishes, and Resume plays the next turn at once |
| **Step** | Play exactly one turn, then stay paused (starts a game if none is running) |
| **Turn every Ns** | Seconds between turns, 5-60. Takes effect immediately |
| **Stop / Reset** | End the game / clear it |
| **War Room** | For any turn, side by side per leader: what they said in public, what they privately reasoned (including their notes to themselves), and what they ordered and how it resolved |
| **Cost** | Estimated API spend so far this game; hover for calls and tokens. Each faction panel shows its model and its own spend |

The same controls are HTTP endpoints: `POST /api/start`, `/api/pause`, `/api/resume`, `/api/step` (409 while a turn is in progress), `/api/interval` and `/api/stop`.

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
| `SEED` | _(random per game)_ | Seed for every die roll (a number, or any text). The same seed replays the same dice, so the same orders give the same battles. The seed of each game is shown in the opening message and the end-of-game summary |
| `<PROVIDER>_PRICE_INPUT_PER_M` / `_OUTPUT_PER_M` | _(built-in table)_ | Override the USD-per-million-token price used for the cost estimate, e.g. `OPENAI_PRICE_INPUT_PER_M=0.2` and `OPENAI_PRICE_OUTPUT_PER_M=1.2`. Set both. A model with no price shows tokens but no cost |

The `OPENAI_BASE_URL` option means you can use any OpenAI-compatible API, including local models via Ollama, LM Studio, or vLLM.

**Startup model check.** When the server boots it asks each configured provider whether its model id exists, using the provider's model-metadata endpoint (no tokens are spent). If a model id is unknown or an API key is rejected, the server refuses to start and names the env var to fix. If the provider can't be reached (offline, timeout, rate limit, server error) it logs a warning and starts anyway. With a custom `OPENAI_BASE_URL`, a missing model is only a warning, because not every OpenAI-compatible server implements the models endpoint. Set `SKIP_MODEL_CHECK=1` to skip the check.

## How It Works

Each turn (every 10-15 seconds):

1. The game engine builds a briefing for each faction with visible territories, resources, units, and valid actions
2. All three AI factions receive their briefing and respond with up to 3 orders (move, attack, fortify, recruit, trade, spy, research, diplomacy, message, nuke, ...). The briefing includes the messages, trades and alliance proposals other factions sent them, and the private `notes` memo they wrote themselves last turn (replaced whenever they send new notes)
3. Orders are resolved strictly: an unknown unit id or an out-of-range move is rejected, not corrected. The faction that resolves first rotates each turn, so no seat (or provider) always gets the first move
4. A narrator AI writes a dramatic CNN-style news recap. It is told the turn's public events, public statements, betrayals, standings and the previous bulletin, never private reasoning or notes
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

- [`game/rules.md`](game/rules.md) - the full rules as the engine enforces them: map, resources, units, orders, combat, diplomacy, tech and victory conditions.
- [`game/tech-tree.json`](game/tech-tree.json) - the four research tracks (military, economic, intelligence, nuclear) as designed. Several of its effects aren't implemented yet; `rules.md` lists which.
- [`game/initial-world.json`](game/initial-world.json) - starting territories, adjacency, resources and units.
- [`game/factions/`](game/factions/) - the persona prompt each faction's AI plays.

Neither file is read by the code or shown to the AIs. The numbers that are actually enforced (costs, ranges, combat) are in `server/engine.ts`, so update `rules.md` whenever you rebalance.

### Nuclear exchange

How nukes resolve in `server/engine.ts`:

0. **Starting point** - everyone starts level with nuclear 1 and a handful of warheads (NATO 2, Russia 2, China 1), so nobody can retaliate at first and the arms race is part of the game.
1. **Research** - the `nuclear` track has three levels, costing 5/8/10 knowledge plus 3/5/8 uranium.
2. **Build** (`build_nuke`, needs nuclear 1) - a warhead costs 10 gold + 5 uranium, or 8 gold + 3 uranium from nuclear 2. At nuclear 3, every warhead you build also costs each other faction 5 influence (deterrence).
3. **Launch** (`nuke`, needs a warhead in stock) - below nuclear 2 the target must be adjacent to a territory you own; from nuclear 2 (ICBMs) any territory is in range. You cannot nuke your own territory.
4. **Effect** - every unit in the target territory is destroyed, whoever owns it. The territory loses its fortification, becomes unowned, and its resource yield is wiped for the next 5 turns (fallout). After that the yield comes back to whoever holds it. A land captured during fallout pays nothing until it clears, and a second strike restarts the clock. Briefings show `falloutClearsOnTurn`.
5. **Second strike** - if the territory belonged to a faction with nuclear 3 and at least one warhead, that faction automatically fires one back at a random territory the attacker owns, with the same effect. Range is not checked for the retaliation, and a retaliation does not trigger another one.

Orders resolve one faction at a time, and the faction that goes first rotates every turn (NATO on turn 1, Russia on turn 2, China on turn 3, ...). A strike lands before any faction resolving after it that turn. You can't nuke an ally's territory without breaking the alliance first.

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
- A rate limit (429), provider error (5xx) or dropped connection is retried up to twice with exponential backoff (1s, 2s, honouring `Retry-After`, capped at 8s) instead of forfeiting the turn; timeouts and other 4xx errors are not retried (`server/retry.ts`)
- Games end after `maxTurns` turns (20, set in `game/initial-world.json`) and the turn loop stops itself, so one game is at most 80 provider calls (three factions + the narrator per turn)
- Every call's tokens, latency and estimated cost are tallied per faction and shown live in the UI (`GET /api/state` carries the same numbers as `usage`). Prices are a small table in `server/pricing.ts` taken from third-party trackers, so check them before quoting a figure, and override them in `.env` if they are stale

**Rough cost of a full 20-turn game.** A faction prompt is about 10-13k characters on turn 1 (measured), roughly 3k tokens, and grows as the game does; the figures below assume about 4k input and 150 output tokens per faction call and a small narrator call, with unmeasured output lengths. That is about 250k input and 11k output tokens per game: roughly **$0.10** on Gemini 3.5 Flash-Lite, **$0.06** on GPT-5.6 Luna and **$0.60** on Claude Sonnet 5 at the listed prices. Treat these as order-of-magnitude; the in-game Cost readout is the real number.

## Development

```bash
npm run dev      # Client + server (hot reload)
npm run server   # Server only
npm run client   # Vite dev server only
npm run build    # Production build
npm run typecheck # Type-check client + server (tsc --noEmit)
npm test         # Turn-resolver tests (vitest, AI mocked - no API key needed)
npm start        # Production server: API + built client (run `npm run build` first) on http://localhost:3001
```

## License

MIT
