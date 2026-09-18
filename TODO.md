# TODO

Open work for War Games. Public MIT repo under `NoblerWorks-HQ`, so anything here is
visible - keep notes accurate and free of anything internal.

Status is research/exploration: the multi-provider AI abstraction is the point of the
project, the game is the harness for it. Last commit 2026-08-31.

---

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

- [ ] No tests at all. The turn resolver in `server/engine.ts` (combat, territory change,
      resource gain, diplomacy) is pure logic over `game/initial-world.json` and is the
      obvious place to start - it needs no API key to exercise.
- [ ] No CI, and no `.github/workflows/` at all. Once tests exist, add typecheck + lint +
      test + build on push, matching the pattern in `rocketscan/.github/workflows/ci.yml`.
- [x] ~~Add `"typecheck": "tsc --noEmit"`~~ ✅ done 2026-09-17. One `tsconfig.json` covers both
      `src/` and `server/`; it reports 0 errors. Wire it into CI when CI exists.
- [ ] No lint config. This is a public repo taking contributions (`CONTRIBUTING.md` exists)
      with nothing to enforce a house style on a PR.

## 🟡 Cost and abuse surface

- [ ] Every turn calls the provider four times (three factions + narrator) every 10-15
      seconds, with no cap on turns, no token ceiling and no cost estimate anywhere in the
      docs. A reader who starts a game and walks away has an open-ended bill. At minimum,
      document the per-hour cost of the default Gemini config and add a max-turns setting.
- [ ] No rate limiting or retry/backoff on provider calls - a 429 mid-turn loses the turn.
- [x] ~~Game state is in-memory only, so a server restart drops every game in progress.
      Acceptable for local play; state it in the README rather than leaving it implied.~~ ✅ 2026-09-18 README Architecture > State now says it (single GameEngine in server/index.ts, no disk writes, no save/load)

## 🟢 Game and docs

- [ ] Factions are named after real sitting heads of state. Fine for a satire piece, worth
      a deliberate decision rather than an inherited one now that the repo is public.
- [x] ~~`game/rules.md` and `game/tech-tree.json` are not referenced from the README, so the
      moddable parts of the game are effectively undiscoverable.~~ ✅ 2026-09-18 README "Modding the game" section links all of game/
- [x] ~~Nuclear exchange is in the action list and in the screenshots but has no documented
      resolution rules - the one mechanic most readers will look for.~~ ✅ 2026-09-18 README "Nuclear exchange" section, written from server/engine.ts
- [ ] engine.ts comment says a nuked territory is irradiated "for 5 turns", but nothing restores
      it: `originalResources` is saved and never used, so the yield is wiped permanently. Decide
      which is intended and fix the code or the comment (README documents current behaviour).
- [x] ~~Write TODO.md~~ ✅ done 2026-09-06
