/**
 * outcome-store.ts — W2-OUTCOME (Phase 1): the crash-safe GLOBAL handoff file that carries a
 * just-ended session's Outcome line to the NEXT session's first prompt.
 *
 * Design (docs/DESIGN-outcome-scoring.md §4):
 *  - Surface a GLOBAL `last-outcome.json` (NOT keyed by the ended session id — the next
 *    session has a different id, so a per-ended-id surface would never be read). The COMPUTE
 *    CACHE is keyed by the ended session id for IDEMPOTENCY (a compact-then-exit double-fire
 *    must not double-write a different value).
 *  - Atomic write (writeJsonAtomic = temp-sibling + rename) bounds a hard exit mid-write
 *    (worst case: no line shown). Reads never throw (readJson contract).
 *  - CONSUME-ONCE: once surfaced, mark consumed so it shows exactly once, not every prompt.
 */
import { join } from 'node:path';
import { writeJsonAtomic, readJson } from '../state/store.js';
function outcomePath(baseDir) {
    return join(baseDir, 'last-outcome.json');
}
/**
 * Write the latest outcome line for the next session to pick up. IDEMPOTENT on the ended
 * session id: if a record for the SAME endedSessionId already exists, do nothing (a
 * compact-then-exit re-fire must not clobber the first write or reset `consumed`). Never throws.
 */
export function writeLastOutcome(baseDir, record) {
    try {
        const existing = readJson(outcomePath(baseDir), null);
        if (existing !== null && existing.endedSessionId === record.endedSessionId)
            return; // idempotent.
        writeJsonAtomic(outcomePath(baseDir), record);
    }
    catch {
        // Best effort — a failed handoff just means no line shown next session.
    }
}
/**
 * Read the pending (unconsumed) outcome line for THIS session to surface, or null. Does NOT
 * mutate — call markOutcomeConsumed after surfacing.
 *  - `currentSessionId` guards against a session surfacing its OWN just-written record.
 *  - `currentProjectKey` guards the CROSS-PROJECT leak: the recap is only shown when the
 *    record's projectKey matches this session's project. An unscoped record (no/'' key) or a
 *    mismatch → null (never surfaced). Pass '' to intentionally show nothing.
 * Never throws.
 */
export function readPendingOutcome(baseDir, currentSessionId, currentProjectKey) {
    const rec = readJson(outcomePath(baseDir), null);
    if (rec === null)
        return null;
    if (rec.consumed)
        return null;
    if (typeof rec.line !== 'string' || rec.line.length === 0)
        return null;
    if (rec.endedSessionId === currentSessionId)
        return null; // never show a session its own record.
    // Cross-project guard: only surface a recap that belongs to THIS project. An unscoped
    // record (missing/'' projectKey) never matches → never leaks into another project.
    const recKey = typeof rec.projectKey === 'string' ? rec.projectKey : '';
    if (recKey === '' || recKey !== currentProjectKey)
        return null;
    return rec;
}
/** Mark the current record consumed (so it surfaces exactly once). Never throws. */
export function markOutcomeConsumed(baseDir) {
    try {
        const rec = readJson(outcomePath(baseDir), null);
        if (rec === null || rec.consumed)
            return;
        writeJsonAtomic(outcomePath(baseDir), { ...rec, consumed: true });
    }
    catch {
        // best effort.
    }
}
