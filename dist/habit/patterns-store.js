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
const STATUS_RANK = {
    open: 0,
    surfaced: 1,
    dismissed: 2,
};
/**
 * Merge an incoming pattern into the existing one for the same key, applying
 * the §7.6 invariants. `existing` may be undefined (brand-new key → starts open).
 */
function mergeOne(existing, incoming) {
    if (!existing) {
        return { ...incoming };
    }
    // Status can only move FORWARD (open → surfaced → dismissed); never backward.
    const status = STATUS_RANK[incoming.status] > STATUS_RANK[existing.status]
        ? incoming.status
        : existing.status;
    const merged = {
        ...incoming,
        status,
        // Preserve timeline fields from the existing record.
        createdAt: existing.createdAt,
        surfacedAt: existing.surfacedAt ?? incoming.surfacedAt,
    };
    // M3: the FIRST draft wins — a re-mine without (or with a different) draft
    // must never clobber the stored one (D4).
    const draft = existing.draft ?? incoming.draft;
    if (draft)
        merged.draft = draft;
    else
        delete merged.draft; // keep legacy rows key-identical (no `draft: undefined`).
    return merged;
}
export function createPatternsStore(baseDir = DEFAULT_BASE_DIR) {
    const path = join(baseDir, 'patterns.json');
    function readPatterns() {
        return readJson(path, []);
    }
    function upsertPatterns(newOnes) {
        // Re-read immediately before writing so a concurrent dismiss/miner write is honored.
        const current = readPatterns();
        const byKey = new Map();
        for (const p of current)
            byKey.set(p.habit_key, p);
        for (const incoming of newOnes) {
            byKey.set(incoming.habit_key, mergeOne(byKey.get(incoming.habit_key), incoming));
        }
        writeJsonAtomic(path, [...byKey.values()]);
    }
    function transition(habitKey, mutate) {
        const current = readPatterns();
        let touched = false;
        const next = current.map((p) => {
            if (p.habit_key !== habitKey)
                return p;
            touched = true;
            return mutate(p);
        });
        if (touched)
            writeJsonAtomic(path, next);
    }
    function markSurfaced(habitKey, now = Date.now()) {
        transition(habitKey, (p) => 
        // Never regress a dismissed entry back to surfaced.
        p.status === 'dismissed' ? p : { ...p, status: 'surfaced', surfacedAt: now });
    }
    function markDismissed(habitKey) {
        transition(habitKey, (p) => ({ ...p, status: 'dismissed' }));
    }
    return { readPatterns, upsertPatterns, markSurfaced, markDismissed };
}
