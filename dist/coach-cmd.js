/**
 * src/coach-cmd.ts -> dist/coach-cmd.js — the tiny CLI behind the `/coach` slash
 * command (SPEC §11.3, decision #10).
 *
 * argv[2] is the subcommand: off | on | status | build | dismiss | 👍/up/good | 👎/down/bad | undo.
 *   off      — state.enabled := false (kill switch)
 *   on       — state.enabled := true
 *   build    — M3: write the last-surfaced (or argv[3]-named) habit's drafted
 *              primitive as a REVIEW file (never activates; see habit/draft-writer.ts)
 *   status   — print enabled state, last tip time, quality/habit cooldown remaining,
 *              count of discovered patterns, the backend in use (§6.3), + per-lever feedback.
 *   dismiss  — mark the last-surfaced HABIT pattern dismissed (markDismissed), keyed
 *              off state.lastSurfacedPatternKey (§7.6). No-op when none is set.
 *   👍/up/good   — F-FEEDBACK: rate the LAST quality tip helpful (lowers that lever's floor
 *                  after ≥N ratings → it fires more); appends a labeled feedback anchor.
 *   👎/down/bad  — F-FEEDBACK: rate the LAST tip unhelpful (raises that lever's floor → fires
 *                  less); appends a labeled feedback anchor for the offline eval.
 *   undo     — F-FEEDBACK: revert the most recent rating.
 *
 * Contract: this never throws. Every branch is guarded; the store/patterns reads
 * already return defaults on missing/corrupt files. An unknown/empty subcommand
 * prints usage and exits 0. The process always exits 0 so the slash command never
 * surfaces a stack trace to the user.
 *
 * Path-anchored: it imports the same state/patterns/backend modules the hook+judge
 * use, and resolves the base dir via resolveBaseDir (PROMPT_COACH_DIR override for
 * tests, else ~/.claude/prompt-coach). State/index resolution is never cwd-relative;
 * the `find` exclusion scan may best-effort include cwd (./.claude/skills) — read-only,
 * and a wrong cwd only means fewer exclusions, never wrong state.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBaseDir } from './config.js';
import { parseFeedbackAnchors, selectTasteExamples } from './brain/taste.js';
import { loadSkillIndexWithProvenance, sanitizeExternalText, } from './capability/skill-index.js';
import { matchExternalSkills } from './capability/skill-index-matcher.js';
import { createStore, QUALITY_COOLDOWN_MS, HABIT_COOLDOWN_MS, DIR_MODE, FILE_MODE, } from './state/store.js';
import { resolveWatch, WATCH_MIN_PROMPTS, WATCH_MIN_SESSIONS } from './state/watch.js';
import { createPatternsStore } from './habit/patterns-store.js';
import { writeDraft as writeDraftFile, installInstructions, } from './habit/draft-writer.js';
/**
 * Resolve which backend NAME would be selected, replicating createLlmBackend's
 * §6.3 precedence WITHOUT constructing one (status only needs the label, not a
 * live backend). `claudeOnPath` is injected so a test never spawns `claude`.
 */
export function resolveBackendName(env, claudeOnPath) {
    const apiKey = env.ANTHROPIC_API_KEY;
    const useApi = Boolean(env.PROMPT_COACH_USE_API);
    if (useApi && typeof apiKey === 'string' && apiKey.length > 0)
        return 'api-metered';
    if (claudeOnPath())
        return 'cli';
    return 'null';
}
/** Human-facing label for a resolved backend name (the `null` token reads as a bug otherwise). */
export function describeBackend(name) {
    switch (name) {
        case 'api-metered':
            return 'api-metered (metered API billing active)';
        case 'cli':
            return 'cli (Claude subscription — no per-call charge)';
        case 'null':
            return 'none (claude CLI not found and no API key — coaching paused)';
    }
}
/** Real probe: is `claude` on PATH? Fail-closed on any error (never throws). */
function defaultClaudeOnPath() {
    try {
        const r = spawnSync('claude', ['--version'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true,
        });
        return r.status === 0;
    }
    catch {
        return false;
    }
}
function fmtTime(ms) {
    if (ms === null)
        return 'never';
    try {
        return new Date(ms).toISOString();
    }
    catch {
        return 'never';
    }
}
/** Human cooldown-remaining string: "ready" when off cooldown, else "Nm Ss left". */
function fmtCooldownRemaining(lastAt, windowMs, now) {
    if (lastAt === null)
        return 'ready';
    const remaining = windowMs - (now - lastAt);
    if (remaining <= 0)
        return 'ready';
    const totalSec = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s left`;
}
/** The three feedback subcommand aliases the owner can type. */
const GOOD_ALIASES = new Set(['👍', 'up', 'good', '+1', 'yes']);
const BAD_ALIASES = new Set(['👎', 'down', 'bad', '-1', 'no']);
/** Human label for a draft kind in `/coach build` output (mirrors the tip). */
const DRAFT_KIND_LABEL = {
    skill: 'skill',
    claude_md_rule: 'CLAUDE.md rule',
    hook: 'hook',
};
/**
 * Pure-ish command runner: every effect is injected so a test drives it with a
 * tmpdir store, a fake clock, a stubbed claudeOnPath, and a capturing `out`.
 * Returns nothing; communicates only through the injected store/patterns + `out`.
 * NEVER throws — each branch is self-contained and the stores never throw.
 * `extraArg` is the optional argv[3] (today: the habit_key for `build`).
 */
export function runCoachCmd(subcommand, deps, extraArg) {
    const { store, patterns, env, now, claudeOnPath, out } = deps;
    const sub = (subcommand ?? '').trim().toLowerCase();
    // G-M4b: resolve the external index WITH provenance. Seam precedence: the
    // provenance-aware seam, then the plain seam (provenance defaults 'committed'),
    // then the real prefer-runtime loader.
    const loadIndexLoaded = () => {
        if (deps.loadSkillIndexWithProvenance)
            return deps.loadSkillIndexWithProvenance();
        if (deps.loadSkillIndex) {
            const idx = deps.loadSkillIndex();
            return idx === null ? null : { index: idx, source: 'committed' };
        }
        return loadSkillIndexWithProvenance(resolveBaseDir(env));
    };
    switch (sub) {
        case 'off': {
            store.saveState({ ...store.getState(), enabled: false });
            out('coach: OFF (kill switch on — no tips will be surfaced)');
            return;
        }
        case 'on': {
            store.saveState({ ...store.getState(), enabled: true });
            out('coach: ON');
            return;
        }
        case 'dismiss': {
            const key = store.getState().lastSurfacedPatternKey;
            if (!key) {
                out('coach: nothing to dismiss (no habit pattern surfaced yet)');
                return;
            }
            patterns.markDismissed(key);
            out(`coach: dismissed habit pattern "${key}" (it will not resurface)`);
            return;
        }
        case 'build': {
            // M3: write the drafted primitive as a REVIEW file (never activates).
            // Key resolution: explicit arg wins, else the last-surfaced habit.
            const key = (extraArg ?? '').trim() || store.getState().lastSurfacedPatternKey;
            if (!key) {
                out('coach: nothing to build (no habit surfaced yet — pass a habit_key or wait for a nudge)');
                return;
            }
            const pattern = patterns.readPatterns().find((p) => p.habit_key === key);
            if (!pattern) {
                out(`coach: unknown habit "${key}" (nothing built)`);
                return;
            }
            if (pattern.status === 'dismissed') {
                out(`coach: habit "${key}" is dismissed — refusing to build its draft`);
                return;
            }
            if (!pattern.draft) {
                out(`coach: no draft attached to "${key}" (advice-only habit — nothing to build)`);
                return;
            }
            const writer = deps.writeDraft ??
                ((d, k) => writeDraftFile(d, k, deps.homeDir ?? homedir(), resolveBaseDir(env)));
            const result = writer(pattern.draft, key);
            if (result.error !== undefined || result.path === undefined) {
                out(`coach: could not write the draft (${result.error ?? 'no path'}) — nothing changed`);
                return;
            }
            const label = DRAFT_KIND_LABEL[pattern.draft.kind] ?? pattern.draft.kind;
            if (result.existed) {
                out(`coach: draft ${label} for "${key}" already written — left untouched:`);
            }
            else {
                out(`coach: draft ${label} for "${key}" written for REVIEW (not activated):`);
            }
            out(`  ${result.path}`);
            for (const line of installInstructions(pattern.draft, result.path))
                out(`  ${line}`);
            out(`  reject: /coach dismiss (the habit never resurfaces)`);
            return;
        }
        case 'undo': {
            const undone = store.undoLastRating();
            if (undone === null) {
                out('coach: nothing to undo (no recent rating)');
                return;
            }
            out(`coach: undid the last ${undone.rating === 'good' ? '👍' : '👎'} on "${undone.lever}"`);
            return;
        }
        case 'find': {
            // M4: offline external-skill search — no LLM, exits 0 on every input.
            const query = (extraArg ?? '').trim();
            if (query.length === 0) {
                out('usage: /coach find <query>');
                return;
            }
            const loaded = loadIndexLoaded();
            if (loaded === null) {
                // The index ships committed with the plugin, so this is rare — a missing/corrupt
                // data file. Point at the fix a plugin user can actually take (reinstall), not the
                // dev-only npm workflow.
                out('coach: external skill index not available (reinstall the plugin to restore it)');
                return;
            }
            const index = loaded.index;
            // Installed-catalog-wins: drop the dev's installed skill ids (best-effort scan —
            // an error degrades to NO exclusions, never a throw). Curated overlap is NOT
            // excluded here (the dev explicitly asked to search the outside world).
            let excluded;
            try {
                const installed = (deps.installedSkillIds ?? defaultInstalledSkillIds(deps))();
                excluded = new Set(installed.map(foldId));
            }
            catch {
                excluded = new Set();
            }
            const hits = matchExternalSkills(query, index, excluded, undefined, { userInitiated: true });
            if (hits.length === 0) {
                out(`coach: no matching external skills for "${query}"`);
                return;
            }
            // Defense-in-depth: strip control chars / ANSI escapes before printing (the loader
            // sanitizes too, but an injected index in tests/deps must not reach the terminal raw).
            for (const h of hits) {
                // G-M4b: the review line labels the trust so a community (unverified
                // third-party) hit is never mistaken for a vetted official one.
                const trustLabel = h.trust === 'official' ? 'official' : 'community';
                const suffix = h.repoStars !== null ? ` (${trustLabel} · ★ ${h.repoStars})` : ` (${trustLabel})`;
                out(`${sanitizeExternalText(h.name)} — ${sanitizeExternalText(h.description).slice(0, 120)}`);
                out(`  review: ${sanitizeExternalText(h.sourceUrl)}${suffix}`);
                out(`  install: ${sanitizeExternalText(h.install)}`);
            }
            return;
        }
        case 'status': {
            const s = store.getState();
            const backend = resolveBackendName(env, claudeOnPath);
            const allPatterns = patterns.readPatterns();
            const patternCount = allPatterns.length;
            out(`coach: enabled=${s.enabled}`);
            out(`backend: ${describeBackend(backend)}`);
            out(`last tip: ${fmtTime(s.lastQualityTipAt)}`);
            out(`quality cooldown: ${fmtCooldownRemaining(s.lastQualityTipAt, QUALITY_COOLDOWN_MS, now)}`);
            out(`habit cooldown: ${fmtCooldownRemaining(s.lastHabitNudgeAt, HABIT_COOLDOWN_MS, now)}`);
            out(`discovered patterns: ${patternCount}`);
            // M4: external-skill index visibility (entries + refresh date, or absent).
            // G-M4b: counts split by trust + a '(runtime copy)' label when the prefer-runtime
            // loader chose the auto-refreshed copy over the shipped one.
            const loadedIndex = loadIndexLoaded();
            if (loadedIndex !== null) {
                const officialCount = loadedIndex.index.entries.filter((e) => e.trust === 'official').length;
                const communityCount = loadedIndex.index.entries.length - officialCount;
                const runtimeLabel = loadedIndex.source === 'runtime' ? ' (runtime copy)' : '';
                out(`external index: ${loadedIndex.index.entries.length} entries (${officialCount} official, ` +
                    `${communityCount} community), refreshed ${loadedIndex.index.generatedAt.slice(0, 10)}${runtimeLabel}`);
            }
            else {
                out('external index: not available');
            }
            // G-M4b: the background auto-refresh state (kill switch + last-attempt watermark).
            const refreshOff = typeof env.PROMPT_COACH_NO_INDEX_REFRESH === 'string' &&
                env.PROMPT_COACH_NO_INDEX_REFRESH.length > 0;
            out(refreshOff
                ? 'index auto-refresh: off (PROMPT_COACH_NO_INDEX_REFRESH)'
                : `index auto-refresh: on, last attempt ${fmtTime(s.lastIndexRefreshAt)}`);
            // M3: pending drafts — rescues the "surfaced once, tip missed" orphan case;
            // `/coach build <habit_key>` closes it fully.
            const pending = allPatterns.filter((p) => p.status !== 'dismissed' && p.draft);
            if (pending.length > 0) {
                out(`drafts pending: ${pending.length} (${pending.map((p) => p.habit_key).join(', ')})`);
            }
            // W2-LEVEL1: how many taste examples are currently active in the live judge prompt.
            if (deps.readFeedbackAnchorsText) {
                const active = selectTasteExamples(parseFeedbackAnchors(deps.readFeedbackAnchorsText()), now).length;
                out(`taste examples active: ${active}${active === 0 ? ' (cold start — rate more tips to teach your taste)' : ''}`);
            }
            // F-FEEDBACK: per-lever ratings + the learned floor delta (the live self-tuning state).
            const fb = s.feedbackByLever ?? {};
            const levers = Object.keys(fb).sort();
            if (levers.length > 0) {
                out('feedback (per lever 👍/👎 → floor delta):');
                for (const lv of levers) {
                    const d = store.floorDeltaForLever(lv);
                    const sign = d > 0 ? `+${d.toFixed(2)} (fires less)` : d < 0 ? `${d.toFixed(2)} (fires more)` : '0 (no change yet)';
                    out(`  ${lv}: 👍${fb[lv].good} 👎${fb[lv].bad} → ${sign}`);
                }
            }
            // M5: watch-first critique mode — window state + the withheld peek. resolveWatch
            // is PURE (a null watch resolves migration-aware, nothing is written): status
            // never mutates state.
            const watch = resolveWatch(s, now);
            if (watch.closedAt === null) {
                out(`critique mode: watching (${watch.promptsObserved}/${WATCH_MIN_PROMPTS} prompts, ` +
                    `${watch.sessionsObserved.length}/${WATCH_MIN_SESSIONS} sessions) — ` +
                    'opportunity tips active, critiques observing');
            }
            else if ((s.watch ?? null) === null) {
                out('critique mode: on (pre-existing install — watch window skipped)');
            }
            else {
                out(`critique mode: on (window closed ${fmtTime(watch.closedAt).slice(0, 10)})`);
            }
            if (watch.withheldCount > 0) {
                const recent = watch.withheld.slice(-3);
                out(`withheld critiques: ${watch.withheldCount} total; last ${recent.length}:`);
                // The store already ANSI-strips + caps withheld text; clip for a one-line peek.
                for (const w of recent)
                    out(`  ${w.lever}: "${w.tip.slice(0, 100)}"`);
            }
            return;
        }
        default: {
            // F-FEEDBACK: 👍/👎 aliases rate the LAST fired tip.
            if (GOOD_ALIASES.has(sub) || BAD_ALIASES.has(sub)) {
                const rating = GOOD_ALIASES.has(sub) ? 'good' : 'bad';
                const rated = store.rateLastTip(rating);
                if (rated === null) {
                    out('coach: no recent tip to rate (👍/👎 applies to the last 🤖 quality tip; habit 🐾 nudges use /coach dismiss)');
                    return;
                }
                // Append a labeled anchor to the offline-eval feedback corpus (a 👎 ⇒ this moment's
                // gold is SILENT, a 👍 ⇒ NUDGE) — so the owner's real ratings sharpen the eval too.
                const anchor = {
                    lever: rated.tip.lever,
                    prompt: rated.tip.prompt,
                    sessionId: rated.tip.sessionId,
                    rating,
                    goldVerdict: rating === 'good' ? 'NUDGE' : 'SILENT',
                    at: now,
                };
                try {
                    deps.recordFeedbackAnchor?.(anchor);
                }
                catch { /* corpus append never blocks the rating */ }
                const delta = store.floorDeltaForLever(rated.tip.lever);
                const effect = delta > 0 ? ` — "${rated.tip.lever}" will fire less` : delta < 0 ? ` — "${rated.tip.lever}" will fire more` : ' (more ratings needed before it adapts)';
                out(`coach: recorded ${rating === 'good' ? '👍' : '👎'} on "${rated.tip.lever}"${effect}`);
                return;
            }
            out('usage: /coach <off|on|status|build|find|dismiss|👍|👎|undo>');
            return;
        }
    }
}
/** M4: fold a skill id for find's exclusion set (mirrors merged-skill-catalog fold). */
function foldId(s) {
    return s.trim().toLowerCase();
}
/**
 * M4: lightweight SYNC best-effort installed-skills scan for `find` (directory names
 * under the canonical skill roots — no SKILL.md read, no async). Any error on any root
 * degrades to that root contributing nothing; the whole scan never throws.
 *
 * The ONE sanctioned cwd touch in this file (see the header invariant): including the
 * invoking project's ./.claude/skills keeps project-installed skills out of `find`
 * suggestions. It is read-only and best-effort — a wrong/unexpected cwd only means an
 * external duplicate might be suggested (fewer exclusions), never a wrong read or write
 * of coach state, so the useful behavior is kept instead of dropped.
 */
function defaultInstalledSkillIds(deps) {
    return () => {
        const home = deps.homeDir ?? homedir();
        const roots = [join(home, '.claude', 'skills'), join(process.cwd(), '.claude', 'skills')];
        try {
            const pluginsRoot = join(home, '.claude', 'plugins');
            for (const plugin of readdirSync(pluginsRoot, { withFileTypes: true })) {
                if (plugin.isDirectory())
                    roots.push(join(pluginsRoot, plugin.name, 'skills'));
            }
        }
        catch {
            /* no plugins root → skip */
        }
        const ids = new Set();
        for (const root of roots) {
            try {
                for (const entry of readdirSync(root, { withFileTypes: true })) {
                    if (entry.isDirectory())
                        ids.add(entry.name);
                }
            }
            catch {
                /* missing root → contributes nothing */
            }
        }
        return [...ids].sort();
    };
}
/**
 * Parse the coach arguments from `process.argv.slice(2)` into { subcommand, extra }.
 *
 * ARGUMENTS HARDENING (item 2): the command file's bang-line SINGLE-QUOTES '$ARGUMENTS'
 * so the shell (a) never runs command substitution inside it and (b) passes the whole
 * thing as ONE argv element (e.g. `['find pdf extraction']`). We ALSO still support the
 * historical multi-element form (`['find','pdf','extraction']`) — both collapse to the
 * same result: join everything with a space, split on whitespace runs, first token is the
 * subcommand and the remainder (re-joined) is the extra. '' subcommand / '' extra stay
 * falsy for every consumer. A literal single quote surviving in args is harmless data — it
 * only ever becomes part of a query string that fails to match, never shell input.
 */
export function parseCoachArgs(rest) {
    const tokens = rest.join(' ').split(/\s+/).filter((t) => t.length > 0);
    return { subcommand: tokens[0], extra: tokens.slice(1).join(' ') };
}
/** CLI entry: wires real deps, swallows everything, always exits 0. */
export function main(argv, env = process.env) {
    try {
        const baseDir = resolveBaseDir(env);
        const { subcommand, extra } = parseCoachArgs(argv.slice(2));
        runCoachCmd(subcommand, {
            store: createStore(baseDir),
            patterns: createPatternsStore(baseDir),
            env,
            now: Date.now(),
            claudeOnPath: defaultClaudeOnPath,
            out: (line) => process.stdout.write(`${line}\n`),
            recordFeedbackAnchor: (anchor) => {
                // Append one JSONL line to the local feedback corpus (never throws — best effort).
                try {
                    // 0700 dir / 0600 file: the anchor carries the owner's verbatim prompt text.
                    mkdirSync(baseDir, { recursive: true, mode: DIR_MODE });
                    appendFileSync(join(baseDir, 'feedback-anchors.jsonl'), JSON.stringify(anchor) + '\n', { encoding: 'utf8', mode: FILE_MODE });
                }
                catch {
                    /* corpus append failure must never break the rating */
                }
            },
            readFeedbackAnchorsText: () => {
                try {
                    return readFileSync(join(baseDir, 'feedback-anchors.jsonl'), 'utf8');
                }
                catch {
                    return ''; // no corpus yet → 0 active.
                }
            },
        }, 
        // M3/M4: everything after the subcommand as ONE string — `build <habit_key>` gets
        // its single key unchanged; `find <multi word query>` gets the words re-joined.
        // '' (no extra args) stays falsy for every consumer. Computed by parseCoachArgs so
        // the single-quoted-joined bang-line form and the multi-argv form both work.
        extra);
    }
    catch {
        // Never surface a stack trace to the user — the command is a no-op on error.
    }
}
// Only run when invoked directly as `node dist/coach-cmd.js` (not when imported by a test).
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('coach-cmd.js')) {
    main(process.argv);
}
