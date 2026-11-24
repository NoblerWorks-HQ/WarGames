# Backlog

> Open items with no date and no owner action. **Still open, not archived.** Give an item a leading `YYYY-MM-DD`
> and the todo-budget hook moves it back to `TODO.md`. Fleet design: engineering-standards `todo-system.md`.

---

## Antigravity refactor audit (2026-11-23) - unverified

> Gemini fleet audit, not checked item by item: a 2026-11-24 spot check of 7 claims found 1 false. Read the code before acting; figures were not re-measured. Detail: engineering-standards `docs/REFACTOR-AUDIT-2026-11-23.md`, section "WarGames".

- [ ] [P1, L] 1,351L GameEngine god class mixing combat rules, LLM prompting, timers, and serialization
- [ ] [P2, M] Monolithic frontend entrypoints (src/main.ts 874L, src/flatmap.ts 612L, src/style.css 1182L)
- [ ] [P2, M] 502L monolithic server/ai-provider.ts and unvalidated Express POST payloads in server/index.ts
