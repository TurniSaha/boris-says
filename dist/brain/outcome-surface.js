import { readPendingOutcome, markOutcomeConsumed } from './outcome-store.js';
import { formatCoachBanner } from './mailbox-format.js';
import { emitTip } from '../hook-output.js';
export function surfaceOutcomeRecap(store, baseDir, sessionId, projectKey, out) {
    try {
        if (!sessionId)
            return; // no id → never surface (avoid a blank-key loop).
        // FIRST-ATTEMPT gate — consumed unconditionally so the recap can only ever show on
        // this session's first surfacing opportunity (its first prompt; the same-turn Stop
        // hook of that prompt arrives second and is already gated out).
        if (!store.markOutcomeRecapShownIfFirst(sessionId))
            return;
        if (projectKey === '')
            return; // unknown project → never surface (fail-safe).
        const pending = readPendingOutcome(baseDir, sessionId, projectKey);
        if (pending === null)
            return;
        emitTip(formatCoachBanner(pending.line), out ?? process.stdout);
        markOutcomeConsumed(baseDir);
    }
    catch {
        // additive surface — any failure is a silent no-op.
    }
}
