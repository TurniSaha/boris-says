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
git clone https://github.com/TurniSaha/Claude-Coach.git
cd Claude-Coach
npm install        # dev dependencies only (typescript + vitest); ZERO runtime deps
```

Requirements: Node 18+ and a Claude Code login (for the live-firing parts; the test suite mocks the
LLM and needs no network).

## The gate (run this before every commit)

```bash
npm run gate       # = npm run build && npm test && npm run conformance
```

- **build** — `tsc` compiles `src/` → `dist/`.
- **test** — `vitest run` (all mocked; no network, no real LLM).
- **conformance** — a self-check that the design/feature claims match reality (`eval/build/`).

`dist/` is **committed on purpose** so that `/plugin install` needs no build step. Any change under
`src/` therefore requires `npm run build` and committing the regenerated `dist/` in the same commit.

## Repo layout

| Path | What |
|------|------|
| `src/` | the plugin source (TypeScript, ESM, strict, zero runtime deps) |
| `dist/` | the committed compiled output the installed plugin runs |
| `test/` | vitest unit/contract tests (mock the LLM + filesystem seams) |
| `hooks/hooks.json` | the hook wiring for all three events — `UserPromptSubmit`, `Stop`, `SessionEnd` (each anchored to `CLAUDE_PLUGIN_ROOT`) |
| `commands/` | the `/coach` slash command |
| `.claude-plugin/` | `plugin.json` + `marketplace.json` (install manifests) |
| `eval/` | the offline evaluation harness (blind judge, gold anchors, κ calibration) |
| `docs/` | `SPEC.md` (design) and supporting notes |

## Internal tag glossary (for reading the comments)

Comments and test names carry a few short internal tags from the build's milestone tracking. They
are labels for *when/why* a piece was added — not required to understand the code, but decoded here
so nothing reads as an undefined magic token:

| Tag | Meaning |
|-----|---------|
| `M1`–`M5` | Build milestones (M1 = relevance/matching, M2 = same-turn delivery, M5 = watch-first window, …). |
| `W2-OUTCOME`, `W2-LEVEL1`, `W2-MODELGATE` | Build-wave-2 feature tags (session-outcome recap, taste conditioning, model-aware gating). |
| `F-…`, `L01`/`L34b`/… | Individual coaching-lever IDs (a "lever" is one thing the coach can nudge about). |
| `GOAL.md` | The private product-goals doc the design was driven from (`docs/GOAL.md` in this dev repo; not shipped public). The invariants those comments cite (e.g. the prompt-intent relevance gate) are also specified in [`docs/SPEC.md`](docs/SPEC.md). |
| `SPEC §N` | A section of [`docs/SPEC.md`](docs/SPEC.md). |
| `PLAN §…`, `item N` | The private build/implementation plan the milestones were executed from (dev-repo only; not shipped public). The behavior each such comment describes is exercised by a test — read the test, not the plan. |
| `[A2]` | The same-turn Stop-hook drain design point: a well-formed turn writes a "judge-done" marker so the Stop poll can exit instantly instead of waiting out the drain cap (see `stop-hook.ts` / `judge.ts`). |
| `D1`–`D5` | Sub-steps of the M3 habit-draft path (draft eligibility, groundedness, per-mine cap, …) in `habit/miner.ts` / `habit/draft.ts`. |
| `Codex blocker #…` | A historical note from the build (an issue an assisting agent flagged, since resolved) — context only, nothing to action. |

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

- Conventional-commit style messages (`feat:`, `fix:`, `docs:`, `eval:`, …).
- One logical change per commit; rebuild + commit `dist/` alongside `src/`.
- This repo is single-remote on the gmail GitHub account — see [AGENTS.md](AGENTS.md) for the
  ratified commit-identity policy.

## How to verify a change actually fires (not just green tests)

Green tests prove the code path; they do **not** prove the plugin wires up in a real session
(hooks register at session start). For any change to firing behavior, confirm it live: reinstall +
**restart Claude Code**, type a coachable prompt, and check the tip surfaces on your next prompt
(or use the `when life gives you lemons` liveness check). The most common bug class here is wiring,
not logic.

## Releasing (MANDATORY: bump the version every time)

Claude Code caches an installed plugin by version and only re-copies from the marketplace when the
**version string changes**. If you ship new code under the same version, `/plugin update` reports
"already latest" and users silently keep running stale code. So **every release must bump the version**:

```
npm run version:bump          # patch (default): x.y.Z+1
npm run version:bump minor    # x.Y+1.0
npm run version:bump major    # X+1.0.0
```

This moves all four version fields in lockstep (`package.json`, `.claude-plugin/plugin.json`, and both
fields in `.claude-plugin/marketplace.json`). Run it as part of the same commit that ships code changes.
