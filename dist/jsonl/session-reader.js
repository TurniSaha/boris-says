/**
 * src/jsonl/session-reader.ts — one session's typed prompts (SPEC §7.1).
 *
 * Given a single `.jsonl` session file path, return that session's typed prompts.
 * The file is read line by line and each line is run through the three-tier gate
 * (`parseTypedPromptLine`). An unparseable or half-written final line is skipped
 * gracefully — the reader NEVER throws (a missing file yields []).
 *
 * THE §5 / decision-#5 RULE (load-bearing):
 *   The just-typed (current) prompt comes from the hook STDIN payload (`prompt`),
 *   NOT from this file. `UserPromptSubmit` fires before Claude Code has necessarily
 *   flushed the current prompt to the `.jsonl` (and for the first prompt of a fresh
 *   session the file may not exist yet). This reader therefore supplies ONLY the
 *   PRIOR transcript context — never the current turn. Callers pass the verbatim
 *   current prompt separately and must NOT re-derive it from this file.
 *
 * ORDER: this reader returns typed prompts OLDEST-first, in file order as they
 * appear (SPEC §7.1 allows returning oldest-first directly instead of newest-first-
 * then-reverse; we pin oldest-first). `recentTranscriptWindow` slices the tail.
 */
import { readFileSync } from 'node:fs';
import { parseTypedPromptLine } from './line-parser.js';
/**
 * SPEC §7.1 step 4 — carry `DEPTH_LIMITS.session` (prompts: 20) so we never collect
 * an unbounded number of typed prompts from one giant session file. We keep the
 * most-recent N typed prompts (the window of interest is always the tail).
 */
export const SESSION_PROMPT_CAP = 20;
/** The judge's transcript context window (SPEC §7.1 step 3: MAX_TRANSCRIPT = 8). */
export const MAX_TRANSCRIPT = 8;
/**
 * Read one session `.jsonl` and return its typed-prompt events, OLDEST-first in
 * file order. Bounded to the most-recent SESSION_PROMPT_CAP events. Never throws;
 * a missing/unreadable file returns []. The final line is allowed to be a
 * half-written partial — it is skipped, not fatal.
 */
export function readSessionTypedPrompts(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        return [];
    }
    if (raw.length === 0)
        return [];
    const events = [];
    for (const line of raw.split('\n')) {
        if (line.length === 0)
            continue;
        const event = parseTypedPromptLine(line);
        if (event !== null)
            events.push(event);
    }
    // Bound to the most-recent SESSION_PROMPT_CAP, preserving oldest-first order.
    if (events.length > SESSION_PROMPT_CAP) {
        return events.slice(events.length - SESSION_PROMPT_CAP);
    }
    return events;
}
/**
 * The judge's prior-transcript context (SPEC §7.1 step 3): the last `max` PRIOR
 * typed-prompt TEXTS, OLDEST-first. The current turn's verbatim prompt comes from
 * stdin (decision #5) and is NOT in this file's tail in a reliable way, so this
 * window is purely PRIOR context.
 *
 * An empty/absent session file yields an empty window — the first prompt of a
 * fresh session still judges fine off the stdin prompt alone.
 */
export function recentTranscriptWindow(path, max = MAX_TRANSCRIPT) {
    const all = readSessionTypedPrompts(path);
    const tail = max >= all.length ? all : all.slice(all.length - max);
    return tail.map((e) => e.text);
}
