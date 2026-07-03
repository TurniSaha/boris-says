// ── Tunables ─────────────────────────────────────────────────────────────────
/** Distinct sessions that must be observed before critique coaching can enable. */
export const WATCH_MIN_SESSIONS = 3;
/** Typed prompts that must be observed before critique coaching can enable. */
export const WATCH_MIN_PROMPTS = 30;
/** Cap on the observed-sessions list (only 3 are needed; small headroom). */
export const WATCH_SESSIONS_CAP = 10;
/** The withheld log keeps "the last few" — this many entries. */
export const WITHHELD_LOG_CAP = 10;
/** Per-field slice (tip, prompt) so state.json stays bounded. */
export const WITHHELD_TEXT_CAP = 300;
/**
 * The DAY-ONE lever class: tool-existence suggestions, not prompt-quality critique.
 * Everything NOT in this set — including unknown/future lever ids — is critique
 * (fail-closed: precision over recall; a new lever observes first).
 */
export const OPPORTUNITY_LEVERS = new Set(['skill_fit', 'primitive_fit']);
/** True iff the lever is critique-class (observe-only during the window). */
export function isCritiqueLever(lever) {
    return !OPPORTUNITY_LEVERS.has(lever);
}
// ── Constructors ─────────────────────────────────────────────────────────────
/** A fresh install's open window: nothing observed yet. */
export function freshWatch() {
    return {
        sessionsObserved: [],
        promptsObserved: 0,
        closedAt: null,
        announced: false,
        withheldCount: 0,
        withheld: [],
    };
}
/**
 * The MIGRATION target for an engaged legacy install: closed AND announced, so critique
 * behavior is byte-identical to today and the owner never sees the announce.
 */
export function preClosedWatch(now) {
    return { ...freshWatch(), closedAt: now, announced: true };
}
// ── Migration ────────────────────────────────────────────────────────────────
/**
 * Does this state already show engagement with the coach? Any prior rating, surfaced
 * tip, cooldown stamp, or greeted session means the install predates the watch window —
 * it must NOT retro-apply. Every read is ??-guarded (legacy partial states).
 */
export function stateShowsEngagement(state) {
    return (Object.keys(state.feedbackByLever ?? {}).length > 0 ||
        (state.lastTip ?? null) !== null ||
        (state.lastRating ?? null) !== null ||
        (state.lastQualityTipAt ?? null) !== null ||
        (state.greetedSessions ?? []).length > 0 ||
        Object.keys(state.lastQualityTipBySession ?? {}).length > 0 ||
        Object.keys(state.leversUsedBySession ?? {}).length > 0);
}
/**
 * Resolve the effective watch state: an explicit persisted watch ALWAYS wins (later
 * engagement must not retro-close a materialized open window); a null watch resolves
 * lazily from the engagement markers. PURE — safe for /coach status (no mutation).
 */
export function resolveWatch(state, now) {
    return state.watch ?? (stateShowsEngagement(state) ? preClosedWatch(now) : freshWatch());
}
// ── Transitions ──────────────────────────────────────────────────────────────
/** Is the window closed? (The announce is a separate, later step.) */
export function windowClosed(watch) {
    return watch.closedAt !== null;
}
/**
 * Count one observation (a typed prompt in `sessionId`). Closes the window on the
 * observation that satisfies BOTH thresholds; a closed window is FROZEN (returned as-is).
 */
export function recordObservation(watch, sessionId, now) {
    if (watch.closedAt !== null)
        return watch; // frozen.
    const sessionsObserved = sessionId.length > 0 && !watch.sessionsObserved.includes(sessionId)
        ? [...watch.sessionsObserved, sessionId].slice(-WATCH_SESSIONS_CAP)
        : watch.sessionsObserved;
    const promptsObserved = watch.promptsObserved + 1;
    const closes = sessionsObserved.length >= WATCH_MIN_SESSIONS && promptsObserved >= WATCH_MIN_PROMPTS;
    return {
        ...watch,
        sessionsObserved,
        promptsObserved,
        closedAt: closes ? now : null,
    };
}
/**
 * Append one withheld critique: count+1 (monotonic), keep the newest WITHHELD_LOG_CAP.
 * Text fields are ANSI-stripped + whitespace-collapsed (the tip arrives as a rendered
 * banner — the /coach status peek must be readable) and sliced to WITHHELD_TEXT_CAP.
 */
export function appendWithheld(watch, entry) {
    const clean = {
        lever: entry.lever,
        tip: normalizeWithheldText(entry.tip),
        prompt: normalizeWithheldText(entry.prompt),
        at: entry.at,
    };
    return {
        ...watch,
        withheldCount: watch.withheldCount + 1,
        withheld: [...watch.withheld, clean].slice(-WITHHELD_LOG_CAP),
    };
}
/** The one-time enable announce (rides the existing tip channel, lever-less). */
export function announceMessage(promptsObserved) {
    return (`I've been watching how you work — ${promptsObserved} observations so far. ` +
        'Critique coaching is now on; /coach off anytime.');
}
/** Strip ANSI SGR escapes, collapse whitespace, and slice to the per-field cap. */
function normalizeWithheldText(text) {
    return text
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .join(' ')
        .slice(0, WITHHELD_TEXT_CAP);
}
