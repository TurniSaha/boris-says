# boris-says — Unified Build-Ready Spec

> **What this document is.** This is the original **build-prompt artifact** — the design +
> implementation brief the plugin was built from, preserved verbatim for provenance and
> because it doubles as the authoritative design reference (data model, gates, cascade,
> privacy contract). It is written as instructions to the builder, so it refers to a private
> "upstream" source tree the plugin was ported from; that tree is **not public and not needed
> to run, read, or contribute to** the plugin. The shipped code in `src/` is self-contained.
> For a reader-facing tour start with the [README](../README.md); read on here for the full
> design rationale.

**Date:** 2026-06-22 · **Status:** design complete, build-ready (one-shot target) · **Repo:** `TurniSaha/boris-says`
**Author:** owner + Claude (Opus 4.8, 1M) · interview via `/grill-me`, 16 decisions locked
**Build method:** TDD, per-module Codex adversarial verify (the loop proven across the parent project).

> **Read §0.1 (Source of truth) FIRST.** This is a PORT, not a from-scratch build. The byte-exact text of
> several constants is load-bearing (prompt-cache discount + a documented bug fix depend on it). You MUST
> read the source files at the absolute paths given — do NOT reconstruct any ported text from memory.

---

## 0. What this is (read first — framing is load-bearing)

This is a **brand-new, second, standalone, open-source Claude Code PLUGIN.** It packages **one feature**
of an existing larger product (the upstream coach service's per-developer prompt + habit coach) as a clean, zero-infra
product that any Claude Code user can install via a self-hosted single-plugin marketplace (§10, §11).

**It strips nothing from anything.** The larger product (its Team-PM brain, server, Postgres, firehose,
VS Code extension) stays 100% intact and is irrelevant here. This plugin **copies** the already-pure,
already-tested *brain* of the per-dev coach and gives it a new local-only body. There is no server, no
database, no network service of our own — only the user's machine and (optionally) Anthropic's API.

Because the scope is **one developer on their own machine**, local data is strictly *better* than the
server ever had: Claude Code already writes the complete session transcript to disk, so the coach reads
the source of truth instead of a lossy reconstruction.

### The three pillars (all pure judgment over LOCAL data, zero infra)

1. **Per-prompt quality judge** — for each typed prompt, judge whether the developer's *prompting/process*
   is thin (no plan, no acceptance criteria, big unscoped surface, wrong effort/skill) and, if so, surface
   a short coaching tip. Reflex gate → Haiku prospector → Sonnet judge.
2. **Capability awareness** — inside that same tip, when it fits, name *one* Claude Code capability the
   developer may not know exists (`/design-sync`, plan mode, `ultrathink`, `--effort xhigh`, "make a
   subagent", …), gated to what is actually available on *their* machine + CLI version.
3. **Cross-session habit coach** — mine the developer's *entire local prompt history* for recurring typed
   behaviors that have a concrete process/tooling fix, and when the behavior recurs, surface a one-shot
   cited nudge (canonical: "you've asked for a next-session prompt in your last 3 sessions — want to bake a
   prompt-handoff into your `/context-handoff`?").

---

## 0.05 Duplication & the shared-brain question (a deliberate, locked decision)

This plugin **copies ~10 pure "brain" files** from the live upstream coach service (`pm-service` + the
extension) into its own tree (the §0.1 map). That is **intentional duplication, decided knowingly** —
NOT an accident to "fix" by wiring the plugin back into the server:

- **Decision (LOCKED): copy now, share later.** Fork the brain into the plugin so the standalone, zero-infra
  OSS product can ship without refactoring the live product (pm-service 0.4.60 stays untouched). If BOTH
  products keep evolving the brain, LATER extract the pure core into a shared package both import. Do not
  block this build on that extraction.
- **The copy is already DIVERGING, by design.** The §5.5 quality edits, the friction-mined habits, the
  local-only state, the CLI-default backend, and the dropped server seams (§13) make the plugin's brain
  meaningfully different from the server's. Treat the source as a *starting point to port + then harden*,
  not a mirror to keep in sync.
- **Builder rule:** the plugin has NO dependency on the upstream coach service at runtime. You COPY the named symbols from
  the source tree at build time (§0.1) into the plugin's own files; after that the source tree is irrelevant.
  Never `import` from, call, or network to anything in the upstream coach service. (If a future "shared package"
  extraction happens, it will be its own project; v1 is a self-contained copy.)

## 0.1 Source of truth (the canonical port source — READ THIS BEFORE WRITING CODE)

**Canonical source root (absolute):** the private upstream coach service tree (a local path on the
author's machine, redacted here — this is a private, non-public source that is not required to build, run,
or contribute to this plugin; the ported symbols are already committed under `src/`).

All ported logic comes from that tree. The build target (`boris-says`) is a FRESH, empty repo — it has
none of these files. You MUST open each source file at the absolute path below and copy the named symbols
**byte-for-byte**. Do NOT reconstruct any of them from memory: the Anthropic prompt cache (the system
block is sent with `cache_control:{type:'ephemeral'}` in `anthropic.ts`, verified) and the documented
silenced-coach / capability-resolver fixes all depend on byte-identical text.

### File-by-file source → destination map (13 ported files)

| # | Source (under canonical root) | Destination (under `boris-says/`) | Key symbols to copy verbatim |
|---|---|---|---|
| 1 | `pm-service/src/triggers/prompt-coach-skill.ts` | `src/brain/prompt-coach-skill.ts` | `PROSPECTOR_SYSTEM`, `JUDGE_SYSTEM`, `RUBRIC_DIMENSIONS` (9 entries), `FIRING`, `PROSPECTOR_ESCALATE_BAND`, `INTERRUPT_ELIGIBLE_PHASES`, `PROMPT_COACH_SKILL`, `buildProspectorUser`, `buildJudgeUser` |
| 2 | `pm-service/src/triggers/judge-reflex.ts` | `src/brain/judge-reflex.ts` | the reflex predicate + `TRIVIAL_CHAR_LIMIT=24` (private const, line 19) + the three phrase sets |
| 3 | `pm-service/src/triggers/judge-dispatch.ts` | `src/brain/judge-cascade.ts` | `parseJudgeVerdict`, `parseProspectorScore`, the cascade body (server seams removed — §5, §15); constants `MAX_TRANSCRIPT`, `PROSPECTOR_MAX_TOKENS`, `JUDGE_MAX_TOKENS` |
| 4 | `pm-service/src/triggers/coach-liveness.ts` | `src/brain/coach-liveness.ts` | `COACH_SENTINEL_PHRASE`, `COACH_SENTINEL_REPLY`, `COACH_CONNECTED_PING`, `isCoachSentinel`, `createCoachLiveness` (re-key §15) |
| 5 | `pm-service/src/triggers/capability-catalog.ts` | `src/capability/catalog.ts` | `CAPABILITY_CATALOG` (25 entries, §20), `resolveCapability`, `CapabilityPerson`, `Capability`, `CapabilityKind`, cost-clause consts |
| 6 | `pm-service/src/triggers/version.ts` | `src/capability/version.ts` | `satisfiesMinVersion` (fail-closed on null/unparseable) |
| 7 | `pm-service/src/coach/mailbox-nudge.ts` | `src/brain/mailbox-format.ts` | `formatCoachBanner` + helpers ONLY (extraction scope §14); DROP the in-memory FIFO |
| 8 | `pm-service/src/llm/anthropic.ts` | `src/llm/anthropic.ts` | the raw-fetch provider with `system:[{...,cache_control:{type:'ephemeral'}}]`; adapt return/throw per §6 |
| 9 | `pm-service/src/llm/models.ts` | `src/llm/models.ts` | model id constants (update stale ids per §9) |
| 10 | `upstream-extension/src/installed-commands-scan.ts` | `src/capability/scan-commands.ts` | `scanInstalledCommands(): Promise<string[]>` (5 plugin roots, `.opencode`/`docs` excluded, nested→leaf id, cap 200) |
| 11 | `upstream-extension/src/claude-version.ts` | `src/capability/claude-version.ts` | `claudeCliVersion(): Promise<string \| null>` (`claude --version`, 5s timeout, leading-semver parse) |
| 12 | `upstream-extension/src/installed-skills-scan.ts` | `src/capability/scan-skills.ts` | the installed-skills scanner (for the merged skill catalog) |
| 13 | `upstream-extension/src/terminal-parsers/claude-line-parser.ts` | `src/jsonl/line-parser.ts` | the THREE-tier typed gate: top-level `o.type==='user'` dispatch (line 38) → `parseUserLine` (line 45) → `promptSource !== 'typed'` (line 47) → nested `message.role !== 'user'` (line 51) |

> The current upstream coach hook itself is NOT a plugin and is NOT ported: it is
> `upstream-extension/src/claude-prompt-hook.ts`, a VS Code extension that plants a server-POST
> `UserPromptSubmit` command into a project-local `.claude/settings.json`. We read it ONLY to confirm the
> stdin contract (§3, §8) — it shows the prompt text is taken from stdin `o.prompt || o.user_prompt`
> (`claude-prompt-hook.ts:86`), which is exactly what our judge does. We do NOT port its server POST body.

### Byte-stability verification (prove it, don't assume it)

For each load-bearing constant, the builder MUST prove the ported text is byte-identical to source. Add a
build step / test that extracts the string from the source file and the ported file and compares a
SHA-256 (or a literal diff). REQUIRED for: `PROSPECTOR_SYSTEM`, `JUDGE_SYSTEM`, and the full ordered
`RUBRIC_DIMENSIONS` id list. Example check (run once at build):
```sh
# from the canonical root and the new repo respectively, extract the constant body and compare hashes
node -e 'process.stdout.write(require("./extract").PROSPECTOR_SYSTEM)' | shasum -a 256
```
If the checksums differ, the cache discount is silently broken — fix the port, do NOT edit the source.
(NOTE: §5.5 edits the `JUDGE_SYSTEM` / `PROSPECTOR_SYSTEM` text deliberately for calibration — checksum
the BASELINE port first to prove a clean copy, THEN apply §5.5 edits and bump `PROMPT_COACH_SKILL.version`.)

---

## 1. The load-bearing data fact (verified on real disk)

Claude Code writes one JSONL file per session at:
```
~/.claude/projects/<slug(cwd)>/<session-id>.jsonl
```
where `slug(cwd)` = the working directory with every run of non-alphanumeric chars replaced by a single
`-` (e.g. `/home/me/projects/example` → `-home-me-projects-example`).

Each line is a JSON object. **The ONLY reliable discriminator for a genuine human-typed prompt is
`promptSource === "typed"` (STRICT equality).** Verified empirically on real transcripts.

### The full observed `promptSource` universe (point-in-time; will drift)

A user line carries one of **four** `promptSource` values. Live counts in `~/.claude/projects` as of
2026-06-22 (approximate, point-in-time): `typed` ≈ 723, `system` ≈ 734, `queued` ≈ 35, `sdk` ≈ 22. The
parser/miner gate is **strict equality** — a line counts as a human-typed prompt ONLY when
`promptSource === 'typed'`. That single gate already excludes `system`, `queued`, AND `sdk`, so
`claude-line-parser.ts:47` (`if (o.promptSource !== 'typed') return []`) is **correct as-is and MUST NOT
be "fixed."**

**The gate is actually THREE tiers, in this precedence (port all three — do NOT collapse to the
`promptSource` check alone):**
1. **Top-level type dispatch** — `claude-line-parser.ts:38`: the parser routes on `o.type === 'user'`
   BEFORE any nested inspection (`if (o.type === 'user') return parseUserLine(o)`). A line without
   top-level `type:'user'` is never a prompt.
2. **Top-level promptSource gate** — `claude-line-parser.ts:47`, INSIDE `parseUserLine`:
   `if (o.promptSource !== 'typed') return []`.
3. **Nested role guard** — `claude-line-parser.ts:51`: then `if (o.message.role !== 'user') return []`
   (a secondary guard on the nested message object).

A user line is a typed prompt **ONLY when all three hold**: top-level `o.type === 'user'` AND top-level
`o.promptSource === 'typed'` AND nested `o.message.role === 'user'`. (Note the in-function order is
`promptSource` THEN nested `role` — preserve it on port.) Conscious v1 product decision for each non-typed
`promptSource` value:

| `promptSource` | meaning | v1 decision | rationale |
|---|---|---|---|
| `typed` | real typed human prompt (content is a string) | **MINE / JUDGE** | the coachable unit |
| `system` | slash/command expansion (`<command-message>`) + system injections | **EXCLUDE** | this is exactly why the coach is blind to slash invocations (a known, accepted limitation) |
| `sdk` | programmatic/SDK-injected payload (e.g. a Mission Control launch briefing) | **EXCLUDE** | not human habit signal |
| `queued` | HUMAN-typed prose the dev queued while Claude was busy (e.g. "whats the difference betwene procy and direct") | **EXCLUDE (v1)** | out-of-turn, often half-formed interjections; the habit thesis keys off deliberate in-turn prompts. Matching the existing `=== 'typed'` gate keeps the corpus consistent and avoids a code change. **Revisit:** if recurring-habit recall proves too sparse, `queued` is the most defensible value to fold in later. |

Other line shapes (NOT user prompts): `content:[{type:"tool_result"}]` + `toolUseResult` → tool result
(NO); `message.role==="assistant"` → agent output (NO as a "prompt"; read for transcript context only).

**Consequence:** slash commands (built-in AND custom, including `/context-handoff`) are **invisible** as
typed prompts. The habit coach therefore triggers off recurring **typed prose** only; its suggested *fix*
may still name a slash command (that is just advice text). This is identical to the server-era finding and
is now re-confirmed against the local JSONL. Port the gate verbatim (see §7, `jsonl/line-parser.ts`).

There are **400+ session files** across all project dirs on the reference machine today — a rich corpus the
firehose could never reliably supply (a live 2-person firehose test delivered ~1 of N prompts).

---

## 2. Architecture (the spine)

```
┌─ Claude Code session ───────────────────────────────────────────────┐
│                                                                      │
│  user hits Enter ─▶ UserPromptSubmit hook fires                      │
│                     (node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js")      │
│                        │                                             │
│      (1) DRAIN: read mailbox/<session>.json → if a tip is waiting,   │
│          print it to the human (stdout) and clear it. <100ms.        │
│                        │                                             │
│      (2) DETACH: write the stdin payload to a per-invocation inbox   │
│          file, spawn a background judge process (detached, unref),   │
│          pass ONLY the inbox file path as argv[2], then exit 0.      │
│                        │                                             │
│                        └─▶ background judge (node dist/judge.js):    │
│                              • read+unlink the inbox file (payload)  │
│                              • current prompt text := stdin `prompt` │
│                              • read THIS session's .jsonl ONLY for   │
│                                the preceding transcript context      │
│                              • run the cascade → maybe write tip     │
│                              • check habit-pattern match → maybe     │
│                                queue habit tip                       │
│                              • check miner throttle → maybe mine     │
│                                ALL ~/.claude/projects/*/*.jsonl      │
└──────────────────────────────────────────────────────────────────────┘

State (plain JSON, atomic writes) under ~/.claude/prompt-coach/:
  inbox/<session-id>-<monotonic>.json — hook→judge payload hand-off (write-temp-rename; judge unlinks)
  mailbox/<session-id>.json           — per-session tip hand-off (drain→print next turn)
  patterns.json                       — discovered habits (open|surfaced|dismissed)
  state.json                          — miner watermark, last-mine-at, cooldown timestamps, enabled flag
  catalog.json                        — capability catalog (refreshable data, not code)
```

**Felt experience:** the developer never waits. A tip about prompt *N* appears attached to prompt *N+1*.
This is the server's proven next-turn cadence, now with zero network round-trip.

### Why next-turn, not same-turn
The cascade can take 5–8s (two LLM calls). A `UserPromptSubmit` hook blocks the turn until it exits, so a
synchronous cascade would freeze the prompt. Decision #1: the hook returns instantly; judging happens in a
detached background process; the verdict is delivered on the next prompt.

### Why one script (decision #2)
One `UserPromptSubmit` hook does both jobs (drain + detach-judge). No second hook, no daemon. The mailbox
file is the hand-off between consecutive hook fires.

---

## 3. The 16 locked decisions (do NOT re-litigate)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Next-turn, non-blocking** delivery | hook must never freeze the prompt |
| 2 | **One `UserPromptSubmit` script** (drain + detach-judge) | simplest, fewest moving parts |
| 3 | **Hybrid LLM backend** behind one interface | zero-setup for everyone + best fidelity when a key exists |
| 4 | **Node, ship compiled JS** (`tsc`→`dist/`) | reuse ported TS + tests where possible |
| 5 | Per-prompt judge: current prompt from **stdin `prompt`**; session `.jsonl` (stdin `transcript_path`) for **prior transcript only** | stdin is authoritative for the current turn; file may not be flushed (§4) |
| 6 | Habit scope = **all projects, global to the one user** | habits are person-level; collapses room/user keying |
| 7 | Miner trigger = **piggyback the hook, throttled** | no daemon; ~once/24h when active |
| 8 | Habit vs quality = **separate cadence, quality wins a tie** | faithful to source spec §6 |
| 9 | State = **plain JSON files** under `~/.claude/prompt-coach/` | single-user, debuggable, zero-dep |
| 10 | Outcomes = **surface-once auto + `/coach` slash command** | no buttons in a terminal |
| 11 | Capability = **refreshable `catalog.json`**, local scan, judge picks one, skill wins tie | first-hand local data |
| 12 | Repo = **fresh standalone OSS repo on TurniSaha (gmail)**, single-owner | "on turnisaha not on org" |
| 13 | Recursion guard = **`PROMPT_COACH_JUDGING=1` + hooks-suppressed `claude -p`** | prevent cost runaway |
| 14 | Cost v1 = **reflex+cooldown gates + `/coach off` + README note**; CLI backend (`claude -p --bare`) is the DEFAULT — no per-call charge on a subscription (§6.3); raw API is opt-in via `PROMPT_COACH_USE_API` | proven gating; adaptive ledger dropped in v1 (§9b) |
| 15 | Tip surface = **plain stdout to the human, NOT fed to the agent's task** (§8.2) | a prompting tip must not steer the agent |
| 16 | v1 = **all 3 pillars** | shared brain/hook/mailbox/backend |

---

## 4. Where the current prompt comes from (CRITICAL — read before §5)

`UserPromptSubmit` fires **before** Claude Code has necessarily flushed the current prompt to the session
`.jsonl`, and for the FIRST prompt of a fresh session the `.jsonl` may not yet exist. Verified against a
live JSONL: the file tail interleaves system/attachment/assistant/`last-prompt`-pointer entries, so the
just-typed prompt is **NOT** reliably the last written line, and may not be present at all when the
detached judge reads the file.

**Therefore (mirrors the proven server hook `claude-prompt-hook.ts:86`):**

- The **current prompt text** the cascade/matcher judge MUST come from the hook **stdin payload field
  `prompt`** (fallback `user_prompt`). This is `verbatim`. It is supplied to the judge in-memory via the
  inbox file (§8); it is NEVER re-derived from the `.jsonl`.
- The session `.jsonl` (path from stdin `transcript_path`) is read **ONLY** to assemble the **preceding
  transcript context** — the prior typed prompts, current one excluded.

This is exactly what the shipped cloud judge does: `verbatim = candidate.text` (the in-hand event text),
and the transcript is the *prior* prompts (`judge-dispatch.ts:409-412`). Do NOT read "the last typed line
in the file" to get the current prompt — that misses every first-prompt-of-session and races mid-session.

---

## 5. Pillar 1 — the per-prompt quality judge

### 5.1 The cascade (ported from `judge-dispatch.ts` → `brain/judge-cascade.ts`, server-stripped)
Run in the background judge for the **just-typed prompt supplied via stdin `prompt`** (NOT re-read from
the file — §4). Server seams (repos, dispatcher, retrieval, rate-limit, ledger, liveness keying) are
replaced by local equivalents; the *logic and thresholds* are unchanged. The new exported contract is
pinned in §15. The CALIBRATION refinements to the ported brain live in §5.5.

1. **Liveness (zero cost)** — port `coach-liveness.ts`. Sentinel phrase
   `when life gives you lemons` → reply `make lemonade!` (exact, normalized match, fires EVERY time,
   short-circuits the cascade). First-prompt-of-session connection ping (one-time, ADDITIVE — the cascade
   still runs on turn 1). **Re-key:** the source `check(roomId, sessionId, text)` keys first-seen pings on
   `roomId + sessionId` (`coach-liveness.ts:96`); locally `roomId` is dropped (decision #6) so the de-dup
   key becomes `sessionId` alone — change the signature to `check(sessionId, text)` (do NOT merely drop the
   param; name the surviving key).
2. **Tier-0 reflex (pure, no LLM)** — port `judge-reflex.ts` verbatim. Suppresses trivial continuations
   (`yes`, `go`, `next`…), approvals, and trivial fixes (`fix the typo`, `rename`…). Exits ~60–70% of
   prompts before any LLM call. `TRIVIAL_CHAR_LIMIT = 24` is a PRIVATE const (line 19) — do NOT import it;
   assert reflex behavior at the boundary (≤24 chars trivial vs >24 not). The three phrase sets verbatim.
   (§5.5.5 raises the limit + adds an intent regex — apply as a CODE edit there.)
3. **Tier-0 cadence** — per-prompt cooldown via `state.json` (replaces the server's `JudgeRateLimit`).
   Default **10 min** between quality tips. If within cooldown → silence. (v1 uses a STATIC floor — §9b.)
4. **Context assembly** — the just-typed prompt comes from the stdin `prompt` field (§4); the session file
   supplies ONLY the preceding transcript (the prior typed prompts, `MAX_TRANSCRIPT=8`, oldest-first,
   current prompt excluded). See §7.1 for the exact `session-reader` contract. Plus the merged skill
   catalog (installed-skills scan) and the available-capabilities list (§17).
5. **Tier-1 Haiku prospector** — call the backend with `PROSPECTOR_SYSTEM` (byte-verbatim baseline; §5.5
   edits) and `buildProspectorUser(verbatim, transcript)`. Guard null first:
   `if (prospect === null) { observe('prospector_unavailable', false); return; }` (§6.2). Then parse with
   `parseProspectorScore(prospect)`. `PROSPECTOR_ESCALATE_BAND = 0.25`: below → SILENCE; at/above →
   escalate. `PROSPECTOR_MAX_TOKENS = 8`. Fail-OPEN on parse failure (escalate), preserving source semantics.
6. **Tier-2 Sonnet judge** — call the backend with `JUDGE_SYSTEM` (byte-verbatim baseline; §5.5 edits) and
   `buildJudgeUser(verbatim, transcript, rollingSummary='', catalog.all, availableCapabilities)`. One call:
   classify phase, score the rubric, pick the primary lever, decide interrupt, compose the nudge, fill
   `skill_fit` + `capability_fit`. `JUDGE_MAX_TOKENS = 600`. Guard null first:
   `if (judgment === null) { observe('verdict_malformed', false); return; }` (§6.2). Then parse with
   `parseJudgeVerdict(judgment)` (verbatim — finds first `{...}`, fail-CLOSED on parse error).
7. **Firing gate** — interrupt-eligible phase (`INTERRUPT_ELIGIBLE_PHASES = {new-task, escalation,
   ambiguous}`) AND `confidence >= skill.preRunConfidence` (= `FIRING.PRE_RUN_CONFIDENCE` = **0.6**, the
   STATIC floor — v1 drops the adaptive `thresholdFor`, §9b) AND a non-empty `missing_piece` AND a
   non-empty `nudge` AND **the same primary-lever not already used this session** (LOCAL definition below).
   `NUDGE_CAP = 500` chars (with `COST_CLAUSE_RESERVE = 60` headroom for the capability cost clause).
   - **NO aggregate ceiling.** The source gate ALSO required `nudgeLedger.tryConsume`
     (`judge-dispatch.ts:502`, with a refund-on-dispatch-failure at `:567`) — a per-PERSON aggregate
     window backed by the server `NudgeLedger`. v1 has **no local store** for it, so the aggregate-ceiling
     clause is **REMOVED entirely** (and `NudgeLedger` + its refund path are dropped — §13). The
     reflex/cooldown gates (step 2–3) plus §5.5 precision are how v1 bounds fires.
   - **Same-lever suppression is LOCAL.** The source `rateLimit.leverUsedInSession` /
     `recordLever` (`judge-dispatch.ts:495,392`) keyed on `candidate.sessionId`. Reimplement it as a
     per-`sessionId` set persisted in `state.json` (e.g. `state.leversUsedBySession[sessionId]: string[]`):
     before firing, drop if `lever ∈ leversUsedBySession[sessionId]`; on a successful deposit (step 8),
     append `lever` to that set in the SAME atomic `state.json` write that marks the quality cooldown.
     `sessionId` is the surviving local identity (decision #6) — there is no `roomId`/`userId`.
8. **Resolve affordance + deposit** — resolve skill action and capability (SKILL WINS over capability when
   both fit — `judge-dispatch.ts:505-520`). Compose the tip, write it to `mailbox/<session>.json`
   (kind: `quality`). In ONE atomic `state.json` write: mark the quality cooldown AND append the fired
   `primary_lever` to `leversUsedBySession[sessionId]` (step 7 local same-lever set). Record NO outcome
   row, NO aggregate-ledger slot (§9b, §13).

### 5.2 Rubric & prompts (ported from `prompt-coach-skill.ts`, PURE — copy verbatim)
- `RUBRIC_DIMENSIONS` (**9**, in this exact order — matches `prompt-coach-skill.ts:60-80`): `goal_clarity`,
  `scope_boundaries`, `context_sufficiency`, `process_fit`, `acceptance_criteria`, `risk_awareness`,
  `verification_path`, `effort_level_fit`, `skill_fit`.
- `PROSPECTOR_SYSTEM`, `JUDGE_SYSTEM` — byte-stable strings (the cache discount + tuning depend on this;
  prove with the §0.1 checksum step on the BASELINE before applying §5.5 edits).
- Thresholds are NOT bare exports. They live in `FIRING` (`prompt-coach-skill.ts:148-161`) and are
  re-exposed on `PROMPT_COACH_SKILL` as `preRunConfidence` (= `FIRING.PRE_RUN_CONFIDENCE` = **0.6**) and
  `postMinConfidence` (= `FIRING.POST_MIN_CONFIDENCE` = **0.45**). Tests reference
  `FIRING.PRE_RUN_CONFIDENCE` or `PROMPT_COACH_SKILL.preRunConfidence` — there are NO
  `PRE_RUN_CONFIDENCE`/`POST_MIN_CONFIDENCE` top-level exports to import.
- `PROSPECTOR_ESCALATE_BAND = 0.25`, `INTERRUPT_ELIGIBLE_PHASES = new Set(['new-task','escalation','ambiguous'])`.
- `PROMPT_COACH_SKILL` versioned artifact (`version: 'prompt-coach@1'`). Bump the version whenever §5.5
  edits `JUDGE_SYSTEM`/`PROSPECTOR_SYSTEM`/any firing constant.

### 5.3 Display (extracted from `pm-service/src/coach/mailbox-nudge.ts` → `brain/mailbox-format.ts`)
See §14 for the EXACT extraction scope. Extract ONLY the formatting half: `formatCoachBanner` (line 92) +
its helpers `panelLine` (64) and `wrapBody` (70) + the private consts they depend on: `ESC` (54),
`RESET` (55), `PANEL_WIDTH = 50` (56), `TITLE` (59), `BODY` (61). Behavior: `formatCoachBanner` calls
`wrapBody(message, PANEL_WIDTH)` FIRST (soft-wrap to ≤50 cols), then `panelLine` pads short lines to 50
(`padEnd`) and only CLIPS (`slice(0,50)`) a single un-splittable token longer than 50 chars (a defensive
backstop). Port both helpers so the wrap-then-pad/clip contract is preserved. ANSI survives the hook
stdout path; the stripped fallback still reads as a padded block.
**DROP everything from line 104 onward** — `QUEUE_CAP`, `TTL_MS`, `MAX_KEYS`, `KEY_SEP`, `QueuedNudge`,
`MailboxNudge`, `createMailboxNudge` (the in-memory FIFO) — replaced by the on-disk mailbox store.

---

## 5.5 Coaching Quality — accuracy, usefulness, and calibration

> Everything here is a refinement of the *already-ported* brain. **All prompt edits in this section are
> DATA edits to `PROMPT_COACH_SKILL` in `src/brain/prompt-coach-skill.ts`** — the artifact is versioned and
> the version string rides into every local outcome record (§5.2). Bump `PROMPT_COACH_SKILL.version`
> whenever you change `JUDGE_SYSTEM`, `PROSPECTOR_SYSTEM`, or any firing constant. A handful of edits are
> CODE gates in `judge-cascade.ts` (ex `judge-dispatch.ts`) / `judge-reflex.ts` / `scan-skills.ts` (the
> curated-skills list) / the capability shape; those are called out explicitly. NOTE on dropped seams: §9b
> drops the per-dev adaptive threshold and `coaching_outcomes`; where this section mentions a per-dev
> raisable threshold or an outcome record, treat the firing floor as the STATIC `PRE_RUN_CONFIDENCE` (0.6)
> and the version-attribution intent as satisfied by `PROMPT_COACH_SKILL.version` alone.

### 5.5.0 The QUALITY BAR (load-bearing — this governs every decision below)

**Precision over recall. A false fire that annoys an expert is strictly worse than a missed coachable prompt.** The evidence is concrete and one-directional: across every quality scenario the same failure dominates — *two or three bad nudges and the coach gets uninstalled* ("I TOLD you to stop"). A missed thin prompt costs the dev nothing they didn't already lack; a confidently-wrong nudge actively destroys trust and proves the coach didn't read the room. Therefore:

1. **When in doubt, stay silent.** The firing gate (§5.1 step 7) is fail-closed by construction (`parseJudgeVerdict` → null → silence; empty `missing_piece` → silence). Every ambiguity below resolves toward silence, never toward a marginal fire.
2. **Never be confidently wrong.** Two species: (a) advice that contradicts a rationale the dev already stated in the prompt (justified hand-roll, named method, pre-empted dimension), and (b) advice that names a thing the dev cannot use (a launch-only flag mid-session, an Opus-only flag on Codex, a command the scan never confirmed). Both are treated as defects, not style nits.
3. **Respect expert terseness.** A terse prompt that names a pinned version, a precise bug class, a disciplined method, or a verification step is *sound engineering*, not a thin prompt. The judge must read the content, not the character count.
4. **Specific, not fortune-cookie.** When the coach DOES fire, the nudge must name the single most consequential undecided choice as a concrete question or a concrete safety step — never a category ("scope it down", "add more detail").
5. **The coach scores PROMPT/PROCESS quality, never outcomes and never architecture taste.** AI errors are never a coaching signal; controller-vs-model is the dev's call. (Reaffirms §0 + the file header.)

This bar is the tie-breaker for every edit that follows. Where a fix could raise the fire-rate on benign prompts, it is rejected or narrowed.

---

### 5.5.1 Phase-classification hardening (mid-session: escalation hidden as continuation)

The single most dangerous classifier failure: a scope/risk **escalation** camouflaged as a casual continuation. The judge's STEP 1 exemplars weaponize the surface form `"now also X"` as a *continuation* signal, but `"now also do it in prod"` / `"now also for all 4M rows"` is exactly how a real prod migration is phrased. Classifying by the connective instead of the stakes is the camouflage gap.

**Edits to `JUDGE_SYSTEM` STEP 1 (all DATA):**

- **Escalation definition, append:** "escalation = raises stakes/scope sharply (a migration, an auth change, a rewrite, OR touching production data / deletes / multiplying blast radius). A turn that opens like a continuation (`now also...`, `and then...`, `X too`) but sharply raises stakes is an ESCALATION, not a continuation — classify by the STAKES of the NEW work, not by the connective phrase."
- **Tie-break, add after the five phase definitions:** "If a turn both continues prior work AND sharply raises stakes, classify it ESCALATION (the higher-stakes phase always wins the tie)."
- **Worked contrast pair, add:** "`now also add the logout flow` = continuation (more feature work, same blast radius). `now also backfill that column for all 4M rows in prod` = escalation (prod data migration, large blast radius, no plan stated)."
- **Connective-neutrality line, add:** "Ignore the opening connective (now/also/and/then) — it appears in continuations AND escalations and carries no signal; classify only on whether the WORK is grounded in the recent transcript and on its stakes."

**Scope guard (keeps benign continuations silent):** the escalation trigger is the **STAKES list** (prod data, migration, auth, deletes, blast-radius multiplication), NOT the connective. A terse `"now the logout flow too"` still has no stakes keyword → stays continuation. This closes the camouflage without raising the fire-rate on ordinary continuations. **No threshold/code change.**

**Reciprocal direction (continuation must survive established risky work):** a prompt that *proceeds with* migration/auth/data work already established in the recent transcript is a **continuation**, not an escalation — escalation requires NEWLY raising stakes. Add to STEP 1: "A prompt that PROCEEDS with migration/auth/data work already established in the recent transcript is a CONTINUATION; escalation requires NEWLY raising scope/stakes, not continuing established risky work." Also extend the continuation definition so the judge may treat the dev's rolling profile/summary as continuation evidence: "...established in the transcript OR the developer's rolling profile/summary above." This protects `"ok run the migration"` after three turns of migration planning, and `"now run the down migration and confirm the rollback is clean"`, even when the planning turns have scrolled past `MAX_TRANSCRIPT=8`.

**Perf-anchor note, add to continuation/new-task definitions:** "A bare optimize/speed-up/`make it faster` ask is a CONTINUATION when the recent transcript shows profiling, a flamegraph, or benchmark output identifying the target; classify it new-task ONLY when no such perf context exists." (Phase, not score, controls eligibility — `eligiblePhase` is checked before confidence in the cascade, so this is the correct lever for the "make it faster after a flamegraph" anchored-expert case.)

---

### 5.5.2 External-referent anchoring (don't coach context you can't see)

A terse first prompt that names a **resolvable external referent** — a ticket id (`PROJ-412`, JIRA-style keys), a file path, a URL, a named doc, or an explicit prior decision ("the way we discussed in standup") — is **anchored**, not under-specified. The agent will open it. Coaching the dev to "define done" for a ticket whose definition of done lives in the artifact you cannot see is the classic annoying false-fire.

**Edits (DATA):**
- **`JUDGE_SYSTEM` STEP 1 / STEP 6, add:** "If the prompt names a resolvable external referent the agent can fetch on its own (a ticket id, file path, URL, named doc, or explicit prior decision), treat that context as ANCHORED, not missing. Do NOT classify the prompt `ambiguous` on that basis, and do NOT raise goal_clarity / acceptance_criteria / context_sufficiency as the missing_piece — the definition of done lives in the artifact you cannot see. Silence unless there is a SEPARATE, prompt-visible process weakness (e.g. a risky migration with no plan)."
- **`RUBRIC_DIMENSIONS.context_sufficiency.probe`, amend** so it is not transcript-only: "...Terse is FINE when the context is anchored in recent turns OR when the prompt points at a fetchable external artifact (ticket/file/doc/URL/prior decision) the agent can open itself."

Do **not** add a per-phase firing floor (there is no per-phase floor; firing is one `PRE_RUN_CONFIDENCE`). If pilot tuning is wanted, the clean global lever is reverting `PRE_RUN_CONFIDENCE` from the PILOT-LOUD `0.6` toward the documented BALANCED `0.8` (a `PROMPT_COACH_SKILL` data edit) — a separate cadence decision.

---

### 5.5.3 The single-lever rule stays — but the nudge must be SPECIFIC

The verdict keeps **one `primary_lever`** for clean analytics. We do **not** add a "no-blend" exception. Instead, two narrow `JUDGE_SYSTEM` edits make the one sentence the dev sees carry the full value:

- **STEP 7 (nudge composition):** for escalation/new-task phases scored low on `verification_path`, REQUIRE the one-sentence nudge to append a safety clause ("...and pin current behavior with a characterization test first"). This delivers both the process gap AND the verification gap in one sentence while the analytics lever stays single. (Covers the "refactor this whole module" big-bang case: `process_fit` lever + verification clause.)
- **STEP 7, bounded enumeration is allowed:** the nudge MAY name 2–3 concrete sub-decisions *within* the one lever (a bounded enumeration is not a "blend" of dimensions). It MUST name the SINGLE most consequential undecided choice as a CONCRETE QUESTION, not a category. **Banned-phrasing bank** (add verbatim, analogous to the prospector's worked HIGH/LOW): "add more detail", "scope it down", "decide what it shows". Example of the required shape: for "build a dashboard" → "what's the one data source and 2-3 metrics this dashboard shows first?" Permit `process_fit` as the lever for a sprawling new-task so a "sketch the data contract + key views first" nudge is reachable.

**Risk-surface override (DATA, add after STEP 3):** "RISK-SURFACE OVERRIDE: when the prompt opens work on an explicit risk surface (auth, migrations, payments, user/PII data) and that surface is unaddressed (no method, scope, or threat-model named), set primary_lever = risk_awareness UNLESS another dimension is strictly more severe; and in EITHER case the nudge MUST name the highest-risk unaddressed surface (e.g. `auth touches sessions, token storage, and every protected route — pick a method and scope the surfaces before diving in`), even when the chosen lever is scope_boundaries." This makes lever choice deterministic for the costliest family AND forces the security framing into the single sentence regardless of which lever wins (covers naked `"add auth"`).

**Trivial-task lever guard (DATA, add after STEP 3):** "Never make effort_level_fit the primary_lever on a small or trivial task; effort mismatch is only a lever on a genuinely large/gnarly task running default-or-low effort."

---

### 5.5.4 Expertise / pre-emption guard (don't second-guess a justified choice)

When the prompt shows the dev already understands the failure mode or has explicitly addressed a dimension, the coach must not pivot to a *different* unstated dimension as the interrupt lever. This is the "expert who hand-rolled a debounce with a stated rationale", the "`--effort xhigh` on an ABA-race refactor", the "`git bisect` to find what broke", and the "`bump lodash to 4.17.21 and rerun the failing test" cases.

**Edits (DATA):**
- **`JUDGE_SYSTEM` STEP 6, add an EXPERTISE / PRE-EMPTION CHECK before choosing a lever:** "if the prompt uses precise domain terms that show the dev already understands the failure mode (names the exact bug class, the data structure, the concurrency hazard) OR has explicitly addressed a dimension (named the effort flag, named a method, stated a constraint, pinned a version, named a verification step), do NOT pivot to a DIFFERENT unstated dimension (e.g. `verification_path: no test named`) as the interrupt lever unless that absence is genuinely high-risk and non-obvious for THIS specific task. A repro/regression test the dev would obviously already write is `marginally better`, not `a senior PM would stop you` — suppress it."
- **`JUDGE_SYSTEM` STEP 6, absence-justification requirement:** "a verification_path interrupt on a refactor MUST cite WHY the test is missing-and-necessary HERE; do NOT default to `no test named` as a universal lever."
- **`JUDGE_SYSTEM` STEP 6, named-method anchor:** "A named disciplined debugging/verification method (git bisect, binary search, profiling, repro-first, a failing test first, a spike) is itself the process AND its own verification — do NOT interrupt to suggest `be more systematic`; discovery-phrased (`find what broke`, `figure out why`) is NOT the same as fuzzy/undecided."
- **`JUDGE_SYSTEM` STEP 6, mechanical self-verifying exemplar (add near the "a senior PM would stop you" line):** "A mechanical, self-verifying task is NOT interruptible even as a fresh new-task with no transcript: e.g. `bump lodash to 4.17.21 and rerun the failing test` names a pinned version AND a verification path, so verification_path and acceptance_criteria are SATISFIED (a green test is the definition of done) — return interrupt:false, missing_piece:null. Absence of a transcript is NOT itself a missing piece."
- **`JUDGE_SYSTEM` STEP 6, anchored-pick exemplar:** "A terse pick anchored to options you just offered (`the second one, but lighter`) is a continuation — the agent can act and the human refines a loose modifier next turn; do NOT interrupt to ask what a modifier means."
- **`JUDGE_SYSTEM` STEP 1 / STEP 6, debug-loop guard:** "A fix/debug request is interrupt-eligible ONLY when the bug target is unidentifiable from the prompt AND transcript (no error, no failing test, no symptom named) — then phase=ambiguous and the missing piece is the symptom/repro, NOT the fix approach. If ANY error/symptom/failing test is visible, classify continuation or correction and do NOT interrupt — never second-guess a normal debug loop, and never treat the AI error itself as the coachable unit."

**Prospector edits (DATA, `PROSPECTOR_SYSTEM`) — screen the self-justified cases out before they cost a Sonnet call:**
- Append to the LOW guidance (the line that already says terse-when-anchored scores LOW): "Score LOW when the prompt ITSELF gives a concrete reason the existing thing does not fit (a named missing capability, a deliberate dependency drop) AND names a check — that is sound engineering, not blind reinvention. A prompt that names a recognized disciplined method (git bisect / binary search, profiling, adding a failing test first, a spike/repro) is SOUND PROCESS — score LOW even when the outcome is phrased as discovery."
- Add a worked LOW example: "`hand-write a small debounce because we dropped lodash for bundle size and need a leading-edge flush it lacks, with a unit test for that case` — justified; score LOW." Keep the existing "hand-code all the tokens by hand" HIGH example (no rationale) escalating.

> **Do NOT add a blanket "stated rationale → sound" carve-out to `JUDGE_SYSTEM`.** A broad carve-out lets a dev launder a genuinely bad approach with a plausible sentence (rationale-injection). The judge already weighs this via STEP 6; the surgical leak is *wasted Sonnet calls*, fixed in the PROSPECTOR. The judge stays the precision-bearing backstop. (Note the fail-OPEN path: `parseProspectorScore` returns escalate on unparseable Haiku output, so the judge MUST also carry the named-method/expertise anchors above — the prospector edit alone is insufficient.)

---

### 5.5.5 Capability fitness — never recommend a thing the dev can't use, never the wrong tool

Three confidently-wrong capability hazards, each fixed with a **hard gate** (preferred over relying on the Sonnet judge to honor a prose caveat) plus a mirrored prompt rule.

**(a) Launch-only flags mid-session.** `--effort xhigh` and `--worktree` are LAUNCH-time; recommending them mid-session means killing the loaded session to chase a marginal bump.
- **Code:** add `appliesAt: 'launch' | 'in_turn'` to the `Capability` shape (`src/capability/catalog.ts`); tag `effort-xhigh`, `worktree`, and any `cli_flag` needing a fresh process as `'launch'`. In `judge-cascade.ts`, when `transcript.length > 0`, DROP launch-only capabilities from `availableCapabilities` before building the judge input (defense in depth — a launch-only flag is never even offered mid-session). Render `appliesAt` on each capability line.
- **DATA (`JUDGE_SYSTEM` STEP 5):** "If a transcript is present (the dev is mid-session), do NOT recommend a launch-only capability — relaunching discards the loaded context; prefer an in-turn affordance (e.g. the `ultrathink` keyword, or plan mode) for difficulty." **REMOVE** `relaunch with --effort xhigh` from the STEP 5 example list (it is the single strongest steer toward the harmful behavior). Reconcile the `effort-xhigh` catalog `when` text to read explicitly as launch-time guidance.

**(b) Model-scoped flags surfaced cross-model.** `effort_level_fit` bakes in "Opus 4.8 → xhigh"; the catalog is version-gated but NOT model-gated, so a Codex dev could be told `--effort xhigh` (an Opus surface). Worse: `capabilityLine` (`judge-cascade.ts`) renders only `trigger (kind): what [costClass]` — the `when` field carrying the Opus caveat is NOT rendered, so the judge sees a model-agnostic line.
- **Code (the real fix):** add `modelFamily?: 'opus' | 'codex' | ...` (or `appliesToModels`) to the `Capability` shape and a corresponding field to `CapabilityPerson` sourced from the **local-context probe's `localContext.activeModel`** (§8.6 / §15 — `message.model` off the session JSONL, e.g. `claude-opus-4-8`); `resolveCapability` returns `available:false` when the capability is model-scoped and the dev's active model is out of scope. Tag `effort-xhigh` opus-only. Optionally add an `--effort high|medium` catalog entry so Codex devs still get correct effort advice. When `activeModel` is `unknown`/`null` (probe degraded), do NOT model-gate on guesswork — treat it as "no model signal" and lean toward NOT surfacing a model-scoped flag (fail-safe, §8.6).
- **DATA:** strip the literal "For Opus 4.8, xhigh..." from the `effort_level_fit` probe into a refreshable `modelEffortDefaults` map rendered into the judge input at build time, so the recommendation tracks the dev's actual model rather than a hardcoded default.

**(c) Wrong lever / wrong tool on sprawling or destructive work.**
- **Expensive multi-agent on an unbounded task** — `judge-cascade.ts`, after resolving `fitCapability`, drop an `expensive_multiagent` capability when `verdict.primary_lever ∈ {scope_boundaries, acceptance_criteria}` (extend the SKILL-WINS line). Mirror in `JUDGE_SYSTEM` STEP 5: "never recommend an expensive multi-agent capability for an unbounded task — scope it before parallelizing." Cost disclosure (`EXPENSIVE_COST_CLAUSE` within `COST_CLAUSE_RESERVE`) already works.
- **plan-mode vs --worktree disambiguation** — `JUDGE_SYSTEM` STEP 3 tie-break: "When process_fit, scope_boundaries, and risk_awareness are all weak on a big/risky change, prefer process_fit as the primary_lever — the actionable gap is `plan before diving in`, not `acknowledge the risk`." STEP 5 tie-break: "choose plan-mode (Shift+Tab) when the gap is sequencing/safety of a single sprawling change; choose --worktree ONLY when the gap is collision with OTHER concurrent work."
- **goal_clarity/scope_boundaries must not carry a how-to skill** — `JUDGE_SYSTEM` STEP 4 + STEP 7: "When the primary_lever is goal_clarity or scope_boundaries (the task itself is not yet defined), do NOT set skill_fit or capability_fit to a how-to/solution skill (optimize, critique, frontend-patterns, audit) — there is no defined outcome to optimize toward yet. Keep the nudge purely about pinning ONE concrete outcome and a definition of done." Belt-and-suspenders in `judge-cascade.ts`: when `verdict.primary_lever ∈ {goal_clarity, scope_boundaries}`, force `action = NO_SKILL_ACTION` and `capabilityPayload = null` before composing.
- **SKILL-WINS narrowing** — `JUDGE_SYSTEM` STEP 5: "Prefer a skill over a capability ONLY when the skill directly executes the missing piece; if the missing piece is purely process/planning and the only fitting skills do not produce that artifact, a planning capability (e.g. plan-mode, Shift+Tab) may ride instead. Do NOT set skill_fit for a code-style/cleanup skill when the gap is `no plan`."

**(d) Data-destruction needs a DATA-safety affordance, not a code review.**
- **Code (curated-skills list, `scan-skills.ts`):** ADD `database-migrations` to the curated/merged skill set so the data-safety affordance is actually offerable as `[install + run]` and can WIN over `/code-review ultra` via the existing SKILL-WINS rule. Without this, skill-wins is a no-op for destructive-DDL prompts.
- **DATA (`JUDGE_SYSTEM`):** "For risk_level=high prompts that DESTROY or IRREVERSIBLY MUTATE persistent data (DROP/DELETE/TRUNCATE/destructive migration run directly against production), primary_lever MUST be risk_awareness or verification_path, and the nudge MUST name a concrete reversibility step (take a snapshot/backup; run it through the reversible migration pipeline with a rollback) BEFORE any destructive run. NEVER substitute a code-review capability (/code-review, /code-review ultra, /security-review) for a data-safety gap — those review CODE, not the safety of running destructive DDL against prod." Add one worked guardrail example showing the correct nudge.

**(e) Unconfirmed disk-commands (trust invariant).** The resolver hides a `disk_command` when `installedCommands` is null (scan never ran). Never name a command you cannot confirm the dev has. Surface the freshness signal through a LOCAL observability detail `capabilityScanState: 'never_scanned' | 'scanned_empty' | 'populated'` (derived from `installedCommands === null` vs `[].length === 0`) plus a count of disk-commands hidden due to a null scan, so a debug log shows disk-command blindness. Any soft/generic mention (config-gated) must be sourced from catalog `when`/`what` text generically ("design-system push commands often exist — check `/help`"), NEVER echoing a specific trigger the resolver refused to confirm.

**(f) Stripped capability field ≠ rewritten sentence (defense-in-depth, fail-CLOSED).** `resolveCapability` nulls the structured field but does NOT rewrite `verdict.nudge`. The primary protection is at the judge INPUT (filtered list + "only from that list — never invent one"). For belt-and-suspenders: after computing `capabilityPayload`, validate that every backticked/exact-trigger token in `verdict.nudge` maps to a capability in `availableCapabilities`; if a token resolves to a catalog entry that is NOT available, treat the verdict as malformed and **SILENCE** (`observe('firing_gate_suppressed')`), consistent with the file's fail-closed posture. Do NOT inline-scrub the sentence (risks shipping a grammatically broken nudge).

**Reflex (Tier-0) efficiency — gate on INTENT, not raw length.** A 30–60-char obviously-trivial ask ("rename this variable to userId", "fix the typo in the README install command") sails past the `TRIVIAL_CHAR_LIMIT = 24` ceiling and wastes a Haiku call, defeating the ~60–70% Tier-0 exit target. **Do NOT match trivial patterns "regardless of length"** (that breaks the deliberate long-prompt guard). Instead, in `judge-reflex.ts`: (a) raise `TRIVIAL_CHAR_LIMIT` from 24 to ~60 so short trivia exits at Tier 0; AND (b) add a tighter trivial-INTENT regex (e.g. `/^(rename|add a comment|bump (the )?version|run (the )?(linter|formatter)|format)\b/`) that fires ONLY for a single short clause (no `and`/`then`/`,`, no second imperative, under the raised limit) AND only when no risk/scope token (`migration`, `auth`, `drop`, `schema`, ...) is present — so "fix the typo in the migration that drops the users table" and "rename the User model and migrate all 40 call sites" still escalate. Tier-0 stays transcript-blind/pure (`judge-reflex.ts` no-I/O invariant); do NOT add transcript-aware heuristics there. The longer terse corrections that still reach Haiku (e.g. "actually use a map instead of looping the array", "no, don't add a new index — just add LIMIT 100") are an *accepted* cost of keeping precision in the model — one 8-token Haiku call is negligible; if it ever matters at scale, raise `PROSPECTOR_ESCALATE_BAND` back toward `0.35`.

---

### 5.5.6 Habit-mining quality (Pillar 3)

Three load-bearing fixes; habits run on a 24h cadence, so a single bad habit nudge is *more* disabling than any quality miss.

**(a) Desirability filter — never coach a GOOD habit.** The miner today filters only on recurrence + actionability, so a recurring BEST PRACTICE (TDD, running the linter, asking for a plan) could be surfaced as something to "fix" — condescending and the single most likely uninstall trigger.
- **Miner-prompt (source spec §4 + guardrail #5):** "Only surface habits that are INEFFICIENT or COUNTERPRODUCTIVE. A recurring BEST PRACTICE (writing tests first/TDD, running the linter, asking for a plan, adding acceptance criteria) is NOT a coachable habit — emit nothing for it. The fix must REMOVE friction or PREVENT a recurring mistake, never formalize a habit that is already good." Require a new per-pattern field `why_inefficient` (short string naming the concrete waste/risk the fix removes). Add the worked NEGATIVE example: input = "write the test first" × 3 sessions → output `[]`.
- **Structural drop (don't trust the prompt alone):** in the miner's defensive parse, DROP any pattern whose `why_inefficient` is empty (mirroring the existing empty-`fix` drop in guardrail #4).

**(b) Dismissal-respect by CONSTRUCTION (not a model-emitted slug).** Guardrail 3 ("re-mine never re-opens a dismissed key") is only as strong as `habit_key` stability — and an LLM normalizing free phrasing into a slug is NOT deterministically stable. A dismissed `next-session-prompt` resurfacing as `session-kickoff-prompt` is the fastest uninstall. **Reject** "hash of match_phrases" (the phrases are ALSO LLM-emitted free text and drift run-to-run — hashing just moves the instability). Instead reuse the deterministic anchor-token matcher the spec already defines at §7.4 (trim + collapse + lowercase, whole-word) for a **DISMISSAL-SIMILARITY GATE**: before upserting any newly-keyed pattern with `status='open'`, compare its `match_phrases`' anchor-token signature against every DISMISSED pattern's `match_phrases` using **Jaccard over anchor tokens**; if overlap ≥ a threshold (start `0.6`, tune on pilot), treat the new pattern as the dismissed behavior and DROP it (immutability — drop the new row, never mutate). Persist a normalized anchor-token-signature alongside `habit_key` so the gate is a cheap comparison.

**(c) Mine-vs-deliver impedance (semantic mine, lexical deliver).** The miner detects habits SEMANTICALLY (fuzzy Sonnet) but delivery is LEXICAL (whole-word anchor-token containment) — the very thing that makes it a habit (varied phrasing) defeats the matcher on NOVEL phrasings of an already-mined habit. **Do NOT relax matcher rule (ii) to min-token-overlap** (reintroduces the false-hit risk the spec deliberately pinned). Instead:
- **Self-match calibration at mine time:** mandate **3–6** representative `match_phrases` (not 2–4), and after mining, run each occurrence's real evidence text back through the §7.4 matcher against the stored `match_phrases`; REJECT/flag the habit if fewer than 3 historical occurrences self-match. Proves the phrases generalize across the dev's own observed phrasings BEFORE shipping; costs no delivery-time LLM.
- **Cheap fuzzy fallback BEHIND the cheap lexical one:** lexical match fires immediately as today. Only when lexical does NOT match AND a cheap pre-filter says the prompt looks end-of-session/handoff-ish, escalate to ONE Haiku call ("does this prompt express intent `<habit prose>`? yes/no") — the same Haiku-as-cheap-gate pattern already proven in the cascade. The 24h habit cooldown bounds spend to ~1 Haiku/dev/day.

> **Correct framing of the golden case:** the matcher under-delivers on NOVEL phrasings of an already-mined habit, NOT on near-repeats of a source prompt (the canonical re-fire prompt contains the verbatim source phrase and fires by rule (ii); the §12 e2e pins that). State the issue precisely.

---

### 5.5.7 New regression tests (extend §12)

Add to the test plan. Model-judgment cases are env-gated real-LLM (synthetic payloads cannot validate a prompt-wording change); structural cases are plain unit tests.

- **Phase, escalation-camouflage (real-LLM):** "now also backfill that column for all 4M rows in prod" (after a 1-column ORM add) → `escalation`, FIRES; "now also add the logout flow" → `continuation`, silent. Run BEFORE and AFTER the edit and diff.
- **External-referent (real-LLM):** "Pick up PROJ-412 and finish it the way we discussed in standup" (empty transcript) → before-fix sometimes `interrupt:true` w/ missing_piece about "definition of done"; after-fix `interrupt:false` / `firing_gate_suppressed`.
- **Expert pre-emption (real-LLM):** justified-debounce, ABA-race `--effort xhigh`, `git bisect ... to find what broke`, `bump lodash to 4.17.21 and rerun the failing test` → all expected SILENCE; `prospector_suppressed` or judge `interrupt:false`. Plus prospector unit: original "hand-code all the tokens by hand" (no rationale) MUST still escalate.
- **Dismissal-similarity (unit):** "dismissed habit with phrasing drift that yields a DIFFERENT model `habit_key` but overlapping anchor tokens MUST NOT resurface" — closes the gap the current happy-path stability test does not cover.
- **Good-habit drop (real scenario):** seed 3+ distinct sessions of "write a test first" → miner emits EMPTY array (no pattern row), paralleling the existing "no concrete fix → not emitted" assertion. Optionally seed "run the linter", "make a plan first".
- **Data-destruction (real-LLM):** destructive prod DROP → `primary_lever ∈ {risk_awareness, verification_path}`, capability id NOT in `{code-review, code-review-ultra, security-review}`, nudge mentions backup/snapshot/rollback.
- **Launch-only mid-session (unit):** with a non-empty transcript, `effort-xhigh`/`worktree` are absent from `availableCapabilities`.
- **Model-gate (unit):** a Codex-active `CapabilityPerson` → `resolveCapability('effort-xhigh')` returns `available:false`.
- **Keyword-over-firing backstops (unit):** token-mentioning-but-well-scoped prompt ("border-radius 4px→6px in tokens.css + update one snapshot test") scores `< PROSPECTOR_ESCALATE_BAND`; and a judge verdict with `missing_piece=null` + a stray `capability_fit` → `firing_gate_suppressed` (missing_piece guard). Test BOTH gates.
- **Canonical /design-sync (unit):** with `/design-sync` in `installedCommands` → reaches the capability resolve, `capability.trigger === '/design-sync'`; do NOT pin `primary_lever`/`phase` exactly (assert lever ∈ {process_fit, scope_boundaries} OR `capability.id === 'design-sync'`). NEGATIVE: same prompt with a generic design skill injected into the catalog MUST still surface `/design-sync`, not the weaker skill.
- **Phase-gate suppression (unit):** inject a verdict where "no, put the validation in the controller not the model" is `phase:'correction'` and assert `eligiblePhase === false` → `firing_gate_suppressed`, EVEN when `primary_lever==='process_fit'` was already used and `interrupt:true`/high-confidence are forced — proving the phase gate alone suppresses (the coach scores process, not architecture taste).

---

### 5.5.8 GOLDEN-SET CALIBRATION PLAN (run BEFORE shipping — thresholds are PROVEN, not guessed)

A labeled corpus of fixture prompts (each with a recent-transcript fixture where relevant), run through the **real** cascade (`RUN_REAL=1`, env-gated, skipped by default = zero spend). Each is labeled `FIRE` or `SILENT` with the expected `primary_lever` (for FIRE cases) and expected capability id (where relevant). The harness reports precision/recall and prints the full verdict for every miss.

**Targets (the QUALITY BAR made measurable):**
- **Precision on the FIRE set ≥ 0.9** (when the coach fires, it is right ≥ 9/10 — the survival metric).
- **Specificity: 0 FIRE outputs may contain a banned phrase** ("scope it down", "add more detail", "decide what it shows") — a hard gate, not a percentage.
- **0 confidently-wrong fires** on the SILENT set's expert/justified subset (this subset's recall of silence = 1.0 — non-negotiable).
- **Recall on the FIRE set ≥ 0.7** is acceptable; a missed coachable prompt is the cheap error. **If precision and recall trade off, sacrifice recall.**

**The ~16 labeled prompts (span thin / expert-terse / mid-session / habit):**

*Thin (should FIRE, specific lever):*
1. "build a dashboard" — FIRE, `goal_clarity`/`process_fit`, nudge names a concrete data-source + 2–3 metrics question.
2. "refactor this whole module, it's a mess" (fresh) — FIRE, `process_fit`, nudge appends characterization-test clause.
3. "add auth" (fresh) — FIRE, `risk_awareness`, nudge names the auth surface.
4. "make our checkout flow better... just improve it" — FIRE, `goal_clarity`/`scope_boundaries`, NO optimize/critique skill attached.

*Expert-terse (should stay SILENT — the precision wall):*
5. "bump lodash to 4.17.21 and rerun the failing test" (fresh) — SILENT.
6. "rename the `usr` param to `user` in auth/session.ts and update its 3 call sites" — SILENT.
7. "refactor a lock-free ring buffer to fix the ABA race, run at `--effort xhigh`" — SILENT (no verification_path pivot).
8. "git bisect between v2.3 and HEAD to find what broke the checkout total" — SILENT (named method).
9. "hand-write a 12-line debounce because we dropped lodash for bundle size and it lacks leading-edge flush; unit test for that case" — SILENT (stated rationale + check).
10. "no, don't add a new index — just add LIMIT 100 to that query" — SILENT (terse correction).

*Mid-session (transcript fixture decides — should stay SILENT unless escalation):*
11. "now also backfill that column for all 4M rows in prod" (after a 1-column ORM add) — **FIRE**, `risk_awareness`/`verification_path` (escalation camouflage; the one mid-session that MUST fire).
12. "now also add the logout flow" (mid feature work) — SILENT (continuation).
13. "ok run the migration" (after 3 turns of batching+rollback planning) — SILENT (anchored continuation).
14. "make it faster" (immediately after pasting a flamegraph) — SILENT (anchored expert).
15. "the second one but lighter" (after Claude offered options A/B) — SILENT (anchored pick).

*Destructive / capability:*
16. "DROP the legacy_orders table and its orphaned columns directly on prod" — FIRE, `risk_awareness`/`verification_path`, nudge names snapshot/rollback, capability NOT a code-review.

*Habit (separate miner harness):*
17. seed "give me the prompt for the next session" × 3 distinct sessions → miner emits one actionable pattern; a 4th matching typed prompt delivers the cited nudge; quality cooldown untouched.
18. seed "write a test first" × 3 distinct sessions → miner emits EMPTY (good-habit drop).
19. dismiss the next-session habit, then re-mine with drifted phrasing yielding a different `habit_key` but overlapping anchor tokens → MUST NOT resurface.

**Procedure:** (1) snapshot baseline metrics on the unmodified brain; (2) apply the §5.5 edits (bump `PROMPT_COACH_SKILL.version`); (3) re-run; (4) require precision ↑ or held AND the expert-subset silence recall = 1.0 AND 0 banned phrases; (5) if any expert case fires, treat as a BLOCK — tune `JUDGE_SYSTEM` STEP 6 wording or dial `PRE_RUN_CONFIDENCE` from PILOT-LOUD `0.6` toward BALANCED `0.8`, never relax the expert guard. Commit the labeled set + the metrics report as the calibration artifact so any future prompt edit is re-provable.

---

## 6. The LLM backend (decision #3, #13) — and reconciling it with the ported `PmProvider`

One interface, two implementations, selected at runtime. This is the renamed/relocated `PmProvider` seam,
but it is **NOT a trivial rename** — the source `PmProvider.complete` returns an OBJECT and THROWS. The
adaptation is real porting work across ~4 call sites plus a mapping layer; enumerate it, do not bury it.

### 6.1 The local interface
```ts
// src/llm/backend.ts
export interface LlmBackend {
  readonly configured: boolean;
  // returns the model's raw text, or null on ANY failure (NEVER throws to the caller)
  complete(opts: { system: string; user: string; maxTokens: number; model: 'haiku' | 'sonnet' }): Promise<string | null>;
}
```

### 6.2 Source contract (verified) vs the local one — the four reconciliations

Source `anthropic.ts`: `complete(opts: PmCompleteOptions): Promise<PmCompletion>` where
`PmCompletion = { text; toolCalls; usage? }`; `PmCompleteOptions` requires `tools: PmToolDefinition[]` and
takes `model?: string` (an id). It THROWS `new Error('pm_provider_unconfigured')` (line 57) and
`new Error('pm_provider_error:'+status)` (line 75). The ported cascade call sites (`judge-dispatch.ts`)
read `.text` and pass concrete ids + `tools: []`. To converge on the local `LlmBackend`:

1. **Return shape.** Source call sites do `parseProspectorScore(prospect.text)` /
   `deps.onProspectorParseFailOpen?.(prospect.text)` (judge-dispatch.ts:437-438) and
   `parseJudgeVerdict(judgment.text)` (453). Since `LlmBackend.complete` returns a bare `string | null`,
   the builder MUST rewrite both call sites to consume the string directly:
   `parseProspectorScore(prospect)` / `parseJudgeVerdict(judgment)` and DROP the `.text` reads.
2. **`tools` field.** Both source call sites pass `tools: []`; `LlmBackend` has no `tools` field, so remove
   those two args. (The source backend body gates on `tools.length`, so `[]` is already a no-op.)
3. **Model mapping (the one most understated).** Source imports `HAIKU = 'claude-haiku-4-5'` /
   `SONNET = 'claude-sonnet-4-6'` (models.ts) and passes `model: HAIKU` / `model: SONNET`. `LlmBackend`
   takes the ALIASES `'haiku' | 'sonnet'`. Change the two call-site args to the aliases AND add an
   alias→id mapping layer at the backend boundary: `'haiku' → 'claude-haiku-4-5'`,
   `'sonnet' → 'claude-sonnet-4-6'` (current ids per §9). The CLI backend passes the alias straight through
   to `--model`.
4. **throw vs null (load-bearing).** The cascade has NO try/catch around either `complete()` call, so a
   never-throws/null contract is NOT a drop-in. Wrap the source throws in a try/catch→null AT THE BACKEND
   BOUNDARY (in `anthropic.ts` / `claude-cli.ts`), AND add explicit null guards BEFORE the parse calls in
   the cascade: `if (prospect === null) { observe('prospector_unavailable', false); return; }` (fail-open
   intent preserved — silence, not crash) and `if (judgment === null) { observe('verdict_malformed', false); return; }`
   (fail-closed). Without these guards, parsing `null.text` throws a TypeError.

### 6.2.5 SPIKE A + B RESULTS (verified against real `claude` CLI 2.1.186 — Session 18)
Both build-time spikes were RUN, not assumed. Findings (these supersede the earlier guesses):

- **`claude -p` JSON shape (PINNED):** `claude -p "<user>" --model <alias> --output-format json` returns a
  single JSON object `{ "type":"result", "subtype":"success", "is_error":false, "result":"<model text>",
  "session_id":..., "total_cost_usd":..., "usage":{...}, ... }`. The model's text is `.result`. The CLI
  backend reads `.result`, then runs the same defensive inner-JSON extraction (`parseJudgeVerdict`).
- **Hooks-disable / recursion guard (PINNED — named flag found):** `claude -p --bare` is "Minimal mode:
  skip hooks, LSP, plugin…". PROVEN: a planted `UserPromptSubmit` hook did NOT fire under `--bare`. So the
  CLI backend invokes `claude -p --bare --model <alias> --output-format json` AND sets
  `PROMPT_COACH_JUDGING=1` in the child env (the hook/judge also exit-at-top if that var is set). Two
  independent guards; `--bare` alone already prevents recursion.
- **COST / BILLING (MEASURED + CORRECTED):** `claude -p` **uses the user's existing Claude Code auth**.
  For the COMMON case — a user logged in via a **Pro/Max subscription (no API key)** — `claude -p` draws on
  the **subscription, with NO per-call monetary charge** (it consumes subscription usage limits, not
  dollars). The `total_cost_usd` field the CLI prints is the *equivalent* metered cost and is only an actual
  charge when an `ANTHROPIC_API_KEY` is present (then the key takes precedence — the CLI even warns
  "connectors disabled because ANTHROPIC_API_KEY... takes precedence over your claude.ai login"). In THIS
  spike's sandbox a key was set, so the measured ~$0.03 / ~40k tokens was the key being billed — NOT what a
  subscription user pays. TWO real facts survive regardless of billing: (1) `claude -p` wraps our small
  prompt in the full Claude Code system prompt + tooling (~40k tokens of overhead per call) — so it
  consumes far more *usage* (subscription limits or key dollars) than a clean raw-API call (~20 input
  tokens); (2) the raw API gives the clean system/user separation + `cache_control` the brain was tuned
  for. **Correction:** the earlier "claude -p costs ~300× / it bills everyone" framing was WRONG for the
  subscription case — `claude -p` is free-of-charge on a subscription. The token-bloat is the real residual
  downside, not a dollar charge.
- **Spike B (PINNED):** a `UserPromptSubmit` hook's `additionalContext` **reaches the model** (proven: the
  model echoed a planted marker) → it STEERS the agent, failing decision #15. Therefore the tip surface is
  **plain stdout** (human-visible, non-steering), per §8.2. Confirmed.

### 6.3 Backend selection (`createLlmBackend()`) — CLI is the DEFAULT (decision #14, confirmed post-spike)
**Locked precedence:** the **CLI backend (`claude -p --bare`) is the DEFAULT**. It reuses the user's
existing Claude Code auth — for the common Pro/Max **subscription** case that means **no per-call monetary
charge** (it draws on subscription usage), zero setup, and it works for everyone out of the box. The raw
API backend is used ONLY when the user explicitly opts in via `PROMPT_COACH_USE_API=1` AND a key is set.

> Rationale (post-spike): an earlier draft flipped this to "API-default-when-key-present" on the belief
> that `claude -p` is expensive/always-billed. Spike A's billing finding was mis-read — `claude -p` is
> FREE-of-charge on a subscription (the measured dollar cost only applied because the spike sandbox had an
> `ANTHROPIC_API_KEY` set, which the CLI bills in preference to the login). So CLI-default is restored: it
> is the no-surprise-bill, zero-setup path for the majority. The raw API stays an explicit opt-in for users
> who WANT the cleaner system/user separation + `cache_control` fidelity and accept metered billing.

Concretely:
1. If `process.env.PROMPT_COACH_USE_API` is set AND `process.env.ANTHROPIC_API_KEY` is set and non-empty →
   **raw API backend** (`src/llm/anthropic.ts`, ported hand-rolled fetch with
   `cache_control: { type: 'ephemeral' }` on the system block — clean system/user fidelity + cache
   discount). Pin current model ids (§9). `/coach status` discloses metered API billing is active.
2. Else if `claude` is on `PATH` → **CLI backend** (`src/llm/claude-cli.ts`, the DEFAULT): shell out to
   `claude -p --model <haiku|sonnet> --bare --output-format json`, with
   `PROMPT_COACH_JUDGING=1` in the child env. Read `.result` from the JSON, then run the same
   defensive inner-JSON extraction the judge uses. Reuses the user's existing CLI auth — **zero setup, no
   per-call charge on a subscription** (note the ~40k-token per-call overhead from the wrapped CC system
   prompt — consumes usage limits, not dollars, for subscription users).
3. Else → **null backend** (`configured=false`): the coach silently no-ops. Never an error, never blocks.

`/coach status` MUST report which backend is in use (and, if API, that metered billing is active). The
README cost note states: by default the coach uses the CLI backend (`claude -p --bare`), which runs on the
auth already configured for the user's Claude Code — on a Pro/Max **subscription this is no per-call
charge** (it uses subscription usage limits). Setting `PROMPT_COACH_USE_API=1` (with a key) switches to the
raw Anthropic API, which IS metered/billed but gives cleaner fidelity + the cache discount.

**Recursion guard (decision #13):** the CLI backend sets `PROMPT_COACH_JUDGING=1` in the spawned child's
env. The hook (`dist/hook.js`) and judge (`dist/judge.js`) both **exit immediately at the top** if that var
is already set in their own env. Plus: invoke the inner `claude -p` with hooks suppressed where the CLI
supports it (verify the exact flag at build — Spike A). Two independent guards; either alone stops recursion.

**Build-time Spike A:** confirm `claude -p`'s JSON output shape (`{ "result": "...", ... }` vs other) and
the exact hooks-disable mechanism, against the installed CLI version, before finalizing `claude-cli.ts`.
Prove the recursion guard (`PROMPT_COACH_JUDGING=1` set on the child → child hook exits at top).

---

## 7. Pillar 3 — the cross-session habit coach + the corpus/session reader contract

Port `docs/superpowers/specs/2026-06-21-habit-coach-design.md` (the source spec), translating every
server construct to a local one. **All `(room_id, user_id)` keying is dropped** — single user, global scope
(decision #6). The miner runs against the *whole local corpus*. Quality refinements: §5.5.6.

### 7.1 The corpus / session reader (`src/jsonl/`) — exact contract (pins `judge-dispatch.ts:400-412`)
- `line-parser.ts` — port `claude-line-parser.ts`'s THREE-tier gate verbatim and in order: top-level
  `o.type === 'user'` dispatch (38) → inside `parseUserLine` (45) the `if (o.promptSource !== 'typed')
  return []` gate (47) → the nested `if (o.message.role !== 'user') return []` guard (51). All three must
  hold. Yields `{ text, sessionId, ts }` for typed prompts only.
- `session-reader.ts` — given one `.jsonl` path, return the typed-prompt events. **Contract (reproduce the
  current consumer behavior exactly — do NOT change it, just pin it):**
  1. **ORDER:** the reader returns typed prompts **NEWEST-first** (it stands in for `getRelevantRaw`
     `depth:'session'`, whose SQL is `ORDER BY created_at DESC, id DESC`). The consumer then `.reverse()`s
     the prior slice to oldest-first for the model. (Equivalent allowed: return OLDEST-first AND drop the
     `.reverse()` — but pick one and pin it; the current cascade assumes newest-first then reverses.)
  2. **VERBATIM:** `verbatim` = the stdin `prompt` field the hook passes (§4), NOT "the last JSONL line".
     This matches the cascade today (`verbatim = candidate.text`, the in-hand text). The file tail is not a
     reliable source for the current turn.
  3. **TRANSCRIPT:** the last `MAX_TRANSCRIPT = 8` PRIOR typed prompts, EXCLUDING the in-hand one,
     oldest-first — i.e. reproduce `priorNewestFirst.slice(0,8).reverse()`. The latest prompt is the
     `verbatim` (passed separately) and is dropped from the transcript so it is never sent twice.
  4. **CAP:** carry the `DEPTH_LIMITS.session` cap (prompts: 20, 24h window — `retrieval.ts:99-101`) into
     the reader so it does not over-read a huge session file.
- `corpus-reader.ts` — glob `~/.claude/projects/*/*.jsonl`, stream each, collect typed prompts with their
  `sessionId` (derived from the filename) + `ts`, newest events bounded by the watermark. This is the
  mining corpus. (No `terminal-jsonl-resolver` slug logic needed — we glob actual files on disk.)

### 7.2 The throttled miner (`src/habit/miner.ts`)
- **Throttle** (checked in the background judge, decision #7): mine only when BOTH
  (a) new-typed-prompt count since `state.lastMinedWatermark` ≥ `MIN_NEW_EVENTS` (5), AND
  (b) `now - state.lastMinedAt ≥ MINE_COOLDOWN_MS` (24h).
  Watermark is a monotonic event counter persisted in `state.json` (replaces the server's
  `people.last_habit_mined_event_id` bigint column). Most prompts: throttle fails instantly → zero LLM.
- **LLM pass** (one Sonnet call): the source spec's system prompt verbatim — "analyze a developer's recent
  TYPED prompts for RECURRING HABITS worth coaching… output ONLY JSON array of `{ habit_key, match_phrases,
  habit, fix, why_inefficient, occurrences:[{sessionId,ts,evidence}], confidence }`… every occurrence must
  cite a real event… occurrences must span ≥3 DISTINCT sessionIds… empty array if none." Apply the §5.5.6
  desirability filter + `why_inefficient` requirement + 3–6 phrases. Defensive parse (mirror
  `parseJudgeVerdict`). Guard null backend → no-op.
- **Upsert** into `patterns.json` keyed by `habit_key` (the stable normalized `<topic>:<behavior>` slug,
  separate from the human-readable `habit` prose so re-runs collapse to one entry). Apply the §5.5.6
  dismissal-similarity gate + self-match calibration. See §7.6 for the concurrency-safe read-merge-write
  rule. Drop any pattern with <3 distinct sessionIds, an empty `fix`, or an empty `why_inefficient`. Then
  advance the watermark + `lastMinedAt`.

### 7.3 The discovered-patterns store (`patterns.json`)
Array of entries (the server's `coaching_patterns` table → a local JSON array, no room/user columns):
```jsonc
{
  "habit_key": "context-handoff:next-session-prompt",  // STABLE dedup/dismiss key (not prose)
  "trigger": "prompt_recurring:context-handoff:next-session-prompt", // typed-only; NEVER command:/x
  "match_phrases": ["give me the prompt for the next session", "..."], // 3-6 representative typed phrasings
  "anchorSignature": ["next","session","prompt","handoff"], // normalized anchor tokens (dismissal-gate, §5.5.6b)
  "habit": "asks for a next-session handoff prompt",   // human-readable (may vary run-to-run)
  "fix": "bake a prompt-handoff section into your /context-handoff command", // non-empty required
  "why_inefficient": "retypes a handoff prose every session instead of templating it", // non-empty required (§5.5.6a)
  "occurrences": [{ "sessionId": "...", "ts": 0, "evidence": "..." }], // >=3 distinct sessionIds
  "occurrenceCount": 3,
  "confidence": 0.0,
  "status": "open",                                    // open | surfaced | dismissed
  "createdAt": 0,
  "surfacedAt": null
}
```

### 7.4 Trigger-matched delivery (`src/habit/matcher.ts`)
- On every typed prompt, for each `open` pattern, test whether the in-hand prompt matches a `match_phrase`.
- **Matcher semantics (pin it — raw substring false-hits):** normalize both sides (trim +
  whitespace-collapse + lowercase). Fire ONLY when the normalized prompt EITHER (i) exactly equals one
  normalized `match_phrase`, OR (ii) contains ALL of a phrase's anchor tokens as **whole words**
  (word-boundary), and only for phrases of ≥4 tokens (short phrases require exact equality). Deterministic,
  no LLM at delivery. (Mirror the normalization in `coach-liveness.ts`.) §5.5.6c adds an optional cheap
  Haiku fuzzy fallback BEHIND this lexical match for novel phrasings.
- **Delivery:** deposit the composed habit nudge into `mailbox/<session>.json` (kind: `habit`), cited:
  `🐾 PM: you've asked for a next-session prompt in your last <N> sessions — <fix>.` Set the pattern's
  `status='surfaced'`, `surfacedAt=now` (see §7.6 for the atomic write that also records
  `lastSurfacedPatternKey`).
- **Budget (decision #8):** the habit path has its OWN cooldown (`HABIT_COOLDOWN_MS`, 24h), persisted in
  `state.json` (`lastHabitNudgeAt`). It MUST NOT touch the quality cooldown. **Yield-to-quality:** the
  mailbox drain (§8.2) prints a `quality` tip before a `habit` tip when both are queued for the same turn;
  the un-drained habit tip stays queued for the next eligible turn.

### 7.5 The four guardrails (verbatim from source spec §7)
1. ≥3 occurrences across **distinct** sessions (drop otherwise).
2. **Cite the evidence** — name WHEN ("your last 3 sessions"), never a vague "you always…".
3. **Surface once, respect dismissal** — `status→surfaced` on delivery; `/coach dismiss` → `dismissed`,
   never resurfaces; re-mine never re-opens a dismissed key (reinforced by the §5.5.6b similarity gate).
4. **Actionable only** — a pattern with no concrete `fix` (or empty `why_inefficient`) is dropped at the miner.

### 7.6 Cross-process write ordering for `patterns.json` + dismiss (pin it — race-safe)
The detached judge writes `patterns.json` (matcher delivery sets `status='surfaced'` and the miner
upserts), while `/coach dismiss` is run by the agent in a SEPARATE node invocation. Naive read-modify-write
loses dismissals. Mandate:
1. **Surfacing is one atomic op.** When the matcher surfaces a pattern, it MUST write the pattern's
   `status='surfaced'` AND record the surfaced key in the SAME atomic write. Simplest: store
   `lastSurfacedPatternKey` in `state.json` and write it in the same `state.json` write that records
   `lastHabitNudgeAt`, then write `patterns.json` status; `/coach dismiss` re-reads `patterns.json` and
   dismisses by key, tolerating a momentary lag. (If `lastSurfacedPatternKey` lives in a separate file from
   the status, write both transactionally — write temp, then rename both — never leave them split.)
2. **Miner upsert is read-merge-write under temp-rename.** Immediately before writing, the miner re-reads
   `patterns.json`, and the merge MUST: (a) never re-open a `dismissed` entry; (b) never regress a
   `surfaced` status back to `open`; (c) preserve `surfacedAt`/`createdAt` on existing keys. Last-writer-
   wins is unsafe — require the read-merge-write. Write via temp-file + atomic rename.
3. **Dismiss and judge can interleave.** `/coach dismiss` reads `lastSurfacedPatternKey`, then re-reads
   `patterns.json`, sets that key's `status='dismissed'`, and writes via temp-rename. If a concurrent miner
   write lands first, dismiss's re-read sees the latest array; if dismiss lands first, the miner's
   read-merge preserves `dismissed`. **Merge tiebreaker: `dismissed` always wins.**

---

## 8. The hook & background judge (the new body)

### 8.1 `src/hook.ts` → `dist/hook.js` (the `UserPromptSubmit` script)
- Read stdin JSON: `{ session_id, transcript_path, cwd, prompt, hook_event_name, ... }`.
- **Top guard:** if `process.env.PROMPT_COACH_JUDGING` is set → exit 0 immediately (recursion guard).
- If the coach is disabled (`state.enabled === false`) → exit 0.
- **(1) Drain:** read `mailbox/<session_id>.json`; if a tip is waiting, emit it to the human via stdout
  (§8.2) and clear the file (atomic). Quality before habit when both queued (§7.4 yield-to-quality).
- **(2) Detach:** hand the payload to the judge via a **per-invocation inbox file** (NOT argv/env — §8.4):
  - write `{ prompt, transcript_path, session_id, cwd }` to
    `~/.claude/prompt-coach/inbox/<session_id>-<monotonic>.json` using **atomic write-temp-rename**
    (`<name>.tmp` then `rename`). `<monotonic>` = a per-process monotonic counter or `Date.now()+hrtime`
    suffix so two in-flight prompts never collide on the same file.
  - `spawn('node', [judgePath, inboxFilePath], { detached:true, stdio:'ignore', windowsHide:true })` then
    `.unref()`. `judgePath` is path-anchored (`${CLAUDE_PLUGIN_ROOT}/dist/judge.js` or the hook's own
    `__dirname`-relative path — never a cwd-relative `dist/judge.js`). Do NOT set `PROMPT_COACH_JUDGING` on
    the judge (the judge needs the LLM; the guard var is set only on the *inner* `claude -p`, §6).
  - exit 0.
- **Hard rule:** the hook never throws, never blocks > ~100ms, always exits 0. Any error → silent no-op.

### 8.2 Tip output mechanism (decision #15 — PRE-RESOLVED to plain stdout)
The tip must be shown to the **human** without being injected into the agent's task reasoning. This is
**resolved from the documented hook contract, not left fully open**:
- `{"systemMessage": "..."}` — shown to human BUT **steers the model** (the server used this). REJECTED for
  v1 (violates #15).
- `{"hookSpecificOutput": {"additionalContext": "..."}}` — documented to be ADDED to the model's context,
  so it **also steers** the agent despite the absence of a "system" label. REJECTED (violates #15).
- **Plain stdout text** (the hook prints, exit 0) — Claude Code surfaces this to the USER without feeding
  it to the model as a task instruction. **SELECTED default** for `src/hook-output.ts`.
Write the chosen field/path in `src/hook-output.ts` with a one-line rationale comment.
**Spike B (narrowed):** confirm only that the ANSI `formatCoachBanner` panel renders correctly via the
stdout path in a real session (colour panel survives, not mangled). Do NOT re-evaluate `additionalContext`
as display-only — it is not.

### 8.3 `src/judge.ts` → `dist/judge.js` (the detached background worker)
- **Top guard:** if `process.env.PROMPT_COACH_JUDGING` is set → exit 0 (recursion guard).
- Read `argv[2]` = inbox file path; read its JSON; **unlink it immediately** (so a crash never leaves a
  stale payload). The current prompt is `payload.prompt` (§4) — NEVER re-derived from the `.jsonl`.
- **Gather the local-context probe (§8.6) ONCE** before the cascade — the detached judge is where
  subprocess/file-read cost is acceptable (it never touches the <100ms hook). Pass the result as the
  optional `localContext` field of `runQualityCascade` (§15).
- Then run, in order, all fire-and-forget and fully guarded (each step independently try/caught; a failure
  in one never aborts the others or crashes the process):
  1. **Quality cascade** (§5) on `payload.prompt` (with `localContext`, §8.6) → maybe deposit a `quality` tip.
  2. **Habit match** (§7.4) on `payload.prompt` → maybe deposit a `habit` tip.
  3. **Miner throttle** (§7.2) → if due, mine the whole corpus → upsert `patterns.json` (§7.6).

### 8.6 Local-context probe (gathered ONCE per background-judge run — NEVER in the hook)
The judge runs **detached** (§8.3), so a handful of cheap subprocess + file reads here are free of the
<100ms hook budget. Beyond the typed-prompt transcript, the judge gathers extra LOCAL signals that make
several previously-"undetectable" levers real AND, just as importantly, **suppress false fires**. These
feed `runQualityCascade` alongside the transcript (§15 `localContext`).

**Three signal groups:**
1. **From the session JSONL we ALREADY parse (nearly free).** While the session reader (§7.1) walks the
   `.jsonl` for the prior transcript, also lift, from the lines already in hand: the **active model**
   (`message.model` on assistant lines, e.g. `claude-opus-4-8`), the **current mode / permissionMode** (the
   `mode` / `permission-mode` lines, e.g. `normal` / `plan` / `bypassPermissions`), and any **`effort`**
   field. VERIFIED present on disk. No extra read — these ride the existing parse pass.
2. **git state (one subprocess in the judge).** `git -C <cwd> status --porcelain` + the current branch
   (`git -C <cwd> rev-parse --abbrev-ref HEAD`): is work on a branch, are there uncommitted changes, before
   a destructive op. `<cwd>` comes from the hook stdin payload (already in the inbox file, §8.4).
3. **project config (file reads in the judge).** `<cwd>/CLAUDE.md`, `<cwd>/.claude/settings.json`, and
   `~/.claude/settings.json`: is a test command documented, is plan mode mandated, are hooks configured,
   are conventions stated.

**Why it matters (the TWO roles):**
- **(a) It makes previously-excluded levers REAL** — model-routing / effort-fit (L25), plan-before-code
  (L01) firing correctly, and reversible-ops (L26) firing on the ACTUAL unprotected git state rather than
  on prose alone.
- **(b) It SUPPRESSES false fires** — do NOT nudge "use plan mode" when the mode is already `plan`; do NOT
  ask "how will you verify" when `CLAUDE.md` documents the test command; do NOT warn "make it reversible"
  when the work is already on a clean branch. **The suppression role is the bigger precision win** (§5.5.0:
  precision over recall — a false fire is strictly worse than a missed coachable prompt).

**Engineering invariants (LOAD-BEARING):**
- **Each signal is independently try/caught.** A failed git subprocess or an unreadable/absent file
  degrades that signal to **`unknown` (nullable)** — it NEVER crashes the judge, never aborts the probe,
  never blocks the cascade. (Consistent with §8.3's "each step independently try/caught" rule.)
- **Fail-safe: an UNKNOWN signal must NEVER fire a lever.** Only a **positively-observed problem** fires
  (e.g. an OBSERVED dirty tree on `main` before a destructive op, an OBSERVED `effort` mismatch). Unknown is
  treated as **"no signal" → lean silent.** This preserves the positive-evidence rule (§5.5.0; EVAL-PLAN
  rule A): the probe can only ADD suppression or fire on affirmative evidence — it can never manufacture a
  fire from absence.
- **Input-surface expansion only — no `<100ms` impact.** The hook (§8.1) still just writes the inbox
  payload (`prompt` / `transcript_path` / `session_id` / `cwd`); the **JUDGE** does all the probing in the
  detached process. The hook contract is unchanged.

### 8.4 Why an inbox file, not argv/env (pin it — the other transports break)
The hook has already consumed stdin to read the `UserPromptSubmit` JSON, so the detached judge **cannot
re-read stdin**. The payload transport is therefore mandated as the inbox file above. **FORBIDDEN:** passing
the prompt text via argv (leaks full prompt text into `ps`/the process table; ~256KB argv cap on macOS,
much smaller on Windows `cmd`) or via env (same exposure plus Windows env-block size limits). Only the
per-invocation inbox file path is passed as `argv[2]`. The per-invocation unique filename eliminates the
two-concurrent-prompts clobber race; the judge unlinks on startup so files do not accumulate.

### 8.5 Cross-platform detach (pin it)
Spawn options: `{ detached:true, stdio:'ignore', windowsHide:true }` + `.unref()`. `windowsHide:true`
prevents a console-window flash on Windows. **v1 platform scope:** macOS + Linux are the supported targets.
Windows is **best-effort, out of v1 acceptance** (a Node child can still be tied to the parent's job object
and be killed when the Claude Code process group exits). Add a test (§12) that the spawned judge **completes
after the hook process exits** (the judge writes a sentinel file after a short delay; assert the hook
returned first and the sentinel still appears).

---

## 9. Model ids + the dropped adaptive threshold

### 9a. Model ids (FIX on port — source ids are stale)
The source `models.ts` has `claude-sonnet-4-6` / `claude-haiku-4-5` / `claude-opus-4-1`. Current models
(2026-06): **Opus 4.8, Sonnet 4.6, Haiku 4.5, Fable 5.**
- **CLI backend:** use aliases `sonnet` / `haiku` (auto-resolve to current).
- **API backend:** pin current ids in `src/llm/models.ts`. Confirm the exact current id strings at build
  (Sonnet 4.6 = `claude-sonnet-4-6`; Haiku 4.5 = `claude-haiku-4-5`; verify against the docs at build time).
The brain only ever requests `'haiku'` or `'sonnet'`; the backend maps to the concrete id/alias (§6.2-3).

### 9b. The adaptive per-dev threshold is DROPPED in v1 (resolves the dangling `thresholdFor`)
Source `judge-dispatch.ts:462` gates firing on `deps.rateLimit.thresholdFor(roomId, userId, skill.preRunConfidence)`
— a per-dev floor the server's `judge-rate-limit.ts` RAISES on repeated dismissals (dismiss-streak ≥2
→ +0.1, capped 0.95), backed by `CoachingOutcomesRepo`. **v1 takes OPTION A (locked):**
- In the ported firing gate, REPLACE `thresholdFor(...)` with the **static floor**
  `skill.preRunConfidence` (= `FIRING.PRE_RUN_CONFIDENCE` = **0.6**).
- Record NO `coaching_outcomes` row for quality tips.
- DROP `CoachingOutcomesRepo`, `judge-nudge-outcome.ts`, the `/pm/nudge-outcome` edge, and
  `onAccept`/`onDismiss`/`thresholdFor` from any local rate-limit interface.
- This is a **deliberate precision-protection regression**: a skeptic's confidence floor no longer rises on
  repeated dismissals. Note it in the README. (`/coach dismiss` still dismisses HABIT patterns — §11 — it
  just no longer feeds an adaptive quality floor.) The §5.5 calibration is how v1 protects precision instead.

---

## 10. Repo layout (the repo doubles as a single-plugin marketplace)

```
boris-says/
  .claude-plugin/
    plugin.json                     # metadata ONLY (name, version, description, author) — NO hooks/commands keys
    marketplace.json                # single-plugin marketplace manifest (so /plugin install works) — §11
  hooks/
    hooks.json                      # UserPromptSubmit registration (§11) — auto-discovered
  commands/coach.md                 # the /coach slash command (off|on|status|dismiss)
  src/
    hook.ts                         # UserPromptSubmit entry (drain + inbox-write + detach)
    judge.ts                        # detached background worker (cascade + match + mine)
    hook-output.ts                  # the chosen tip-output field = plain stdout (§8.2)
    config.ts                       # paths, defaults, enabled flag
    llm/
      backend.ts                    # LlmBackend interface + createLlmBackend() (CLI default; §6.3)
      anthropic.ts                  # raw API impl (ported, cache_control; throw→null at boundary §6.2)
      claude-cli.ts                 # `claude -p` impl
      models.ts                     # current model ids + alias→id map
    brain/                          # PURE ported logic (+ §5.5 calibration edits)
      prompt-coach-skill.ts         # rubric(9) + system prompts + FIRING bars (verbatim baseline, §5.5 data edits)
      judge-reflex.ts               # tier-0 reflex (verbatim; §5.5.5 intent-regex edit)
      judge-cascade.ts              # ex judge-dispatch.ts, server seams removed (§15 contract; §5.5 code gates)
      coach-liveness.ts             # sentinel + ping (verbatim; re-keyed to sessionId §5/§15)
      mailbox-format.ts             # formatCoachBanner ANSI panel ONLY (extraction §14)
    capability/
      catalog.ts                    # CAPABILITY_CATALOG(25) + resolveCapability (verbatim §16; §5.5.5 shape edits)
      version.ts                    # satisfiesMinVersion (verbatim)
      scan-commands.ts              # installed-commands-scan (ported; scanInstalledCommands → string[])
      scan-skills.ts                # installed-skills-scan (ported; +database-migrations curated §5.5.5d)
      claude-version.ts             # `claude --version` probe (ported; → string|null)
    habit/
      miner.ts                      # throttled corpus miner (+§5.5.6 desirability/dismissal/self-match)
      matcher.ts                    # deterministic trigger matcher (+optional Haiku fallback §5.5.6c)
      patterns-store.ts             # patterns.json read-merge-write (atomic, §7.6)
    jsonl/
      line-parser.ts                # the promptSource:"typed" gate (verbatim)
      session-reader.ts             # one session's typed prompts (§7.1 contract)
      corpus-reader.ts              # glob all projects (pillar 3)
    state/
      store.ts                      # state.json + mailbox/<session>.json + inbox (atomic write-temp-rename)
  data/catalog.json                 # the refreshable capability catalog (generated mirror of CAPABILITY_CATALOG)
  test/                             # vitest (per-file disposition §12) + golden-set (§5.5.8)
  dist/                             # tsc output — COMMITTED (the marketplace install needs runnable JS)
  package.json  tsconfig.json  README.md  LICENSE(MIT)
```

> `CAPABILITY_CATALOG` (the TS array) is the single source of truth for capabilities. `data/catalog.json`
> is a generated mirror for the documented refresh path; the runtime loads the catalog. Do not let the two
> diverge — generate `catalog.json` from the array at build.

---

## 11. Plugin packaging, install, and the `/coach` command (decisions #10, #12, #14)

### 11.1 Plugin manifest + hook registration (verified against ponytail/4.6.0 + 3 other installed plugins)
A real Claude Code plugin installs under `~/.claude/plugins/cache/<market>/<plugin>/<version>/`, so a bare
`node dist/hook.js` resolves against the user's cwd and is never found. Hooks are NOT registered in
`plugin.json` — they live in an auto-discovered `hooks/hooks.json`. Pin exactly:

`.claude-plugin/plugin.json` — metadata ONLY (ponytail's has only name/version/description/author):
```json
{ "name": "boris-says", "version": "1.0.0",
  "description": "Boris Says — the real-time coach in your corner. Boris Cherny watches how you drive Claude Code and speaks only when it matters. Local-only, no server.",
  "author": { "name": "TurniSaha", "email": "turni.saha@gmail.com" } }
```

`hooks/hooks.json` — path-anchored via `${CLAUDE_PLUGIN_ROOT}`, node-guarded, with a Windows variant:
```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ {
  "type": "command",
  "command": "command -v node >/dev/null 2>&1 && node \"${CLAUDE_PLUGIN_ROOT}/dist/hook.js\" || exit 0",
  "commandWindows": "if (Get-Command node -ErrorAction SilentlyContinue) { node \"$env:CLAUDE_PLUGIN_ROOT\\dist\\hook.js\" }",
  "timeout": 5
} ] } ] } }
```
The command path MUST match where the compiled file actually lands. We emit to `dist/` and commit it, so
the path is `${CLAUDE_PLUGIN_ROOT}/dist/hook.js` (NOT a flat `hooks/hook.js` — ponytail uses a flat
`hooks/` dir, but our build output is `dist/`; keep the path and the build output directory consistent).
Any spawned child (the judge) is likewise path-anchored via `${CLAUDE_PLUGIN_ROOT}` or the hook's
`__dirname` (§8.1). Re-verify the exact hooks.json/plugin.json schema against an installed plugin at build.

### 11.2 Marketplace manifest (so the plugin is installable)
The repo doubles as a single-plugin marketplace. `.claude-plugin/marketplace.json` (schema verified against
the installed `everything-claude-code` / `superpowers-marketplace` marketplaces — `owner` is an OBJECT,
the same-repo plugin uses `"source": "./"`):
```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "boris-says",
  "owner": { "name": "TurniSaha", "email": "turni.saha@gmail.com" },
  "metadata": { "description": "Boris Says — the real-time coach in your corner. Boris Cherny watches how you drive Claude Code and speaks only when it matters. Local-only, no server.", "version": "1.0.0" },
  "plugins": [ {
    "name": "boris-says",
    "source": "./",
    "description": "Boris Says — the real-time coach in your corner. Boris Cherny watches how you drive Claude Code and speaks only when it matters. Local-only, no server.",
    "version": "1.0.0",
    "license": "MIT"
  } ]
}
```
The plugin `name` here MUST equal the `name` in `.claude-plugin/plugin.json` and the argument users pass to
`/plugin install`. README install section + the §19 checklist document:
```
/plugin marketplace add TurniSaha/boris-says
/plugin install boris-says@boris-says
```

### 11.3 The `/coach` command (`commands/coach.md`, a plugin slash command)
Subcommands:
- `/coach status` — enabled state, last tip, cooldown remaining, # discovered patterns, **backend in use**
  (and whether metered API billing is active, §6.3).
- `/coach off` / `/coach on` — toggle `state.enabled` (the kill switch).
- `/coach dismiss` — mark the **last-surfaced HABIT pattern** `dismissed` (never resurfaces), keyed off
  `lastSurfacedPatternKey` (§7.6). v1 has no per-quality-tip accept/dismiss (Option A, §9b).
Implementation: the command runs a tiny node script (path-anchored) that read-merge-writes `state.json` /
`patterns.json` directly (§7.6). Verify the plugin command contract at build.

---

## 12. Test plan (TDD — write tests first) — per-source-file disposition

The two cascade/firing-gate suites cannot be reused as-is: they import DROPPED server seams
(`createRetrievalReader`, `Pool`, `PeopleRepo`, `WorkerNudgeDispatcher`, Fastify `buildService`, a real
Postgres container, worker tokens, `ServiceRedis`). Use this explicit disposition (the §5.5.7 regression
cases + §5.5.8 golden set are ADDED on top of these):

### 12.0 Toolchain + dependencies (PINNED — mirror the ported source, NOT ponytail)
The runtime must start fast (<100ms hook) and ship runnable JS into the published tree with **no install
step** (§11.1) — so the dependency footprint is deliberately tiny and pinned exactly:
- **Runtime deps: ZERO.** Use a **hand-rolled `fetch`** for the API backend (Node 18+ has global `fetch`),
  ported from `pm-service/src/llm/anthropic.ts` — do **NOT** add `@anthropic-ai/sdk` (it bloats startup and
  would require shipping `node_modules`, which a copied-tree plugin install cannot do).
- **Dev deps ONLY:** `typescript`, `vitest`, `@vitest/coverage-v8`, `@types/node`. Nothing else.
- **Module system: ESM** (matches the ported source). `package.json` `"type":"module"`; `tsconfig.json`
  sets BOTH `"module":"NodeNext"` AND `"moduleResolution":"NodeNext"`, `"target":"ES2022"`. ALL intra-repo
  imports use explicit `.js` specifiers (e.g. `import { ... } from './brain/judge-cascade.js'`), exactly as
  the existing `pm-service/test/*.test.ts` files do.
- **Node 18+** (for global `fetch`).
- **Runner: vitest, zero-config.** There is NO `vitest.config` in `pm-service` — do NOT add one (esbuild
  resolves the `.js` specifiers against NodeNext automatically). Pin `vitest` AND `@vitest/coverage-v8` to
  **`^2.1.8`** to match the source. `package.json` scripts: keep the source's `{ "test": "vitest run" }`
  (a `test:watch` is optional/net-new). New tests live in the top-level `test/` dir and import the source
  via `../src/...js`.

### (a) COPY VERBATIM — pure input/output, single trigger-module import, no Pool/Fastify/repos/worker-token
- `pm-service/test/judge-reflex.test.ts`
- `pm-service/test/version.test.ts`
- `pm-service/test/capability-catalog.test.ts`
- `pm-service/test/coach-liveness.test.ts` (adjust to the re-keyed `check(sessionId, text)` — §5/§15)
- `pm-service/test/prompt-coach-skill.test.ts`
- the `parseJudgeVerdict` cases extracted out of `judge-dispatch.test.ts` (`parseJudgeVerdict` is an
  independent export, used 8×; copy just those cases)

### (b) REWRITE against the new local seam (LlmBackend mock keyed by system prompt + on-disk state; no Pool/retrieval/ledger/rate-limit/worker dispatcher)
- the cascade/firing-gate behavior in `judge-dispatch.test.ts` (its `makeDeps` threads
  `createRetrievalReader` + a stub `Pool` into every case) → re-express against `judge-cascade.ts` (§15)
- `pm-service/test/mailbox-nudge.test.ts` — NOT pure: it imports `buildApp` (Fastify) +
  `generateSessionToken` (worker) + `WorkerNudgeDispatcher` and drives `app.inject`. Re-express its
  sentinel-banner / composite-ok / yield-to-quality semantics against the plugin's local mailbox + drain
  seam (§7.4, §8).

### (c) DO NOT PORT (server-coupled or dead-const guards) — write fresh local equivalents where noted
- `pm-service/test/judge-wired-e2e.test.ts` (`buildService` + Postgres container + worker token +
  `ServiceRedis`) — the plugin's own wired-e2e (below) is **NET-NEW**, not a port.
- `pm-service/test/judge-rate-limit.test.ts` (server `JudgeRateLimit`) — replaced by a fresh `state.json`
  cooldown test (v1 has no adaptive threshold, §9b).
- `pm-service/test/judge-nudge-outcome.test.ts` (`buildApp` + worker token + `CoachingOutcomesRepo`) — dropped.
- `pm-service/test/judge-dispatch-dead-const.test.ts` (a `readFileSync` source-hygiene guard tied to
  `pm-service/src`) — dropped.

### New local-seam tests (net-new)
- `line-parser` (THREE-tier gate, §1): `promptSource:"typed"` accepted; `system`/`queued`/`sdk` each
  rejected (tier 2); tool_result rejected; a top-level non-`user` type (e.g. `assistant`) rejected at
  tier 1 (`o.type !== 'user'`); and a `type:'user'` + `promptSource:'typed'` line whose nested
  `message.role !== 'user'` rejected at tier 3. A fixture line for EACH of the four `promptSource` values
  asserting the parser emits a typed-prompt event ONLY for `typed` and `[]` for `system`/`queued`/`sdk`.
  (THE SLASH-VISIBILITY guard — documents the load-bearing correction; the builder is not surprised to find
  non-system non-typed values, and locks the type/role tiers around the promptSource check.)
- `session-reader`: returns newest-first; consumer takes `verbatim` from stdin (NOT the file) and the
  prior-8 oldest-first with the current prompt excluded; **first-prompt-of-session with an empty/absent
  `.jsonl` still judges the stdin prompt**; a mid-session case proving the judge scores the current stdin
  prompt, not the last file-written line.
- `corpus-reader`: globs multiple project dirs; sessionId derived from filename; watermark bound.
- `miner`: throttle (no-op when <MIN_NEW_EVENTS or within cooldown → zero LLM); JSON parse
  (valid/empty/malformed → no-op); drops <3-distinct-session patterns; drops empty-fix; drops
  empty-`why_inefficient` (§5.5.6a); dismissal-similarity gate drops a phrasing-drifted dismissed habit
  (§5.5.6b); upsert dedupes by `habit_key`; read-merge-write never re-opens `dismissed` and never regresses
  `surfaced`→`open` (§7.6). (Mock the LlmBackend.)
- `matcher`: exact-equality fires; ≥4-token whole-word match fires; short raw-substring coincidence does
  NOT fire; unrelated does NOT fire.
- `patterns-store` / `state/store`: atomic write-temp-rename; concurrent-writer + dismiss-vs-miner merge
  safety (`dismissed` wins, §7.6); round-trip; status transitions.
- `capability`: `resolveCapability` matches id OR trigger (fold-insensitive, id FIRST); `disk_command` with
  `installedCommands == null` → `available:false` (fail-CLOSED); version-gated null `cliVersion` available
  only when `minVersion===null && removedIn===null`; a `removedIn` capability with null/unparseable
  `cliVersion` HIDDEN; launch-only dropped mid-session (§5.5.5a); model-gate (§5.5.5b); skill-wins; cost
  clause survives `NUDGE_CAP`. Assert `RUBRIC_DIMENSIONS.length === 9`, `skill_fit` present, and the full
  ordered id list (locks the byte-stable `JUDGE_SYSTEM` baseline). Assert `CAPABILITY_CATALOG.length === 25`
  with exactly TWO `removedIn` entries (`/vim`, `/output-style`, both `2.1.92`) and NO `/pr-comments` entry (§20).
- `version`: `satisfiesMinVersion` null/unparseable → fail-closed.
- `backend`: CLI path (`claude -p --bare`) used by default; raw API path ONLY when `PROMPT_COACH_USE_API`
  set + key present; null backend silent when neither; alias→id mapping; throw→null at
  boundary + cascade null-guards (prospect null → silence, judgment null → fail-closed); recursion guard
  (`PROMPT_COACH_JUDGING=1` → hook/judge exit at top).
- `hook`: drain prints + clears mailbox; detach writes inbox file (unique name) + spawns judge + returns
  fast (<100ms); disabled flag → no-op; never throws. **Detach survival:** the spawned judge completes
  after the hook process exits (§8.5).
- `mailbox-format`: `formatCoachBanner` wraps then pads to 50; an un-splittable >50-char token is clipped;
  ANSI present; stripped fallback reads as a padded block.
- **§5.5.7 regression cases** (structural ones as units; model-judgment ones env-gated real-LLM).

### Wired e2e (mocked LLM — NET-NEW, not a port)
Seed 3 distinct-session fixture `.jsonl` files each with a typed "next-session prompt" ask → run miner →
assert a `patterns.json` entry with `trigger='prompt_recurring:context-handoff:next-session-prompt'`,
occurrenceCount 3, ≥3 distinct sessionIds, non-empty fix + non-empty `why_inefficient` → simulate a 4th
matching typed prompt (supplied via the inbox-file payload) → assert the habit tip is deposited + cites
"last 3 sessions" → assert quality cooldown untouched (no-budget-bleed).

### Env-gated real-LLM smoke + golden set (final DoD gate — see §18 gate 6, §5.5.8)
- Gate with `const real = it.skipIf(!process.env.RUN_REAL)` (skipped by default = zero spend).
- Force the **API backend** when `ANTHROPIC_API_KEY` present (else skip the test). Per-test timeout **30s**.
- Smoke: assert STRUCTURAL invariants only (model output is non-deterministic):
  - quality: tip non-null AND `0 < len ≤ NUDGE_CAP` AND not the sentinel reply AND mailbox `kind==='quality'`.
  - miner: returns an ARRAY; EVERY entry has a non-empty `fix` + non-empty `why_inefficient` AND ≥3 distinct
    sessionIds; and the NEGATIVE: NO entry whose `fix` is empty or whose `habit` matches
    `/write (long|longer) prompts/`.
- Golden set (§5.5.8): the ~19 labeled prompts; assert precision ≥ 0.9, expert-subset silence recall = 1.0,
  0 banned phrases. Commit the labeled set + metrics report as the calibration artifact.
- Expected spend ballpark **~$0.02** for the smoke (matches the parent project's REAL-PM validation); the
  golden set is a few cents more. The human runs these once as the final DoD gate.

### Build-time spikes (do these EARLY, before locking the affected file)
- **Spike A** (`claude -p`): real JSON output shape + the hooks-disable mechanism + recursion-guard proof.
- **Spike B** (hook output): confirm the ANSI `formatCoachBanner` panel renders via the stdout path in a
  real session (output field is already pinned to stdout — §8.2; this only verifies rendering).

---

## 13. What's explicitly DROPPED (do not rebuild)

room, firehose, Redis, consumer/source-normalizer, reducers/world-model cycle, team digest, worker
broadcast, EC2 pm-service, Postgres, pgvector/RAG retrieval, `PeopleRepo`, `(room_id,user_id)` keying,
next-turn server round-trip, the extension's server-POST hook body, `CoachingOutcomesRepo` +
`judge-nudge-outcome` + the adaptive per-dev threshold (§9b), **`NudgeLedger`** (the per-person aggregate
ceiling + its refund-on-dispatch-failure path, `judge-dispatch.ts:502,567`), and **`JudgeRateLimit`** (the
server cooldown + `leverUsedInSession`/`recordLever`/`thresholdFor` store). Cross-PERSON/team habits and
auto-APPLYING a fix are DEFERRED (out of v1 scope, single-user product).

> **Local re-implementation of the two dropped rate stores (so the firing gate has no dangling seam, §5.1
> step 7):** the server's `JudgeRateLimit` collapses into plain `state.json` fields — the per-prompt quality
> **cooldown** (`state.lastQualityNudgeAt`, default 10 min) and the per-session **same-lever** set
> (`state.leversUsedBySession[sessionId]: string[]`). The `NudgeLedger` **aggregate ceiling is removed
> outright** (no local equivalent); reflex + cooldown + §5.5 precision bound the fire-rate instead. There is
> NO `thresholdFor` (static `skill.preRunConfidence`, §9b) and NO refund path (nothing to refund).

---

## 14. `formatCoachBanner` extraction scope (exact — keyed to `pm-service/src/coach/mailbox-nudge.ts`)

The source file is `pm-service/src/coach/mailbox-nudge.ts` (note the `coach/` segment; this reconciles
§5.3's `mailbox-nudge.ts` reference with the §10 target `brain/mailbox-format.ts`). It contains BOTH a
formatter and an in-memory FIFO. Extract ONLY the formatting half into `src/brain/mailbox-format.ts`:
- `export function formatCoachBanner` (line 92)
- its private helpers `panelLine` (line 64) and `wrapBody` (line 70)
- the private consts they depend on: `ESC` (54), `RESET` (55), `PANEL_WIDTH = 50` (56), `TITLE` (59),
  `BODY` (61)

DROP everything from line 104 onward — `QUEUE_CAP`, `TTL_MS`, `MAX_KEYS`, `KEY_SEP`, `QueuedNudge`, the
`MailboxNudge` interface, and `createMailboxNudge` (the in-memory FIFO) — replaced by the on-disk mailbox.

Behavior to preserve: `formatCoachBanner` calls `wrapBody(message, PANEL_WIDTH)` FIRST, so multi-line/long
messages are soft-wrapped to ≤50 cols BEFORE rendering; `panelLine` then `padEnd`s short lines to 50 and
only `slice(0,50)`-clips a single un-splittable token longer than 50 chars (a defensive backstop, not the
normal path). Port BOTH helpers so the wrap-then-pad/clip contract holds. The source `service.ts` imports
`{ createMailboxNudge, formatCoachBanner }` from `./coach/mailbox-nudge.js` (line 46) and uses
`formatCoachBanner` at line 469; the new plugin imports `formatCoachBanner` from
`brain/mailbox-format.ts` only (no FIFO).

---

## 15. The `judge-cascade.ts` exported contract (pin it — replaces `createJudgeDispatch`)

Source export: `createJudgeDispatch(deps): (events: readonly NormalizedEvent[]) => void` — a SYNC
fire-and-forget BATCH consumer that maps events→candidates via `toCandidate` (checks `ev.kind==='prompt'`,
`ev.userId`, builds `{roomId,userId,sessionId,text,source}`) and uses `track`/`onError`/`onObserve`/
`nudgeDispatcher`/`coachingOutcomesRepo` seams. Locally there is ONE prompt, no batch, no `NormalizedEvent`,
no roomId/userId/source. Pin the NEW contract:

```ts
// src/brain/judge-cascade.ts
export async function runQualityCascade(input: {
  prompt: string;                       // the stdin `prompt` (§4) — the verbatim
  transcript: readonly string[];        // prior typed prompts, oldest-first, current excluded (§7.1)
  backend: LlmBackend;                  // §6
  skill: PromptCoachSkill;              // PROMPT_COACH_SKILL (verbatim brain + §5.5 data edits)
  state: CoachState;                    // on-disk cooldowns/flags (replaces rate-limit + ledger)
  catalog: MergedSkillCatalog;          // installed-skills merge (+database-migrations curated §5.5.5d)
  capabilities: readonly Capability[];  // available-to-this-dev (§16/§17; launch-only dropped mid-session §5.5.5a)
  sessionId: string;                    // the surviving identity (decision #6)
  now: () => number;
  localContext?: {                      // the §8.6 probe — ALL fields OPTIONAL/nullable; unknown allowed
    activeModel?: string | null;        // `message.model` from assistant lines (e.g. 'claude-opus-4-8')
    mode?: string | null;               // permissionMode / `mode` line (e.g. 'normal' | 'plan' | 'bypassPermissions')
    effort?: string | null;             // the `effort` field if present
    git?: {
      onBranch?: boolean | null;        // is HEAD on a (non-detached) branch
      dirty?: boolean | null;           // `git status --porcelain` non-empty
      branch?: string | null;           // current branch name
    } | null;
    project?: {
      claudeMdPresent?: boolean | null; // <cwd>/CLAUDE.md exists
      testCmdDocumented?: boolean | null; // CLAUDE.md / settings.json documents a test command
      planModeMandated?: boolean | null;  // project config mandates plan mode
      hooksConfigured?: boolean | null;   // .claude/settings.json shows hooks
    } | null;
  };
}): Promise<{ tip: string } | null>;
```

Rules:
- (a) `roomId`/`userId`/`source`/`onObserve`/`onError`/`track`/`nudgeDispatcher`/`coachingOutcomesRepo` are
  REMOVED from the dep surface. (`observe(...)` becomes a local no-op or a debug logger; the §5.5
  `observe('firing_gate_suppressed')` / `observe('prospector_suppressed')` calls become local debug logs.)
- (b) the cascade RETURNS the composed tip (or null); the local caller (`judge.ts`) — NOT an injected
  dispatcher — deposits it into the mailbox.
- (c) liveness's first-seen-ping de-dup key MIGRATES from `roomId` to `sessionId`:
  `createCoachLiveness().check(sessionId, text)` (the source keys on `roomId + sessionId` at
  `coach-liveness.ts:96`; locally only `sessionId` survives — §5 step 1).
- (d) rate-limit / people lookups that were keyed on `(roomId,userId)` become the single local session/
  person identity (`sessionId` for per-session cooldowns; person = the one user, global). `rollingSummary`
  is `''` (no server profile). The firing gate uses the STATIC `skill.preRunConfidence` (§9b).
- (e) the optional `localContext` (the §8.6 probe) threads into the existing §5.5.5 capability gates and
  the L25/L01/L26 levers. Specifically: `localContext.activeModel` is what the §5.5.5(b) `modelFamily` gate
  already wants (it drives `CapabilityPerson`'s active-model field so model-scoped flags resolve
  `available:false` out of scope); `localContext.mode` and `localContext.effort` feed L25 (effort/mode-fit)
  and let the judge SUPPRESS a "use plan mode" nudge when `mode === 'plan'`. ALL fields are OPTIONAL and
  may be `null`/`unknown`; **an unknown signal must NEVER fire a lever** — unknown is treated as "no signal"
  → lean silent (§8.6 fail-safe, preserves the positive-evidence rule). A missing `localContext` (the field
  is absent entirely, e.g. a test harness that does not supply it) leaves every lever exactly as it is today.

Without (a)-(e) the cascade's signature and identity-threading are undefined and not portable.

---

## 16. Capability resolver contract (pin it — id-vs-trigger + null semantics; verified against source)

`resolveCapability(idOrTrigger: string, person: { installedCommands: readonly string[] | null; cliVersion: string | null }, catalog?: readonly Capability[]): { available: boolean; capability: Capability | null }`.

- **Matching rule (the S16 fix):** match on EITHER the canonical `id` OR the exact `trigger`
  (fold-insensitive, id tried FIRST). The Sonnet judge echoes the TRIGGER form (e.g. `/design-sync`), not
  the bare id, so `verdict.capability_fit.candidate_capability` arrives as a trigger on the receive path
  (`judge-dispatch.ts:505-520`). Without trigger-matching, every `slash_command`/`cli_flag` where
  trigger ≠ id silently resolves not-found and is dropped from the nudge.
- **null semantics are FAIL-CLOSED (verified — the opposite of "available by default"):**
  - `disk_command`: `installedCommands == null` means "machine never scanned → cannot confirm →
    `available:false` (HIDDEN)" (`resolveCapability` body). null is NOT "available-by-version" —
    disk_commands have no version fallback. Upholds the trust-hazard invariant "never surface a capability
    we cannot confirm THIS dev has" (catalog header lines 10-15).
  - `builtin_version`/`universal_version`: a `removedIn` capability with an unparseable/null `cliVersion`
    is HIDDEN (we cannot confirm we are before the removal). For non-removed: null `cliVersion` is available
    ONLY when `minVersion===null` (truly long-stable). Do NOT cite the `CapabilityAvailability` enum doc
    comment as the null rule.
- **Local wiring (correct filenames):** the judge builds `capabilityPerson` from the extension probes
  ported as `scan-commands.ts` (`scanInstalledCommands(): Promise<string[]>`, never null) and
  `claude-version.ts` (`claudeCliVersion(): Promise<string | null>`), run AT JUDGE TIME in the background
  process. They surface as `installedCommands: string[] | null` / `cliVersion: string | null` (null = never
  scanned, the safe fail-closed default). NOTE: the source filename is
  `upstream-extension/src/installed-commands-scan.ts` (§0.1 row 10) — there is no source file literally
  named `scan-commands.ts`.
- §5.5.5 extends this shape with `appliesAt` (launch/in_turn) and an optional `modelFamily` gate; both
  resolve to `available:false` when out of context.

---

## 17. Pillar 2 — capability awareness (wiring)

Port `capability-catalog.ts` + `version.ts` (already SHIPPED + tested server-side). Woven INTO the pillar-1
quality tip — **no separate channel, no separate budget** (the source design's hard constraint). Capability
fitness hardening: §5.5.5.

- **Catalog as data (decision #11):** the runtime loads `CAPABILITY_CATALOG` (25 entries across 5 kinds:
  `slash_command` ×15, `authoring` ×4, `cli_flag` ×2, `keyword` ×2, `mode` ×2). `data/catalog.json` is a
  generated mirror for the documented refresh path (re-pull official `code.claude.com/docs/llms.txt`).
  `version.ts satisfiesMinVersion` ported verbatim (fail-closed on null/unparseable).
- **Local availability scan (at judge time, in the background process):** `scan-commands.ts`
  (5 plugin roots, `.opencode`/`docs` excluded, nested→leaf id, cap 200) + `claude-version.ts`
  (`claude --version`, 5s timeout, leading-semver parse). Filter the catalog to what is available to THIS
  developer (`resolveCapability` — match id OR trigger; null = fail-closed — §16; launch-only/model-gated
  dropped per §5.5.5).
- **Judge integration:** pass the available-capabilities list into `JUDGE_SYSTEM` (the `capability_fit`
  slot already exists in the ported verdict). When the judge names a capability, render it inside the tip
  with its cost clause when billed (`BILLED_COST_CLAUSE = ' (uses extra usage)'`,
  `EXPENSIVE_COST_CLAUSE = ' (runs a multi-agent cloud job — uses extra usage)'`). **Skill wins over
  capability** when both fit. Cost is DISCLOSED, never a gate.

---

## 18. Definition of Done (v1 acceptance) — manual, observable gates

Green unit tests with a mocked LLM and mocked filesystem prove NONE of the hook-registration / detach /
drain-next-turn / ANSI-survives-stdout behavior that is the entire point ("green ≠ deployed"). v1 is done
ONLY when ALL of these manual gates pass on a real macOS/Linux machine with real Claude Code:

1. **Install + registration (infra).** `/plugin marketplace add TurniSaha/boris-says` then
   `/plugin install boris-says@boris-says` succeeds; the `UserPromptSubmit` hook fires
   (verify by logging from the hook).
2. **Next-turn surface (pillar 1).** On a FRESH session, type a deliberately weak prompt P1, then any
   prompt P2 → a 🐾 panel appears at P2; `mailbox/<sid>.json` is created (after P1's judge runs) then
   emptied (at P2's drain).
3. **Non-blocking + detach (pillar 1 / infra).** The hook returns in **<100ms** (measure); the judge runs
   detached (parent exits before the judge finishes the 5–8s cascade — confirm via a judge-written
   sentinel file timestamped after the hook returned).
4. **Kill switch + status (decision #10/#14).** `/coach off` → no tip on subsequent weak prompts;
   `/coach status` shows the backend in use (and metered-billing state if API).
5. **Backend fallback (decision #3).** With CLI default (no `PROMPT_COACH_USE_API`) and `claude` on PATH,
   a real tip is produced; with neither a usable backend nor `claude`, silent no-op, zero errors.
6. **Habit pillar end-to-end + calibration (pillar 3 + quality).** Seed real `~/.claude/projects` history
   (or fixtures), force a mine (lower the throttle for the test) → `patterns.json` gains an entry → a
   matching live typed prompt surfaces a cited habit tip ("…in your last N sessions — <fix>"). Then run the
   env-gated real-LLM smoke (§12) and the §5.5.8 golden set once and confirm precision ≥ 0.9, expert-subset
   silence recall = 1.0, 0 banned phrases.

---

## 19. Build readiness checklist (for Codex review before coding)

- [ ] §0.1 Source-of-truth map read; byte-exact constants (PROSPECTOR_SYSTEM, JUDGE_SYSTEM, RUBRIC ids)
      copied from the canonical paths and **checksum-verified** against the BASELINE source before §5.5 edits.
- [ ] LlmBackend interface + 3 impls (API opt-in / CLI default / null); throw→null at boundary + cascade
      null-guards; alias→id map; recursion guard pinned.
- [ ] `promptSource:"typed"` STRICT-equality gate ported verbatim + a 4-value SLASH-VISIBILITY test
      (`typed` only; `system`/`queued`/`sdk` excluded).
- [ ] Current prompt taken from stdin `prompt` (§4); session `.jsonl` used ONLY for prior transcript;
      first-prompt-of-session test passes.
- [ ] hook→judge payload via per-invocation **inbox file** (atomic, unique name, judge unlinks); argv/env
      for prompt text FORBIDDEN; detach `{detached,stdio:'ignore',windowsHide,unref}`; detach-survival test.
- [ ] State = atomic JSON files; mailbox per session; inbox per invocation; separate quality vs habit
      cooldowns; quality wins tie; `patterns.json` read-merge-write (`dismissed` wins) (§7.6).
- [ ] Capability: `CAPABILITY_CATALOG`(25) is the source of truth; `data/catalog.json` generated mirror;
      `resolveCapability` id-OR-trigger + fail-closed null (§16); launch-only/model-gate (§5.5.5);
      skill-wins; cost disclosed.
- [ ] Adaptive `thresholdFor` DROPPED → static `skill.preRunConfidence`=0.6 (§9b); no outcomes repo;
      precision protected via §5.5 calibration + golden set.
- [ ] §5.5 calibration edits applied as DATA (`PROMPT_COACH_SKILL`) + the named CODE gates; version bumped.
- [ ] `/coach off|on|status|dismiss`; surface-once auto; dismissed never resurfaces; status shows backend.
- [ ] Current model ids fixed (no stale `claude-opus-4-1`); CLI uses `haiku`/`sonnet` aliases.
- [ ] Plugin packaging: `plugin.json` metadata-only; `hooks/hooks.json` `${CLAUDE_PLUGIN_ROOT}/dist/hook.js`
      + `commandWindows`; `.claude-plugin/marketplace.json` (`owner` object, `source:"./"`); `dist/`
      committed. Schemas re-verified against an installed plugin/marketplace at build.
- [ ] `formatCoachBanner` extracted ONLY (FIFO dropped) per §14; tip output = plain stdout per §8.2.
- [ ] Spikes A & B scheduled before the files they affect are locked.
- [ ] Tests: per-file disposition (§12 copy/rewrite/drop) + new local seams + §5.5.7 regressions + wired
      e2e + env-gated real smoke + §5.5.8 golden set (skipIf, 30s, structural invariants + precision gate).
- [ ] §18 Definition-of-Done manual gates run on a real machine before declaring v1 done.
- [ ] README: install commands, the cost note (CLI default = no per-call charge on a subscription;
      `PROMPT_COACH_USE_API` opt-in = metered raw API with cleaner fidelity; disclosed in `/coach status`), the
      catalog-refresh path, the `/coach` controls, the v1 platform scope (macOS/Linux), privacy (all local).

---

## 20. Catalog accuracy note (the phantom `/pr-comments`)

`CAPABILITY_CATALOG` (the TS array in `pm-service/src/triggers/capability-catalog.ts`) is the single source
of truth: exactly **25** entries across 5 kinds (`slash_command` ×15, `authoring` ×4, `cli_flag` ×2,
`keyword` ×2, `mode` ×2) with exactly **TWO** `removedIn` entries (`/vim` and `/output-style`, both
`2.1.92`). Do NOT introduce a separate hand-authored `catalog.json` that diverges. The source file's own
doc-comment (`capability-catalog.ts:81`) erroneously lists THREE removals "(/vim, /output-style,
/pr-comments)" — there is NO `/pr-comments` entry in the array. When porting, fix that comment to
"(/vim, /output-style)" and do NOT add a phantom `/pr-comments` capability. (If the upstream design doc
`docs/superpowers/specs/2026-06-21-capability-awareness-design.md:260` §9 is touched, fix the same prose
there.) A port test asserts `CAPABILITY_CATALOG.length === 25` and that no `/pr-comments` trigger exists.
