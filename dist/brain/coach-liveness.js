/**
 * COACH LIVENESS — deterministic "the in-terminal coach pipe is alive" signals that
 * BYPASS the LLM cascade (no Haiku/Sonnet spend, no rate-limit gate, instant).
 *
 * Both signals ride the SAME display path as a real nudge (the on-disk mailbox), so the
 * message lands in-terminal as a `🐾 PM: …` on the dev's next prompt. They are checked
 * FIRST in the cascade, before any token is spent — so they are free and never starved
 * by a cooldown.
 *
 * 1. SENTINEL (on-demand ping): an exact, recognizable phrase a dev can type to their
 *    agent at any time to force the coach to surface with a known canned reply — an
 *    inside-joke self-test. Bypasses the rate-limit so it works EVERY time.
 *
 * 2. FIRST-PROMPT LIVENESS PING: the FIRST prompt the coach sees for a given session
 *    gets a one-time "coach connected" confirmation, so every fresh Claude session
 *    proves the pipe is alive on turn 1, then the coach goes quiet and only the real
 *    cascade surfaces thereafter. Per-session, in-memory, swept so it never grows
 *    unbounded.
 *
 * Liveness must NOT consume the real nudge budget: it neither reads nor records any
 * outcome ledger, the per-dev cadence, or the aggregate ceiling. It is purely a
 * display-pipe heartbeat.
 *
 * PORT NOTE: ported verbatim from the upstream coach service (pm-service coach-liveness).
 * RE-KEY (spec §15c, decision #6): the source keyed the first-seen ping on
 * `roomId + sessionId`; locally `roomId` is dropped (single user) so the de-dup key is
 * `sessionId` alone — the signature is `check(sessionId, text)`.
 */
/** The exact inside-joke self-test phrase (case-insensitive, trimmed). MUST be lowercase:
 *  isCoachSentinel compares normalize(text) (which lowercases) against this verbatim. */
export const COACH_SENTINEL_PHRASE = 'when life gives you lemons';
/** The canned reply the sentinel surfaces — the recognizable "it works" signal. */
export const COACH_SENTINEL_REPLY = "make lemonade! 🍋 Boris is wide awake and watching your back.";
/**
 * The one-time first-prompt connection confirmation — the warm welcome.
 * RETAINED for other uses (per-session greet state), but NO LONGER surfaced every session:
 * item 3 killed the every-session ping. The once-per-INSTALL first-run TOUR below is what a
 * new user sees; after that the coach is silent unless it has something to say.
 */
export const COACH_CONNECTED_PING = "Boris Cherny is now watching over your shoulder. I nudge you toward the best result from " +
    "Claude in the fewest turns — the right plan, skill, or habit — and stay quiet when you're " +
    "already nailing it. Type \"" +
    COACH_SENTINEL_PHRASE +
    "\" to check I'm alive.";
/**
 * THE FIRST-RUN TOUR — shown EXACTLY ONCE PER INSTALL (persisted `tourShown` flag), the #1
 * reception moment. Four lines (item 3):
 *   1. Boris intro + what it does in real time,
 *   2. watch-first: it observes silently for ~3 sessions / 30 prompts before it critiques,
 *      and /coach status shows what it withheld,
 *   3. try /coach find <task> to pull the right skill on demand,
 *   4. /coach off anytime + the lemons liveness self-test.
 * Kept as one \n-joined string so the banner's wrapBody renders it as the tour body.
 */
export const COACH_FIRST_RUN_TOUR = [
    "I watch how you drive Claude Code in real time and only speak when it matters — the " +
        "right plan, skill, or habit, exactly when you need it.",
    "Watch-first: I observe silently for your first ~3 sessions / 30 prompts before I critique " +
        "— run /coach status to see what I withheld while I learned your style.",
    "Need a tool now? Try /coach find <task> (e.g. /coach find pdf extraction) to pull the right " +
        "skill on demand — offline, nothing installed for you.",
    "/coach off turns me off anytime. Type \"" +
        COACH_SENTINEL_PHRASE +
        "\" to check I'm alive.",
].join('\n');
/** Drop first-seen markers older than this so an abandoned session never leaks. */
const SEEN_TTL_MS = 6 * 60 * 60_000; // 6 hours
/** Hard backstop on distinct session keys. */
const MAX_KEYS = 2000;
/** Normalize a prompt for sentinel matching: trim, collapse inner whitespace, lowercase. */
function normalize(text) {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
/** True iff the prompt IS the sentinel phrase (exact, modulo whitespace/case). */
export function isCoachSentinel(text) {
    return normalize(text) === COACH_SENTINEL_PHRASE;
}
/**
 * Construct the liveness checker. One per process so its first-seen Map is isolated. The
 * injected clock keeps the TTL sweep deterministic.
 */
export function createCoachLiveness(opts = {}) {
    const now = opts.now ?? (() => Date.now());
    const firstSeenAt = new Map();
    const sweep = (t) => {
        for (const [key, seenAt] of firstSeenAt) {
            if (t - seenAt >= SEEN_TTL_MS)
                firstSeenAt.delete(key);
        }
        while (firstSeenAt.size > MAX_KEYS) {
            const oldest = firstSeenAt.keys().next().value;
            if (oldest === undefined)
                break;
            firstSeenAt.delete(oldest);
        }
    };
    const check = (sessionId, text) => {
        const t = now();
        sweep(t);
        const key = sessionId;
        const firstThisSession = !firstSeenAt.has(key);
        if (firstThisSession)
            firstSeenAt.set(key, t);
        // Sentinel takes precedence and fires EVERY time (the on-demand self-test); it
        // SHORT-CIRCUITS the cascade (the caller returns after delivering it).
        if (isCoachSentinel(text))
            return { sentinel: COACH_SENTINEL_REPLY, ping: null };
        // Otherwise a one-time connection ping on the first prompt — ADDITIVE (the caller
        // delivers it AND still runs the cascade, so turn-1 coaching is not suppressed).
        if (firstThisSession)
            return { sentinel: null, ping: COACH_CONNECTED_PING };
        return { sentinel: null, ping: null };
    };
    return { check };
}
