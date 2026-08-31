# Contributing

Thanks for your interest. War Games is a small, fast-moving simulation: three LLM-driven
factions issue orders against a turn engine, and a narrator writes the recap. The bar for a
good PR is "it type-checks, a full game still runs end to end, and the AI contract survives".

## Getting set up

```sh
npm install                 # Node >= 20
cp .env.example .env        # add ONE provider key - Gemini is the cheapest default
npm run dev                 # client on :5173, server on :3001
```

Open http://localhost:5173 and click **Start Game**. If a game does not advance past turn 1,
the problem is almost always the provider key or a model returning prose instead of JSON -
check the server console before anything else.

## Before you open a PR

1. **`npm run build` must pass.** There is no test suite yet, so the type checker is the only
   automated gate this project has. Do not add `any` to get past it.
2. **Play a full game.** Turn resolution, combat, research, diplomacy and the nuke path all
   live in `server/engine.ts`, and a change to one of them routinely breaks another. Watching
   ten turns resolve catches more than any amount of reading will.
3. **Touched the AI layer?** Run at least two providers. `server/ai-provider.ts` abstracts
   Gemini, OpenAI and Anthropic behind one `generate(prompt)` call, and they disagree about
   JSON, refusals and token limits. A change validated on Gemini alone is half-validated.
4. **Docs move with code.** New env var, new order type, new faction behaviour? Update the
   matching table in `README.md` in the same PR.

## Ground rules that bite newcomers

- **Model output is untrusted input.** Everything a faction returns is parsed from free text
  into orders. Any new order type needs to fail closed on a malformed or hostile response -
  never assume the shape you asked for is the shape you got.
- **Every turn costs money.** The defaults (Gemini Flash, GPT-4o-mini), the compact JSON
  order format and the 15-second timeouts in `withTimeout` are cost controls, not style
  choices. A PR that makes prompts chattier or removes a timeout needs to say why.
- **Providers are configured per faction.** `NATO_AI_PROVIDER`, `RUSSIA_AI_PROVIDER`,
  `CHINA_AI_PROVIDER` and `NARRATOR_AI_PROVIDER` each fall back to the global `AI_PROVIDER`.
  Code that reads the global directly instead of the resolved per-faction value will look
  correct and behave wrongly in mixed-provider games.
- **`OPENAI_BASE_URL` is a supported path, not a hack.** Local models via Ollama, LM Studio
  or vLLM go through it. Don't hard-code `api.openai.com`.
- **State is in-memory.** There is no database. A restart is a new game, and anything you
  need across turns belongs in the game state object rather than in a module-level variable.

## Faction personas

The personas in `game/factions/` are prompt material, not decoration. They are written as
strategic doctrine because the models follow them; edits there change how the game plays far
more than an engine tweak usually does. Say so in the PR description if you touch one.

## Reporting bugs

Use the issue templates. The single most useful thing you can include is **which provider
each faction was running** and the server console output for the turn that broke - "the AI
did something weird" and "the parser rejected the AI's response" are different bugs here.

## Security

Never commit a `.env` or paste an API key into an issue. See
[SECURITY.md](https://github.com/NoblerWorks-HQ/.github/blob/main/SECURITY.md) for how to
report a vulnerability privately.
