# TODO

Open work for War Games. Public MIT repo under `NoblerWorks-HQ`, so anything here is
visible - keep notes accurate and free of anything internal.

Status is research/exploration: the multi-provider AI abstraction is the point of the
project, the game is the harness for it. Last commit 2026-08-31.

---

## 🔴 Stale model defaults - public and wrong

- [ ] `server/ai-provider.ts:106` defaults Anthropic to `claude-sonnet-4-6`. The current
      Claude family is Claude 5 - `claude-sonnet-5` is the like-for-like replacement, with
      `claude-opus-5` if the narrator wants the better prose. Anyone cloning this repo
      today gets the stale id from `.env.example` and the README table too, so fix all
      three in the same pass.
- [ ] `server/ai-provider.ts:68` defaults OpenAI to `gpt-4o-mini` and `:47` defaults Gemini
      to `gemini-2.5-flash`. Re-check both against what those providers currently ship
      before the next release - a default that 404s is the worst first-run experience an
      open-source project can offer.
- [ ] Nothing validates a model id at startup. A bad default surfaces as a failed turn
      mid-game rather than as an error on boot. Fail fast in the provider constructor.

## 🟠 No safety net

- [ ] No tests at all. The turn resolver in `server/engine.ts` (combat, territory change,
      resource gain, diplomacy) is pure logic over `game/initial-world.json` and is the
      obvious place to start - it needs no API key to exercise.
- [ ] No CI, and no `.github/workflows/` at all. Once tests exist, add typecheck + lint +
      test + build on push, matching the pattern in `rocketscan/.github/workflows/ci.yml`.
- [ ] No `typecheck` script despite being a TypeScript project on both sides. Add
      `"typecheck": "tsc --noEmit"`.
- [ ] No lint config. This is a public repo taking contributions (`CONTRIBUTING.md` exists)
      with nothing to enforce a house style on a PR.

## 🟡 Cost and abuse surface

- [ ] Every turn calls the provider four times (three factions + narrator) every 10-15
      seconds, with no cap on turns, no token ceiling and no cost estimate anywhere in the
      docs. A reader who starts a game and walks away has an open-ended bill. At minimum,
      document the per-hour cost of the default Gemini config and add a max-turns setting.
- [ ] No rate limiting or retry/backoff on provider calls - a 429 mid-turn loses the turn.
- [ ] Game state is in-memory only, so a server restart drops every game in progress.
      Acceptable for local play; state it in the README rather than leaving it implied.

## 🟢 Game and docs

- [ ] Factions are named after real sitting heads of state. Fine for a satire piece, worth
      a deliberate decision rather than an inherited one now that the repo is public.
- [ ] `game/rules.md` and `game/tech-tree.json` are not referenced from the README, so the
      moddable parts of the game are effectively undiscoverable.
- [ ] Nuclear exchange is in the action list and in the screenshots but has no documented
      resolution rules - the one mechanic most readers will look for.
- [x] ~~Write TODO.md~~ ✅ done 2026-09-06
