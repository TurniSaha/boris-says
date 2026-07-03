/**
 * src/jsonl/line-parser.ts — the PURE single-line JSONL parser.
 *
 * PORT of the upstream coach service `terminal-parsers/claude-line-parser.ts` (the THREE-tier
 * typed gate, lines 38 / 47 / 51), re-shaped for this plugin's needs: instead of
 * mapping to NormalizedTerminalEvents, it returns a typed-prompt event or null.
 *
 * The ONLY reliable discriminator for a genuine human-typed prompt is the
 * three-tier gate, IN THIS ORDER (SPEC §1):
 *   TIER 1 — top-level `o.type === 'user'`            (claude-line-parser.ts:38)
 *   TIER 2 — top-level `o.promptSource === 'typed'`   (claude-line-parser.ts:47, STRICT equality)
 *   TIER 3 — nested `o.message.role === 'user'`       (claude-line-parser.ts:51)
 *
 * STRICT equality on tier 2 already rejects `system`, `queued`, AND `sdk` — do
 * NOT "fix" it to anything looser. A line is a typed prompt ONLY when all three
 * tiers hold.
 *
 * Defensive: malformed JSON, a non-object line, or any missing field returns
 * null. This function NEVER throws.
 */
/**
 * Parse ONE JSONL line into a typed-prompt event, or null when the line is not a
 * genuine human-typed prompt (or is malformed). Never throws.
 */
export function parseTypedPromptLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object')
        return null;
    const o = parsed;
    // TIER 1 — top-level type dispatch.
    if (o.type !== 'user')
        return null;
    // TIER 2 — top-level promptSource gate (STRICT equality).
    if (o.promptSource !== 'typed')
        return null;
    // TIER 3 — nested role guard.
    const message = o.message;
    if (message === null || typeof message !== 'object')
        return null;
    const m = message;
    if (m.role !== 'user')
        return null;
    const text = extractUserText(m.content);
    if (text.length === 0)
        return null;
    const event = { text };
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : undefined;
    const ts = parseTs(o.timestamp);
    return {
        ...event,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(ts !== undefined ? { ts } : {}),
    };
}
/**
 * content may be a string OR an array of blocks; for an array, join only the
 * text blocks (this naturally takes the first text block first). Anything else
 * yields an empty string. (Ported from claude-line-parser.ts:59-70.)
 */
function extractUserText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block !== null && typeof block === 'object') {
            const b = block;
            if (b.type === 'text' && typeof b.text === 'string')
                parts.push(b.text);
        }
    }
    return parts.join('\n');
}
/**
 * Does this prompt carry an ATTACHED image/screenshot? Claude Code injects an `[Image #N]`
 * marker into the typed text when the dev pastes/drags an image (and the message content also
 * carries a `type:'image'` block). The coach is text-only — it can't SEE the image — but it
 * MUST know one is attached, so the judge treats the artifact as PRESENT (don't fire
 * "paste-the-artifact" when a screenshot is right there) instead of guessing it's missing.
 * PURE; matches the `[Image #N]` / `[Image]` marker case-insensitively.
 */
export function promptHasAttachedImage(prompt) {
    if (typeof prompt !== 'string' || prompt.length === 0)
        return false;
    return /\[image(?:\s*#\d+)?\]/i.test(prompt);
}
/** Parse a timestamp field (ISO string or epoch number) to epoch ms, else undefined. */
function parseTs(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string') {
        const ms = Date.parse(raw);
        if (!Number.isNaN(ms))
            return ms;
    }
    return undefined;
}
