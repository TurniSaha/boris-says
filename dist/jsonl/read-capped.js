/**
 * src/jsonl/read-capped.ts — a byte-size-capped whole-file reader for the judge.
 *
 * The detached judge reads transcript / corpus `.jsonl` files whole via readFileSync
 * before splitting into lines. The per-line/per-prompt caps only apply AFTER the whole
 * file is in memory, so a pathologically huge `.jsonl` (a multi-GB transcript) could
 * balloon the background judge's memory. This helper stat()s first and SKIPS any file
 * larger than the cap, so an outlier file degrades to "no context from that file"
 * instead of an OOM. Never throws — a missing/unstattable file returns null.
 *
 * This runs only in the detached, unref'd judge process — never on the UserPromptSubmit
 * hot path — so a skipped file only means slightly less mining context for one turn.
 */
import { readFileSync, statSync } from 'node:fs';
/**
 * Max bytes we will read from a single session/corpus `.jsonl`. A real transcript is
 * kilobytes-to-low-megabytes; 32 MiB is far above any legitimate session yet bounds the
 * worst case. Chosen well above SESSION_PROMPT_CAP × realistic-prompt-size.
 */
export const MAX_JSONL_BYTES = 32 * 1024 * 1024;
/**
 * Read `path` as utf8, but only if it is at most `maxBytes`. Returns null on a missing,
 * unstattable, unreadable, or oversized file. Never throws.
 */
export function readFileCapped(path, maxBytes = MAX_JSONL_BYTES) {
    let size;
    try {
        size = statSync(path).size;
    }
    catch {
        return null; // missing / unstattable
    }
    if (size > maxBytes)
        return null; // oversized → skip rather than balloon memory
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null; // unreadable (permission / vanished between stat and read)
    }
}
