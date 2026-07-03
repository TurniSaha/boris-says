/** Hard cap on the stored summary (design: ≤2 short lines / ≤200 chars). */
export const SUMMARY_MAX_CHARS = 200;
/** Default timeout for the summary call (ms) — bounds SessionEnd against a hung `claude -p`. */
// The SessionEnd hook has a ~10s wall. The FACTS are written before this call, so a timeout
// only drops the bonus summary line — never the facts. Kept well under the wall (6s) so the
// process (which force-exits after the await) always returns comfortably in time.
export const SUMMARY_TIMEOUT_MS = 6000;
/** Cap the transcript slice handed to the model (the backend also byte-caps upstream). */
const TRANSCRIPT_SLICE_CHARS = 24000;
/** Token budget: a plain ≤200-char / ≤2-line distillation needs little headroom. */
const SUMMARY_MAX_TOKENS = 120;
const SYSTEM_PROMPT = [
    'You summarize what a developer worked on in a single coding session, from its raw transcript.',
    'Write at most 2 short lines (<=200 characters total), plain English, no markdown, no bullet points.',
    "Describe the developer's ACTUAL work grounded ONLY in the transcript — what they built, changed,",
    'or investigated, and any loose end left open. No embellishment, no praise, no score, no advice.',
    'If the session is trivial, empty, or its purpose is unclear, reply with an empty string.',
].join(' ');
/**
 * Clamp a raw model reply to the stored contract: trim, keep at most the first 2 non-empty
 * lines, enforce <=200 chars. Returns undefined when nothing usable remains (trivial session,
 * a refusal, or an over-long unclampable single token). PURE.
 */
export function clampSummary(raw) {
    if (raw === null)
        return undefined;
    const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 2);
    const joined = lines.join(' ').trim();
    if (joined.length === 0)
        return undefined;
    if (joined.length > SUMMARY_MAX_CHARS)
        return undefined; // over budget → drop (don't hard-cut mid-word).
    return joined;
}
/**
 * Generate the session summary, or `undefined` on any failure. Bounded by `timeoutMs`
 * (default SUMMARY_TIMEOUT_MS) via a race so a never-resolving backend still returns. Never
 * throws: a rejected/throwing backend resolves to undefined.
 */
export async function generateSessionSummary(backend, transcript, timeoutMs = SUMMARY_TIMEOUT_MS) {
    try {
        if (!backend.configured)
            return undefined;
        const user = transcript.length > TRANSCRIPT_SLICE_CHARS ? transcript.slice(-TRANSCRIPT_SLICE_CHARS) : transcript;
        const call = backend.complete({
            system: SYSTEM_PROMPT,
            user,
            maxTokens: SUMMARY_MAX_TOKENS,
            model: 'haiku', // cheapest; adequate for a plain 2-line distillation.
        });
        const timeout = new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
            // Unref so the timer alone never keeps the SessionEnd process alive.
            if (typeof t.unref === 'function')
                t.unref();
        });
        const raw = await Promise.race([call, timeout]);
        return clampSummary(raw);
    }
    catch {
        return undefined; // never throw — degrade to facts-only.
    }
}
