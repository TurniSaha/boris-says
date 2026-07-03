# Contributing to Boris Says

Thanks for your interest. This is a small, dependency-free Claude Code plugin; the contribution
bar is simple: **`npm run gate` must stay green, and `dist/` must be rebuilt and committed.**

> **Historical names (legacy-safe, do not "fix").** The plugin is named **boris-says** (marketplace
> `boris-says`), but two internal names are kept for backward compatibility and must NOT be
> renamed: the user command is still **`/coach`**, and the on-disk state directory is still
> **`~/.claude/prompt-coach/`** (plus the `PROMPT_COACH_*` env vars). Renaming either would orphan
> every existing user's ratings, drafts, and kill-switch state. Treat these as historical.

## Setup

```bash
git clone https://github.com/TurniSaha/boris-says.git
cd boris-says
npm install        # dev dependencies only (typescript + vitest); ZERO runtime deps
```

Requirements: Node 18+ and a Claude Code login (for the live-firing parts; the test suite mocks the
LLM and needs no network).

## The gate (run this before every commit)

```bash
npm run gate       # = npm run build && vitest run
```

- **build** — `tsc` compiles `src/` → `dist/`.
- **test** — `vitest run` (all mocked; no network, no real LLM).

`dist/` is **committed on purpose** so that `/plugin install` needs no build step. Any change under
`src/` therefore requires `npm run build` and committing the regenerated `dist/` in the same commit.

## Repo layout

| Path | What |
|------|------|
| `src/` | the plugin source (TypeScript, ESM, strict, zero runtime deps) |
| `dist/` | the committed compiled output the installed plugin runs |
| `test/` | vitest unit/contract tests (mock the LLM + filesystem seams) |
| `hooks/hooks.json` | the `UserPromptSubmit` hook wiring (anchored to `CLAUDE_PLUGIN_ROOT`) |
| `commands/` | the `/coach` slash command |
| `.claude-plugin/` | `plugin.json` + `marketplace.json` (install manifests) |
| `docs/` | `SPEC.md` (design) and supporting notes |

## Conventions

- **Many small files** over few large ones; high cohesion, low coupling.
- **Immutable updates** — return new objects; never mutate the parsed state in place.
- **The hook never throws** — any error path is a silent no-op (exit 0). The judge runs detached.
- **Precision over recall** — the coach must rather stay silent than fire a weak tip. New levers
  need a test proving they DON'T over-fire on terse/expert/continuation prompts.
- **No new runtime dependencies.** The plugin ships with zero; keep it that way (hand-roll small
  utilities; `node:` built-ins are fine).
- **Tests are mocked.** Don't add tests that require a real `claude -p` call or network.

## Commit / PR notes

- Conventional-commit style messages (`feat:`, `fix:`, `docs:`, …).
- One logical change per commit; rebuild + commit `dist/` alongside `src/`.

## How to verify a change actually fires (not just green tests)

Green tests prove the code path; they do **not** prove the plugin wires up in a real session
(hooks register at session start). For any change to firing behavior, confirm it live: reinstall +
**restart Claude Code**, type a coachable prompt, and check the tip surfaces on your next prompt
(or use the `when life gives you lemons` liveness check). The most common bug class here is wiring,
not logic.
