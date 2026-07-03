/**
 * src/session-outcome.ts -> dist/session-outcome.js — the SessionEnd entry (W2-OUTCOME Phase 1).
 *
 * Fires ONCE when a session terminates (exit / clear / compact). It re-reads the just-ended
 * session's `.jsonl`, computes HONEST per-signal Outcome facts (tests / commit / change-size),
 * renders ONE factual line, and writes a crash-safe GLOBAL `last-outcome.json` for the NEXT
 * session's first prompt to surface. It CANNOT block and CANNOT reliably show interactive
 * output (SessionEnd semantics) — so it only persists; the surfacing happens on next start.
 *
 * Hard rules (mirrors the hook): NEVER throws, ALWAYS exits 0, no fake numbers — an empty
 * report writes NOTHING (no "0 tests passed" default). The reader/extractors are permissive +
 * pure; the strict typed-prompt gate is untouched.
 */
import { resolveBaseDir, projectKeyForCwd } from './config.js';
import { readFileCapped } from './jsonl/read-capped.js';
import { scanToolEvents } from './jsonl/outcome-reader.js';
import { buildOutcomeReport, renderOutcomeLine } from './brain/outcome-signals.js';
import { writeLastOutcome, patchLastOutcomeSummary } from './brain/outcome-store.js';
import { createLlmBackend } from './llm/backend.js';
import { generateSessionSummary } from './brain/session-summary.js';
/** Parse + validate the SessionEnd stdin, or null. */
function parseStdin(stdin) {
    let raw;
    try {
        raw = JSON.parse(stdin);
    }
    catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null)
        return null;
    const transcriptPath = typeof raw.transcript_path === 'string' ? raw.transcript_path : '';
    if (transcriptPath.length === 0)
        return null; // nothing to read → nothing to compute.
    return {
        sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
        transcriptPath,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '', // for the project-scoping key (cross-project leak fix).
    };
}
/**
 * Default transcript reader — byte-capped (readFileCapped) like every other transcript /
 * corpus read, so a pathologically huge session `.jsonl` is skipped rather than read whole
 * in the foreground SessionEnd hook (after the facts are already durable). Never throws (→ '' on any error or oversized file).
 */
function defaultReadTranscript(path) {
    return readFileCapped(path) ?? '';
}
/**
 * Run the SessionEnd body. NEVER throws / rejects. Writes the global outcome file when there
 * is at least one measured signal; otherwise writes nothing (no fabricated line).
 *
 * FACTS-FIRST ordering (user-safety): the deterministic facts are written IMMEDIATELY, before any
 * LLM work — so a slow or hung summary call can never delay or lose the facts. TIER 3: when a
 * backend is injected, ONE bounded, fail-silent `claude -p` call then distills "what was this
 * session about" and PATCHES it onto the already-written record. When no backend is injected (tests
 * / no auth) no `await` runs at all, so an unawaited caller still observes the facts synchronously.
 * Any summary failure / timeout / empty / oversized → no summary field, facts stand (graceful degrade).
 */
export async function runSessionOutcome(deps) {
    try {
        const parsed = parseStdin(deps.stdin);
        if (parsed === null)
            return;
        const read = deps.readTranscript ?? defaultReadTranscript;
        const jsonl = read(parsed.transcriptPath);
        if (jsonl.length === 0)
            return;
        const report = buildOutcomeReport(scanToolEvents(jsonl));
        const line = renderOutcomeLine(report);
        if (line.length === 0)
            return; // nothing measured → write nothing (honesty rule).
        const baseDir = resolveBaseDir(deps.env);
        const now = deps.now ?? Date.now;
        const projectKey = projectKeyForCwd(parsed.cwd);
        // FACTS FIRST (no LLM, instant): write the deterministic recap NOW so a slow/hung summary
        // call can never delay or lose the facts. SessionEnd's user-visible contract is honored
        // even if the summary below times out or the hook is killed.
        writeLastOutcome(baseDir, {
            line,
            endedSessionId: parsed.sessionId,
            projectKey, // scope the recap to this project (cross-project leak fix).
            consumed: false,
            at: now(),
        });
        // TIER 3 (best-effort, bounded, fail-silent): distill the "what it was about" summary and
        // PATCH it onto the just-written record. This is the ONLY slow step; it runs AFTER the facts
        // are durable, so the worst case is "facts without a summary line", never lost facts. When no
        // backend is injected (tests / no auth) this is skipped entirely and the write above stands.
        if (deps.backend !== undefined) {
            const summary = await generateSessionSummary(deps.backend, jsonl, deps.summaryTimeoutMs);
            if (summary !== undefined && summary.length > 0) {
                patchLastOutcomeSummary(baseDir, parsed.sessionId, projectKey, summary);
            }
        }
    }
    catch {
        // SessionEnd must never throw — a failure just means no line next session.
    }
}
/** Read all of stdin as a string. Never rejects. */
function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', () => resolve(''));
    });
}
/** The real entry: read stdin, compute, always exit 0. */
async function main() {
    let stdin = '';
    try {
        stdin = await readStdin();
    }
    catch {
        stdin = '';
    }
    // Build the SAME backend selector the judge uses (CLI default) so the summary call is a real
    // `claude -p` in production; it is bounded + fail-silent inside generateSessionSummary.
    const backend = createLlmBackend(process.env);
    await runSessionOutcome({ stdin, env: process.env, backend });
    process.exit(0);
}
// Only run as a script when executed directly (importing for tests is side-effect-free).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    void main();
}
