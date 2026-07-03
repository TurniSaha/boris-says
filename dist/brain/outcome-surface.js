import { stateShowsEngagement } from '../state/watch.js';
import { readPendingOutcome, markOutcomeConsumed } from './outcome-store.js';
import { formatCoachBanner } from './mailbox-format.js';
import { emitTip } from '../hook-output.js';
/**
 * Surface the "Last time here:" recap (facts + optional TIER 3 summary) as ONE banner.
 * Returns TRUE iff a recap banner was actually emitted this call — the caller (the UPS hook)
 * uses that to decide whether to ALSO emit the bare TIER 1 liveness banner: a recap banner
 * already carries the Boris title, so liveness must be emitted ONLY when no recap surfaced
 * (guarantees exactly one Boris title per first prompt on a project-return).
 */
export function surfaceOutcomeRecap(store, baseDir, sessionId, projectKey, out) {
    try {
        if (!sessionId)
            return false; // no id → never surface (avoid a blank-key loop).
        // FIX 1 — THE TOUR WINS A NEW USER'S FIRST MESSAGE. The first-run tour is decided in a
        // DIFFERENT process (the detached judge, via store.markTourShownIfFirst) and prepended
        // by the cascade. On a genuinely fresh, un-toured install the tour WILL show this turn,
        // so the recap must defer to the NEXT project-return rather than beat the intro to the
        // user's first-ever impression. This is a PURE READ (no mutation, does not consume the
        // recap gate below): if the install has never been toured AND shows no engagement, skip
        // the recap this turn — its record stays pending + unconsumed for the next return. An
        // ENGAGED install (owner's shape) never sees the tour, so its recap is UNCHANGED.
        const s = store.getState();
        if (s.tourShown !== true && !stateShowsEngagement(s))
            return false;
        // FIRST-ATTEMPT gate — consumed unconditionally so the recap can only ever show on
        // this session's first surfacing opportunity (its first prompt; the same-turn Stop
        // hook of that prompt arrives second and is already gated out).
        if (!store.markOutcomeRecapShownIfFirst(sessionId))
            return false;
        if (projectKey === '')
            return false; // unknown project → never surface (fail-safe).
        const pending = readPendingOutcome(baseDir, sessionId, projectKey);
        if (pending === null)
            return false;
        // TIER 3: append the "what it was about" summary as an extra body line UNDER the facts
        // (one shared Boris title). formatCoachBanner splits on '\n' + soft-wraps, so a ≤2-line
        // summary renders as extra rows. Degrades cleanly: no summary → identical to before.
        const facts = typeof pending.line === 'string' ? pending.line.trim() : '';
        const summary = typeof pending.summary === 'string' ? pending.summary.trim() : '';
        // Empty-body guard: a recap with NO measured facts AND no summary must render NOTHING —
        // an empty yellow banner body is worse than no banner (owner-reported). The record still
        // counts as consumed so it can't retry into the same blank box next turn.
        const body = [facts, summary].filter((s) => s.length > 0).join('\n');
        if (body.length === 0) {
            markOutcomeConsumed(baseDir);
            return false; // no content → let the bare TIER-1 liveness banner own the slot instead.
        }
        emitTip(formatCoachBanner(body), out ?? process.stdout);
        markOutcomeConsumed(baseDir);
        return true;
    }
    catch {
        // additive surface — any failure is a silent no-op.
        return false;
    }
}
