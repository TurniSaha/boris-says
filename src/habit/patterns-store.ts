/**
 * patterns.json store — discovered cross-session habits (SPEC §7.3, §7.6).
 *
 * The detached judge (miner upsert + matcher surfacing) and a separate
 * `/coach dismiss` node invocation BOTH write this file. Naive
 * read-modify-write loses dismissals, so every mutation is a
 * read-merge-write under temp-rename with one invariant:
 *
 *   - a `dismissed` entry NEVER re-opens
 *   - a `surfaced` status NEVER regresses to `open`
 *   - `createdAt` / `surfacedAt` are preserved on existing keys
 *   - merge tiebreaker: `dismissed` always wins
 */
import { join } from 'node:path';
import { writeJsonAtomic, readJson, DEFAULT_BASE_DIR } from '../state/store.js';

export type PatternStatus = 'open' | 'surfaced' | 'dismissed';

/**
 * M3: a drafted primitive generated from a mined repetition (SPEC GOAL M3). The
 * draft lives INSIDE the pattern row (atomic, merge-safe; `/coach dismiss`
 * orphans nothing) and is only ever WRITTEN to disk by `/coach build` — as a
 * review file that Claude Code cannot load (never auto-activates).
 */
export interface PatternDraft {
  kind: 'skill' | 'claude_md_rule' | 'hook';
  /** Slug-sanitized artifact name ([a-z0-9-] only — the parser enforces it). */
  name: string;
  /** The full file body (SKILL.md / CLAUDE.md section / hook script). */
  content: string;
  createdAt: number;
}

export interface Occurrence {
  sessionId: string;
  ts: number;
  evidence: string;
}

export interface Pattern {
  habit_key: string;
  trigger: string;
  match_phrases: string[];
  /**
   * Normalized anchor-token signature of `match_phrases` (SPEC §5.5.6b / §7.3) —
   * persisted so the miner's dismissal-similarity Jaccard gate is a cheap compare.
   * Optional for forward-compat with older rows that predate the gate.
   */
  anchorSignature?: string[];
  habit: string;
  fix: string;
  why_inefficient: string;
  occurrences: Occurrence[];
  occurrenceCount: number;
  confidence: number;
  status: PatternStatus;
  createdAt: number;
  surfacedAt: number | null;
  /** M3: the drafted primitive for this repetition, if one was generated. */
  draft?: PatternDraft;
}

export interface PatternsStore {
  readPatterns(): Pattern[];
  upsertPatterns(newOnes: Pattern[]): void;
  markSurfaced(habitKey: string, now?: number): void;
  markDismissed(habitKey: string): void;
}

const STATUS_RANK: Record<PatternStatus, number> = {
  open: 0,
  surfaced: 1,
  dismissed: 2,
};

/**
 * Merge an incoming pattern into the existing one for the same key, applying
 * the §7.6 invariants. `existing` may be undefined (brand-new key → starts open).
 */
function mergeOne(existing: Pattern | undefined, incoming: Pattern): Pattern {
  if (!existing) {
    return { ...incoming };
  }
  // Status can only move FORWARD (open → surfaced → dismissed); never backward.
  const status =
    STATUS_RANK[incoming.status] > STATUS_RANK[existing.status]
      ? incoming.status
      : existing.status;
  const merged: Pattern = {
    ...incoming,
    status,
    // Preserve timeline fields from the existing record.
    createdAt: existing.createdAt,
    surfacedAt: existing.surfacedAt ?? incoming.surfacedAt,
  };
  // M3: the FIRST draft wins — a re-mine without (or with a different) draft
  // must never clobber the stored one (D4).
  const draft = existing.draft ?? incoming.draft;
  if (draft) merged.draft = draft;
  else delete merged.draft; // keep legacy rows key-identical (no `draft: undefined`).
  return merged;
}

export function createPatternsStore(
  baseDir: string = DEFAULT_BASE_DIR
): PatternsStore {
  const path = join(baseDir, 'patterns.json');

  function readPatterns(): Pattern[] {
    return readJson<Pattern[]>(path, []);
  }

  function upsertPatterns(newOnes: Pattern[]): void {
    // Re-read immediately before writing so a concurrent dismiss/miner write is honored.
    const current = readPatterns();
    const byKey = new Map<string, Pattern>();
    for (const p of current) byKey.set(p.habit_key, p);
    for (const incoming of newOnes) {
      byKey.set(incoming.habit_key, mergeOne(byKey.get(incoming.habit_key), incoming));
    }
    writeJsonAtomic(path, [...byKey.values()]);
  }

  function transition(habitKey: string, mutate: (p: Pattern) => Pattern): void {
    const current = readPatterns();
    let touched = false;
    const next = current.map((p) => {
      if (p.habit_key !== habitKey) return p;
      touched = true;
      return mutate(p);
    });
    if (touched) writeJsonAtomic(path, next);
  }

  function markSurfaced(habitKey: string, now: number = Date.now()): void {
    transition(habitKey, (p) =>
      // Never regress a dismissed entry back to surfaced.
      p.status === 'dismissed' ? p : { ...p, status: 'surfaced', surfacedAt: now }
    );
  }

  function markDismissed(habitKey: string): void {
    transition(habitKey, (p) => ({ ...p, status: 'dismissed' }));
  }

  return { readPatterns, upsertPatterns, markSurfaced, markDismissed };
}
