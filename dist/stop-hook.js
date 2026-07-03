/**
 * src/stop-hook.ts -> dist/stop-hook.js — the `Stop` entry (M2 same-turn coaching,
 * PLAN §B Step 5).
 *
 * WHY: the per-prompt judge runs DETACHED off UserPromptSubmit and finishes after the
 * hook returns, so its tip used to surface one turn late ("advice about prompt N appears
 * attached to prompt N+1"). `Stop` fires when Claude finishes responding for the turn —
 * the judge's latency is hidden BEHIND the turn — so draining the mailbox here surfaces
 * the tip WITH the turn it judged. The firing DECISION is unchanged (precision over
 * recall; the cooldown is armed at judge-write time) — only the SURFACE moved.
 *
 * Behavior:
 *   TOP GUARDS: PROMPT_COACH_JUDGING → exit (recursion guard); unparseable stdin /
 *   missing session_id → exit; kill switch (state.enabled=false) → exit.
 *   (0) Outcome recap via the SHARED gated helper (same-project + first-attempt +
 *       consume-once — identical gates to the UPS surface).
 *   (1) FAST-EXIT GUARD: no per-session turn marker (`beginTurn` never ran) → the coach
 *       never spawned a judge this session (tool-only / aborted / ignored turn) → exit
 *       immediately, never poll.
 *   (2) POLL [A2]: up to STOP_DRAIN_POLL_MS in STOP_DRAIN_INTERVAL_MS ticks:
 *         - claimMailbox (atomic rename = consume-once, shared with UPS) → tip? emit it
 *           same-turn. A tip whose turnId ≠ the current turn (a PRIOR turn's tip this
 *           drain happened to catch) is emitted WITH the `about your prompt: "…"` label.
 *         - else judge-done marker set for THIS turn (judge chose silence) → exit — a
 *           well-formed turn costs near-zero stall.
 *         - else cap reached → silent exit (crashed/slow judge; the labeled UPS backstop
 *           delivers next turn).
 *
 * Hard rules (mirrors hook.ts): NEVER throws, ALWAYS exits 0, any failure = silent
 * no-op. Heavy bits (stdin, store, clock, sleep, stdout) are injected seams.
 */
import { fileURLToPath } from 'node:url';
import { createStore } from './state/store.js';
import { resolveBaseDir, isEnabled, projectKeyForCwd, STOP_DRAIN_POLL_MS, STOP_DRAIN_INTERVAL_MS, } from './config.js';
import { emitTip } from './hook-output.js';
import { withPromptAttribution } from './brain/mailbox-format.js';
import { surfaceOutcomeRecap } from './brain/outcome-surface.js';
/**
 * Run the Stop-hook body. NEVER throws/rejects — the whole body is wrapped; the caller
 * maps the return to `process.exit(0)` unconditionally.
 */
export async function runStopHook(deps) {
    try {
        // TOP GUARD: recursion guard — the inner `claude -p` the judge spawns runs with this
        // set; its own Stop hooks must do nothing.
        if (deps.env.PROMPT_COACH_JUDGING)
            return;
        const payload = parseStdin(deps.stdin);
        if (payload === null)
            return;
        const baseDir = resolveBaseDir(deps.env);
        const store = deps.store ?? createStore(baseDir);
        // Kill switch.
        if (!isEnabled(store))
            return;
        const out = deps.out ?? process.stdout;
        // (0) Outcome recap — the SHARED gated surface (same gates as UPS; on a normal turn
        // the UPS of this session's first prompt already consumed the first-attempt flag, so
        // this is a no-op backstop, not a second surface).
        surfaceOutcomeRecap(store, baseDir, payload.sessionId, projectKeyForCwd(payload.cwd), out);
        // (1) FAST-EXIT GUARD: no judge was ever spawned for this session's current turn →
        // nothing can arrive; do not stall the turn end.
        const turnId = store.currentTurn(payload.sessionId);
        if (turnId === null)
            return;
        // (2) POLL to the cap [A2].
        const now = deps.now ?? Date.now;
        const sleep = deps.sleep ?? defaultSleep;
        const deadline = now() + STOP_DRAIN_POLL_MS;
        for (;;) {
            const tips = store.claimMailbox(payload.sessionId);
            if (tips.length > 0) {
                emitClaimed(tips[0], turnId, out);
                return;
            }
            // Judge finished and chose SILENCE (the majority case) → exit, near-zero stall.
            if (store.wasTurnJudged(payload.sessionId, turnId))
                return;
            if (now() >= deadline)
                return; // cap: judge slow/crashed → labeled backstop next turn.
            await sleep(STOP_DRAIN_INTERVAL_MS);
        }
    }
    catch {
        // Hard rule: the hook never throws — any error is a silent no-op.
    }
}
/** Parse + validate the Stop stdin, or null. session_id is required; the rest tolerated. */
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
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
    if (sessionId.length === 0)
        return null;
    return { sessionId, cwd: typeof raw.cwd === 'string' ? raw.cwd : '' };
}
/**
 * Emit one claimed tip. SAME-turn tips render bare; a tip judged on a PRIOR turn (turnId
 * mismatch) gets the `about your prompt: "…"` attribution label so it is never confusing.
 * A tip with no prompt (bare ping/sentinel) is never labeled — nothing to attribute.
 */
function emitClaimed(tip, currentTurnId, out) {
    const isLate = typeof tip.turnId === 'string' && tip.turnId.length > 0 && tip.turnId !== currentTurnId;
    const message = isLate && typeof tip.prompt === 'string' && tip.prompt.length > 0
        ? withPromptAttribution(tip.message, tip.prompt)
        : tip.message;
    emitTip(message, out);
}
/** The real tick sleeper. */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Read all of stdin (the Stop JSON) as a string. Never rejects. */
function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', () => resolve(''));
    });
}
/** The real entry: read stdin, run the hook, always exit 0. */
async function main() {
    let stdin = '';
    try {
        stdin = await readStdin();
    }
    catch {
        stdin = '';
    }
    await runStopHook({ stdin, env: process.env });
    process.exit(0);
}
// Only run as a script when executed directly (importing for tests is side-effect-free).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    void main();
}
