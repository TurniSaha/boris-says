/**
 * outcome-store.ts — W2-OUTCOME (Phase 1): the crash-safe GLOBAL handoff file that carries a
 * just-ended session's Outcome line to the NEXT session's first prompt.
 *
 * Design (the outcome-scoring handoff; SPEC §5.2):
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

/** The on-disk handoff record. */
export interface OutcomeFile {
  /** The rendered factual line ('' is never written — caller skips an empty report). */
  readonly line: string;
  /** The ended session id this was computed from (idempotency key). */
  readonly endedSessionId: string;
  /**
   * The PROJECT KEY (from the ended session's cwd) this recap belongs to. The recap is only
   * surfaced when it matches the CURRENT session's project — fixes the cross-project leak
   * (a session ending in project A must not pop its recap into project B). Optional for
   * back-compat: an old record with no projectKey is treated as '' (unscoped → never shown).
   */
  readonly projectKey?: string;
  /**
   * TIER 3: a ≤2-line plain-English recap of WHAT the ended session was about, generated
   * by one bounded `claude -p` call at SessionEnd (grounded only in the transcript). Rendered
   * as an extra banner line UNDER the facts on project-return. Optional + back-compat: a legacy
   * record (or a trivial/failed generation) simply has no summary, and only the facts surface.
   * Never a coach judgment or a score — it is a recap of the DEV's own work.
   */
  readonly summary?: string;
  /** Whether it has already been surfaced to the dev (consume-once). */
  readonly consumed: boolean;
  /** When it was computed (ms). */
  readonly at: number;
}

function outcomePath(baseDir: string): string {
  return join(baseDir, 'last-outcome.json');
}

/**
 * Write the latest outcome line for the next session to pick up. IDEMPOTENT on the ended
 * session id: if a record for the SAME endedSessionId already exists, do nothing (a
 * compact-then-exit re-fire must not clobber the first write or reset `consumed`). Never throws.
 */
export function writeLastOutcome(baseDir: string, record: OutcomeFile): void {
  try {
    const existing = readJson<OutcomeFile | null>(outcomePath(baseDir), null);
    if (existing !== null && existing.endedSessionId === record.endedSessionId) return; // idempotent.
    writeJsonAtomic(outcomePath(baseDir), record);
  } catch {
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
export function readPendingOutcome(
  baseDir: string,
  currentSessionId: string,
  currentProjectKey: string,
): OutcomeFile | null {
  const rec = readJson<OutcomeFile | null>(outcomePath(baseDir), null);
  if (rec === null) return null;
  if (rec.consumed) return null;
  if (typeof rec.line !== 'string' || rec.line.length === 0) return null;
  if (rec.endedSessionId === currentSessionId) return null; // never show a session its own record.
  // Cross-project guard: only surface a recap that belongs to THIS project. An unscoped
  // record (missing/'' projectKey) never matches → never leaks into another project.
  const recKey = typeof rec.projectKey === 'string' ? rec.projectKey : '';
  if (recKey === '' || recKey !== currentProjectKey) return null;
  return rec;
}

/**
 * Patch the "what it was about" summary onto the just-written record (TIER 3). The facts are
 * written first + instantly by writeLastOutcome; this best-effort add-on runs after the slow
 * summary call. No-op unless the on-disk record is still the SAME session + project + unconsumed
 * (so a race with the next session, or an already-shown recap, never gets a stale summary). Never throws.
 */
export function patchLastOutcomeSummary(
  baseDir: string,
  endedSessionId: string,
  projectKey: string,
  summary: string,
): void {
  try {
    const rec = readJson<OutcomeFile | null>(outcomePath(baseDir), null);
    if (rec === null || rec.consumed) return;
    if (rec.endedSessionId !== endedSessionId || rec.projectKey !== projectKey) return;
    writeJsonAtomic(outcomePath(baseDir), { ...rec, summary });
  } catch {
    // best effort — the facts already landed; a missing summary just drops the 3rd line.
  }
}

/** Mark the current record consumed (so it surfaces exactly once). Never throws. */
export function markOutcomeConsumed(baseDir: string): void {
  try {
    const rec = readJson<OutcomeFile | null>(outcomePath(baseDir), null);
    if (rec === null || rec.consumed) return;
    writeJsonAtomic(outcomePath(baseDir), { ...rec, consumed: true });
  } catch {
    // best effort.
  }
}
