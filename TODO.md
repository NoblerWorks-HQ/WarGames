# TODO

Open work for War Games. Public MIT repo under `NoblerWorks-HQ`, so anything here is
visible - keep notes accurate and free of anything internal.

Status is research/exploration: the multi-provider AI abstraction is the point of the
project, the game is the harness for it. Last commit 2026-08-31.

---

## Phase 3 (2026-10-18)

- [x] 2026-10-18 Pick models in the browser: a box under each faction panel (`provider` or `provider:model`), `/api/providers`, checked with the provider before the game starts; recorded as `game.seats` and re-pinned when a game is loaded.
- [x] 2026-10-18 Replay viewer: every turn stores a board frame (`TurnResult.frame`); REPLAY in the game-over summary steps or plays through it. Saves from before frames existed can't be replayed.
- [x] 2026-10-18 Shareable recap: `/api/recap` and SHARE RECAP; one script-free HTML page (CSP forbids scripts too), all model text escaped (tested with script/img payloads).
- [x] 2026-10-18 Elo leaderboard: `npm run leaderboard`, `/api/leaderboard`, LEADERBOARD modal.
- [x] 2026-10-18 Read-only demo: `READ_ONLY=1`, `PORT`, `/api/games/:id`, `Dockerfile`, `demo-games/`. Docker image built and run locally. **Hosting is not planned** (2026-10-18): WarGames is open source and runs locally for fun; a hosted demo isn't worth the expense. The mode stays for anyone who wants to share their own games.
- [x] 2026-10-18 Found while testing: the built UI loads its script with `crossorigin`, so any port other than 3000/3001 got 403s on its own files. Same-origin is now accepted in read-only mode only (in normal mode it would reopen DNS rebinding against a key-spending server). Normal mode on a LAN address (`HOST=0.0.0.0`) still has this limitation.
- [x] 2026-10-18 Header tightened so nothing wraps at 1280px.
- [ ] Nothing here has met a real model yet: no API keys were configured in this environment. First real step: `npm run tournament -- --max-turns 5` (about $0.40 by the untested estimates), then `npm run leaderboard`.

## Phase 2 (2026-10-18)

- [x] 2026-10-18 Save/load: autosave after every turn to `games/<id>.json`, `/api/games`, `/api/load`, Load dropdown. A restored game replays exactly like the original (test compares full state after a further turn, dice position included).
- [x] 2026-10-18 Scorecard: `server/scorecard.ts`, `/api/scorecard`, table in the game-over summary, stored in each save.
- [x] 2026-10-18 Mirror scenario: `SCENARIO=mirror`, `game/scenarios/`, UI picker, `/api/scenarios`, persona override note. Yield totals within 2, but terrain/coast still differ (Russia has no coast), so rotate models across seats for a fair comparison. Judgement call on which territories - change `game/scenarios/mirror.json`.
- [x] 2026-10-18 Native structured output: `STRUCTURED_OUTPUT=1`, recorded in the game and summary. JSON mode only for OpenAI/Gemini (no strict schema: unions of order shapes don't fit strict mode); Anthropic gets the loose schema through a forced tool call. **Request bodies are unit-tested but never sent to the real APIs** - run one game per provider with it on and check forfeits. Whether it actually reduces invalid replies is unmeasured; the scorecard's valid-order rate and forfeits will show it.
- [x] 2026-10-18 Tournament mode: `npm run tournament`, seat rotation with a shared seed per round, budget cap (refuses unpriced models unless `--allow-unpriced`), resume by `--id`, `results.md`/`results.json`. Per-seat provider pins (`setRoleProviders`) and `provider:model` specs, so two models from one vendor can play each other. Narrator off by default in tournaments.
- [x] 2026-10-18 Fixes found by the first tournament run: an exact score tie used to go to the first faction listed (NATO) - now a draw. The first mirror scenario wasn't level (NATO's start yielded 21 vs 19, with 2 coasts and one capture from the North America bonus) - mirror start land is now plains with identical yields, and continent bonuses are off.
- [ ] Not yet run against real providers. A 1-round, 20-turn, 3-provider tournament is 6 games x 20 turns x 3 calls = 360 calls; by the README's rough per-game estimates (averaged over the three vendors) about $1.50, but those estimates are untested. Start with `--max-turns 5`.
- [ ] Ideas: Elo across tournaments (Phase 3); parallel games; per-turn time limit enforcement; confidence intervals in results.md.
- [ ] Load does not restore the elapsed timer or chat animations; saves from older engine versions are rejected (version 1 only).

## Phase 1 features (2026-10-18)

Built on branch `gameplay-fixes`; 92 tests. Exercised end to end against a fake OpenAI-compatible server and a headless browser, **not** against the real providers.

- [x] 2026-10-18 Seeded dice: `SEED` env var (number or text); same seed + same orders = same battles; seed shown at game start and in the summary. `server/rng.ts`.
- [x] 2026-10-18 Fallout wears off: a nuked territory's yield returns after 5 turns (and a second strike restarts the clock). Fixed the "irradiated for 5 turns" comment/behaviour mismatch.
- [x] 2026-10-18 Strategy notes: optional `notes` (300 chars) in a faction's reply, returned as `yourNotes`; private from other factions and the narrator.
- [x] 2026-10-18 Narrator input: public events, public statements, betrayals, standings and the previous bulletin; never private reasoning, private messages or invalid orders.
- [x] 2026-10-18 Nuclear rebalance: everyone starts at nuclear 1 with 2/2/1 warheads (NATO/Russia/China); Second Strike must be researched. Personas rewritten to match. **Judgement call on the numbers - change them in `game/initial-world.json` if the arms race plays badly.**
- [x] 2026-10-18 Cost estimate: tokens, latency and USD per faction and narrator, live in the UI and in `/api/state`. `server/pricing.ts` prices are from third-party trackers (2026-10-17), not vendor pages - verify before quoting.
- [x] 2026-10-18 Turn controls: Pause, Resume, Step and a 5-60s speed slider (`/api/pause|resume|step|interval`); the UI follows the server's state, so a page reload shows the right buttons.
- [x] 2026-10-18 War Room: per leader and turn, public statements vs private reasoning and notes vs orders and results.
- [ ] Token extraction for the three providers (`usage` fields) follows each vendor's documented response shape and the Gemini SDK types, but no real call has been made. Run one game per provider and check the Cost readout against the provider's dashboard. Gemini output tokens are `total - prompt`, which includes thinking tokens.
- [ ] The README per-game cost figures ($0.10 / $0.06 / $0.60) are estimates from measured prompt size and assumed output length, not from a real game.
- [ ] Fallout has no map visual yet; it only shows in briefings and the Arbiter's chat.

## Gameplay review (2026-10-17)

All fixed 2026-10-17 in `server/engine.ts`. 13 new tests in `server/engine.test.ts` (50 total); every one of them fails against the old engine.

- [x] 2026-10-17 high - Factions never saw each other's alliance proposals or messages, so diplomacy was cosmetic. The briefing now carries `inbox`, `incomingAllianceProposals`, `yourPendingProposals`, `otherFactions` and `yourLastReasoning`. `message` takes an optional private `to`. Proposals lapse after 2 turns.
- [x] 2026-10-17 high - Orders always resolved NATO -> Russia -> China; the first faction now rotates every turn. When several factions win on the same turn, score breaks the tie.
- [x] 2026-10-17 high - The engine fuzzy-matched unit ids and substituted another unit when the named one couldn't reach, which hid model mistakes. Orders are now strict.
- [x] 2026-10-17 medium - `spy` did nothing; the target now appears in the next briefing.
- [x] 2026-10-17 medium - The diplomatic victory checked `turn >= 10`, not how long the alliances had lasted; it now uses `allianceSince`.
- [x] 2026-10-17 medium - Allies could attack, invade and nuke each other without `break_alliance`.
- [x] 2026-10-17 medium - A unit could act on every order in a turn; it now gets one move or attack. Armor's 2 movement is now honoured.
- [x] 2026-10-17 medium - Unit ids came from `Date.now()`, so two recruits in one turn could get the same id; ids now continue the faction's numbering.
- [x] 2026-10-17 medium - `recruit` worked in any territory, including enemy ones, and defaulted to the first unit's location; it now requires a territory you own.
- [x] 2026-10-17 low - The order cap was 5 in `ai.ts` and 3 in the personas and rules; it is now 3 everywhere (`MAX_ORDERS`).
- [x] 2026-10-17 low - Running out of food did nothing; unfed units now lose hp. Upkeep is paid after income.
- [x] 2026-10-17 low - The score left out nuclear tech and uranium.
- [x] 2026-10-17 low - `index.html` hard-coded stale starting numbers ("0 / 100", old resources).
- [x] 2026-10-17 low - `game/rules.md` described a different game (20 territories, cavalry/siege, 10/30/5 victory thresholds). It is rewritten from the engine and lists the `tech-tree.json` effects that aren't implemented.
- [x] ~~Nuclear start: NATO/Russia began at nuclear 3 with 5,000+ warheads, so `research nuclear`/`build_nuke` did nothing for them.~~ Fixed 2026-10-18 (see Phase 1).
- [ ] Still open: starting territories are asymmetric (NATO 8, Russia 3, China 2) and NATO starts with all tech at 2. Fine for the satire, but it weakens provider comparisons (the mirror scenario would address it).

## Audit findings (2026-10-02)

Fleet audit follow-up; all fixed on main 2026-10-02 (local app, nothing to deploy - push to publish).

- [x] 2026-10-02 high - README quickstart pointed at :5173, Vite runs on :3000 (`README.md:36`, `CONTRIBUTING.md`) - fixed.
- [x] 2026-10-02 medium - Open CORS + all-interface bind let any site or LAN host spend the user's key (`server/index.ts`) - binds 127.0.0.1 (`HOST` opt-in), 403 on foreign Origin, CORS only for the local UI, `intervalMs` clamped 5-60s; tests in `server/http.test.ts`.
- [x] 2026-10-02 medium - stop -> start mid-turn ran an old turn into the reset game (`server/engine.ts`) - generation id + `StaleTurnError`; regression test in `server/engine.test.ts`.
- [x] 2026-10-02 medium - `npm start` served no client (`server/index.ts`) - serves `dist/` with SPA fallback when built.
- [x] 2026-10-02 low - package.json said ISC, LICENSE is MIT - now MIT + author + repository.

## 🟡 Refactor survey (2026-09-18)

Found by a read-only survey of the repo on 2026-09-18; none was tracked before. Ranked by payoff for the effort. 🟠 = a real bug or risk, not only tidiness.

- [x] ~~Move the 13 `spawn*Effect` / `trigger*ScreenEffect` methods (lines 303-1080) out of the `FlatMap` class in `src/flatmap.ts` (1,226 lines) into `src/effects/*.ts` behind a small `Effect` interface. M, visual only.~~ ✅ 2026-09-18 `src/effects/{types,screen,impacts,local}.ts` behind an `EffectHost` interface; `flatmap.ts` 1,226 -> 582 lines. typecheck + build pass; all 10 effects spawned and cleared in a browser with no runtime errors.

## 🔴 Stale model defaults - public and wrong

- [x] ~~Anthropic default `claude-sonnet-4-6` -> `claude-sonnet-5` in code, `.env.example` and
      README~~ ✅ done 2026-09-17. Also stopped sending `temperature` (Sonnet 5 / Opus 5
      reject it with a 400) and send `thinking: disabled` to keep turns fast.
- [x] ~~Re-check OpenAI and Gemini defaults~~ ✅ done 2026-09-17, verified against the
      providers' model pages: OpenAI `gpt-4o-mini` -> `gpt-5.6-luna` (OpenAI's named
      replacement for its small models on the deprecations page); Gemini `gemini-2.5-flash`
      -> `gemini-3.5-flash-lite` (stable, same $0.30/$2.50 price point as 2.5 Flash;
      3.8 Flash is newer but 2.5x the price and cannot switch thinking off).
      GPT-5+ models now get `max_completion_tokens` + `reasoning_effort` (default `none`,
      `OPENAI_REASONING_EFFORT` overrides); Gemini 3.x no longer gets `thinkingBudget: 0`.
- [x] ~~Validate model ids at startup~~ ✅ done 2026-09-17. `validateProviders()` runs at boot
      for every role's provider: unknown model or rejected key refuses to start and names the
      env var; unreachable provider warns and continues; `SKIP_MODEL_CHECK=1` skips it.
- [ ] 2026-09-24: run one real game per provider with the new defaults (needs a real key for
      each) - the defaults were checked against the docs and the key-rejected path against the
      live APIs, but no turn has been played on `gpt-5.6-luna`, `gemini-3.5-flash-lite` or
      `claude-sonnet-5` yet.

## 🟠 No safety net

- [x] ~~No tests at all. The turn resolver in `server/engine.ts` (combat, territory change,
      resource gain, diplomacy) is pure logic over `game/initial-world.json` and is the
      obvious place to start - it needs no API key to exercise.
      When tests land, add an `npm test` step to `.github/workflows/ci.yml`.~~
      ✅ 2026-09-18 `server/engine.test.ts` (vitest, 23 tests, AI layer mocked, dice pinned):
      resource gain, move/fortify/recruit/research, combat win/draw/repel, mercenaries,
      alliances and oathbreaking, nukes, maxTurns and domination victory. `npm test` is in CI
      and in CONTRIBUTING/README.
- [x] ~~No CI, and no `.github/workflows/` at all. Once tests exist, add typecheck + lint +
      test + build on push, matching the pattern in `rocketscan/.github/workflows/ci.yml`.~~
      ✅ 2026-09-18 `.github/workflows/ci.yml` runs typecheck + lint + build on push to main
      and on PRs. The test step is added with the first tests (item above).
- [x] ~~Add `"typecheck": "tsc --noEmit"`~~ ✅ done 2026-09-17. One `tsconfig.json` covers both
      `src/` and `server/`; it reports 0 errors. Wire it into CI when CI exists.
- [x] ~~No lint config. This is a public repo taking contributions (`CONTRIBUTING.md` exists)
      with nothing to enforce a house style on a PR.~~ ✅ 2026-09-18 `eslint.config.js`
      (ESLint 9 + typescript-eslint recommended), `npm run lint` exits 0; the 33 existing
      findings were fixed, not suppressed, except the unused `originalResources` in
      `server/engine.ts`, which is the open "irradiated for 5 turns" item below.

## 🟡 Cost and abuse surface

- [x] ~~Every turn calls the provider four times (three factions + narrator) every 10-15
      seconds, with no token ceiling and no cost estimate anywhere in the docs. Document the
      per-game cost of the default Gemini config in README "Cost Controls".~~ ✅ 2026-10-18 README "Cost Controls" has a rough per-game estimate for all three defaults, and the UI shows live spend. The estimate is not from a real game (see Phase 1 notes). Still no token ceiling on input.
      (2026-09-18: the turn cap already exists - `maxTurns: 20` in `game/initial-world.json`,
      enforced at `server/engine.ts:335`, and the interval stops itself at `engine.ts:76`, so
      a game is at most 80 calls, not open-ended. README now says so.)
- [x] ~~No rate limiting or retry/backoff on provider calls - a 429 mid-turn loses the turn.~~
      ✅ 2026-09-18 `server/retry.ts` wraps all three providers' `generate()`: 429, 5xx and
      network failures retried twice (1s/2s jittered backoff, `Retry-After` honoured, 8s cap);
      401/400/timeouts are not. `server/retry.test.ts` covers it with mocked fetch (10 tests).
      No client-side rate limiter was added - the 4-calls-per-turn cadence is already bounded.
- [x] ~~Game state is in-memory only, so a server restart drops every game in progress.
      Acceptable for local play; state it in the README rather than leaving it implied.~~ ✅ 2026-09-18 README Architecture > State now says it (single GameEngine in server/index.ts, no disk writes, no save/load)

## 🟢 Game and docs

- [ ] Factions are named after real sitting heads of state. Fine for a satire piece, worth
      a deliberate decision rather than an inherited one now that the repo is public.
- [x] ~~`game/rules.md` and `game/tech-tree.json` are not referenced from the README, so the
      moddable parts of the game are effectively undiscoverable.~~ ✅ 2026-09-18 README "Modding the game" section links all of game/
- [x] ~~Nuclear exchange is in the action list and in the screenshots but has no documented
      resolution rules - the one mechanic most readers will look for.~~ ✅ 2026-09-18 README "Nuclear exchange" section, written from server/engine.ts
- [x] ~~engine.ts comment says a nuked territory is irradiated "for 5 turns", but nothing restores
      it~~ ✅ 2026-10-18 the yield is now restored after 5 turns (`fallout` on the territory).
- [x] ~~Write TODO.md~~ ✅ done 2026-09-06
