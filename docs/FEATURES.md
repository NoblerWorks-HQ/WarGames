# Feature Catalogue

The canonical list of what a user of War Games can see and do, verified against the code.
Update this file in the same commit as any user-visible change. Setup, configuration and the rules in prose live in the [README](../README.md) and [game/rules.md](../game/rules.md).
Status: open-source research demo that runs locally. A hosted demo is not planned ([TODO.md](../TODO.md)); the public site at <https://wargames.noblerworks.com/> is a static landing page. Per [TODO.md](../TODO.md), the newer features (seat models, replay, recap, leaderboard, tournaments, structured output) are tested with mocks and a fake OpenAI-compatible server, not yet against the real providers.

## The game

- **Three AI-commanded powers** ([game/factions/](../game/factions/), [server/ai.ts](../server/ai.ts)) - NATO, Russia and China, each played by an LLM with its own leader persona, choosing up to three orders per turn.
- **Order types** ([server/engine.ts](../server/engine.ts), [server/types.ts](../server/types.ts)) - move, attack, fortify, recruit, trade, spy, research, diplomacy, break_alliance, message, build_nuke, nuke and hire_mercenary. Orders resolve strictly: an unknown unit or out-of-range move is rejected, not corrected. The faction that resolves first rotates each turn.
- **Diplomacy and private memos** - factions send messages, trades and alliance proposals that appear in the others' briefings, and keep a private `notes` memo carried into their next briefing. Breaking an alliance (`break_alliance`) is a public betrayal with a surprise-attack bonus.
- **Research** ([game/tech-tree.json](../game/tech-tree.json)) - military, economic, intelligence and nuclear tracks. Some designed effects are not implemented yet; [game/rules.md](../game/rules.md) lists which.
- **Nuclear exchange** - research, build and launch warheads; a strike destroys every unit in the target, leaves it unowned and wipes its yield for 5 turns of fallout; nuclear 3 adds deterrence and an automatic second strike. Full rules in the README's "Nuclear exchange" section.
- **Narrator** ([server/ai.ts](../server/ai.ts)) - a separate AI writes a news-style bulletin each turn from public events only, never private reasoning or notes.
- **Victory** ([game/rules.md](../game/rules.md)) - domination, economic or diplomatic win checked every turn; otherwise highest score at turn 20; an exact tie is a draw.
- **Scenarios** (`SCENARIO`, [game/scenarios/](../game/scenarios/), [game/initial-world.json](../game/initial-world.json)) - `default` (real-world map) or `mirror` (identical land, forces and stock for all three, no continent bonuses), pickable in the UI between games.
- **Seeded dice** (`SEED`, [server/rng.ts](../server/rng.ts)) - the same seed and orders give the same battles; the seed is shown at game start and in the summary.

## The browser UI

- **Interactive map** ([src/flatmap.ts](../src/flatmap.ts), country shapes [public/countryborders.json](../public/countryborders.json)) - Leaflet map with territory overlays coloured by owner, units and live updates as each turn lands. No basemap tiles: the country shapes draw all the land, the United States is cut into Alaska / US West / US East ([src/clip.ts](../src/clip.ts)), and land no territory covers is plain ground.
- **Map and screen effects** ([src/effects/](../src/effects/)) - animations for combat, capture, fortify, recruit, spy, research, mercenaries, betrayal, warhead builds and nuclear blasts, plus screen-level effects.
- **Turn controls** ([src/main.ts](../src/main.ts)) - Start, Pause / Resume, Step (one turn, then pause), turn interval 5-60 seconds, Stop / Reset.
- **Faction panels and chat** - per-faction stats, model and spend, and the running chat log of public statements and bulletins.
- **War Room** ([src/warroom.ts](../src/warroom.ts)) - for any turn, side by side per leader: public statement, private reasoning and notes, and orders with how each resolved.
- **Seat models** - a box under each faction panel takes `provider` or `provider:model`; suggests providers whose keys are set, and checks the model with the provider before the game starts.
- **Cost readout** ([server/usage.ts](../server/usage.ts), [server/pricing.ts](../server/pricing.ts)) - estimated API spend this game, with calls and tokens on hover and per-faction spend. Prices come from a built-in table, overridable with `<PROVIDER>_PRICE_INPUT_PER_M` / `_OUTPUT_PER_M`.
- **Game-over summary and scorecard** ([server/scorecard.ts](../server/scorecard.ts)) - per seat: provider and model, rank, score, valid-order rate, forfeits, betrayals, nukes, tokens, cost and latency.
- **Save and load** ([server/saves.ts](../server/saves.ts)) - every finished turn autosaves to `games/<id>.json` (`GAMES_DIR`); Load brings an unfinished game back paused with dice, memos and costs intact, or shows a finished one's summary. Load does not restore the elapsed timer or chat animations, and only version 1 saves load.
- **Replay** - step or play a finished game turn by turn with moves animated and each bulletin as a caption. Saves from before turn frames existed cannot be replayed.
- **Share recap** ([server/recap.ts](../server/recap.ts)) - one self-contained, script-free HTML page with result, models, scorecard, territory-control chart and every bulletin; all model text escaped.
- **Leaderboard** - Elo per provider/model across finished saved games, in a modal.

## AI providers

- **Multi-provider abstraction** ([server/ai-provider.ts](../server/ai-provider.ts)) - Google Gemini (default), OpenAI and Anthropic Claude via direct API calls; per-faction and narrator overrides (`NATO_AI_PROVIDER` and so on); any OpenAI-compatible endpoint through `OPENAI_BASE_URL` (Ollama, LM Studio, vLLM).
- **Startup model check** - on boot each configured model id is checked through the provider's metadata endpoint (no tokens); a bad model or key stops the server, an unreachable provider only warns. `SKIP_MODEL_CHECK=1` skips it.
- **Native structured output** (`STRUCTURED_OUTPUT=1`) - JSON mode for OpenAI and Gemini, a forced `submit_orders` tool call for Anthropic; recorded in the game. Request bodies are unit-tested only.
- **Retries** ([server/retry.ts](../server/retry.ts)) - 429, 5xx and dropped connections retried up to twice with backoff honouring `Retry-After`; 15-second timeouts.
- **Cost caps** - cheap default models, compact JSON orders, and games end at 20 turns (`maxTurns`).

## Command-line tools

- **Tournament** (`npm run tournament`, [server/tournament-cli.ts](../server/tournament-cli.ts), [server/tournament.ts](../server/tournament.ts)) - three-entrant lineups with seat rotation and a shared seed per round, both scenarios by default, USD budget cap (refuses unpriced models unless `--allow-unpriced`), resume by `--id`, `--dry-run`, `--max-turns`, `--narrate`; writes `results.md` and `results.json`.
- **Leaderboard** (`npm run leaderboard`, [server/leaderboard-cli.ts](../server/leaderboard-cli.ts), [server/leaderboard.ts](../server/leaderboard.ts)) - Elo (start 1500, K=32) from all finished games and tournaments; writes `games/leaderboard.md` and `.json`.

## Server and HTTP API

- **API server** ([server/index.ts](../server/index.ts)) - Express on `127.0.0.1:3001` (`HOST`, `PORT`). Controls: `POST /api/start`, `/api/pause`, `/api/resume`, `/api/step`, `/api/interval`, `/api/stop`, `/api/reset`, `/api/load`. Reads: `GET /api/config`, `/api/state`, `/api/chat`, `/api/turns`, `/api/scorecard`, `/api/scenarios`, `/api/providers`, `/api/games`, `/api/games/:id`, `/api/recap`, `/api/leaderboard`.
- **Origin guard** ([server/http.ts](../server/http.ts)) - only the local UI origins may call the API, since every game spends your provider key.
- **Read-only demo** (`READ_ONLY=1`, [Dockerfile](../Dockerfile), [demo-games/](../demo-games/README.md)) - serves saved games only: no provider calls, every non-GET refused, play controls hidden, each visitor browses privately. Built and run locally; not hosted.
- **Production mode** (`npm run build` then `npm start`) - one server serves the API and the built client on `:3001`.

## Public site and quality gates

- **Landing site** ([site/](../site/index.html)) - static pages on GitHub Pages at wargames.noblerworks.com: home, [how it works](../site/how-it-works/index.html), [AI providers](../site/ai-providers/index.html), [modding](../site/modding/index.html), [nuclear exchange](../site/nuclear-exchange/index.html), plus 404, sitemap, robots.txt and `llms.txt`.
- **Site checker** ([.github/scripts/check-site.py](../.github/scripts/check-site.py), [.github/workflows/pages.yml](../.github/workflows/pages.yml)) - blocks the Pages deploy on broken links or images, bad SEO tags, invalid JSON-LD, sitemap gaps or a mismatched IndexNow key; the deploy then notifies IndexNow.
- **CI** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) - typecheck, lint, vitest (AI mocked, no key needed) and build. [.github/workflows/link-check.yml](../.github/workflows/link-check.yml) runs an advisory external-link check that opens a link-rot issue.
