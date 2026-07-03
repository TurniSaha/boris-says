/**
 * COACH LIVENESS — deterministic "the in-terminal coach pipe is alive" signals that
 * BYPASS the LLM cascade (no Haiku/Sonnet spend, no rate-limit gate, instant).
 *
 * 1. SENTINEL (on-demand ping): an exact, recognizable phrase a dev can type to their
 *    agent at any time to force the coach to surface with a known canned reply — an
 *    inside-joke self-test. Checked FIRST in the cascade, before any token is spent, and
 *    short-circuits it (an explicit "is it alive?" check wants no coaching). It bypasses
 *    the rate-limit so it works EVERY time.
 *
 * 2. FIRST-RUN TOUR: shown EXACTLY ONCE PER INSTALL, gated by the PERSISTED `tourShown`
 *    flag in the state store (store.markTourShownIfFirst) — NOT by any in-process map.
 *    The cascade renders it as an additive prefix on the first prompt it sees post-install.
 *
 * Liveness must NOT consume the real nudge budget: it neither reads nor records any
 * outcome ledger, the per-dev cadence, or the aggregate ceiling. It is a pure text gate.
 *
 * PORT NOTE: the sentinel gate is ported from the upstream coach service. The former
 * in-memory per-session "connection ping" (first-seen Map + TTL sweep) was retired once the
 * persisted `tourShown`/`greetedSessions` store took over the greet — this module is now a
 * pure predicate + the constant strings, with no per-process state.
 */
/** The exact inside-joke self-test phrase (case-insensitive, trimmed). MUST be lowercase:
 *  isCoachSentinel compares normalize(text) (which lowercases) against this verbatim. */
export const COACH_SENTINEL_PHRASE = 'when life gives you lemons';
/** The canned reply the sentinel surfaces — the recognizable "it works" signal. */
export const COACH_SENTINEL_REPLY = "make lemonade! 🍋 Boris is wide awake and watching your back.";
/**
 * THE FIRST-RUN TOUR — shown EXACTLY ONCE PER INSTALL (persisted `tourShown` flag), the #1
 * reception moment. Four lines:
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
/** Normalize a prompt for sentinel matching: trim, collapse inner whitespace, lowercase. */
function normalize(text) {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
/** True iff the prompt IS the sentinel phrase (exact, modulo whitespace/case). */
export function isCoachSentinel(text) {
    return normalize(text) === COACH_SENTINEL_PHRASE;
}
