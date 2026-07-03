/**
 * src/brain/outcome-surface.ts — M2: the ONE shared, gated "Last session" recap surface
 * (PLAN §B Step 7). Called by BOTH the UserPromptSubmit hook and the Stop hook so the two
 * surfaces can never disagree on the gates:
 *
 *  - STRICT FIRST-ATTEMPT gate: the FIRST surface attempt of a session consumes the
 *    per-session `outcomeRecapShownSessions` flag (a flag SEPARATE from the welcome
 *    ping's `greetedSessions` — neither consumes the other's). Consuming on the first
 *    ATTEMPT (not the first pending HIT) is what makes the gate genuinely
 *    first-prompt-only: a record that lands mid-session can never pop mid-session — it
 *    waits for the NEXT session's first prompt.
 *  - SAME PROJECT only: the record's projectKey (from the ended session's cwd) must match
 *    the current session's; '' (unknown project) never matches (fail-safe).
 *  - CONSUME-ONCE: the record's own `consumed` flag flips after the single surface.
 *
 * Never throws — any failure is a silent no-op (hook hard rule).
 */
import type { Store } from '../state/store.js';
import { readPendingOutcome, markOutcomeConsumed } from './outcome-store.js';
import { formatCoachBanner } from './mailbox-format.js';
import { emitTip } from '../hook-output.js';

export function surfaceOutcomeRecap(
  store: Store,
  baseDir: string,
  sessionId: string,
  projectKey: string,
  out: NodeJS.WriteStream | undefined,
): void {
  try {
    if (!sessionId) return; // no id → never surface (avoid a blank-key loop).
    // FIRST-ATTEMPT gate — consumed unconditionally so the recap can only ever show on
    // this session's first surfacing opportunity (its first prompt; the same-turn Stop
    // hook of that prompt arrives second and is already gated out).
    if (!store.markOutcomeRecapShownIfFirst(sessionId)) return;
    if (projectKey === '') return; // unknown project → never surface (fail-safe).
    const pending = readPendingOutcome(baseDir, sessionId, projectKey);
    if (pending === null) return;
    emitTip(formatCoachBanner(pending.line), out ?? process.stdout);
    markOutcomeConsumed(baseDir);
  } catch {
    // additive surface — any failure is a silent no-op.
  }
}
