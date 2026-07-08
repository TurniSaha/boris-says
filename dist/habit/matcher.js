/** Phrases shorter than this (in tokens) require EXACT equality (rule ii guard). */
export const MIN_ANCHOR_TOKENS = 4;
/**
 * Normalize text for matching: trim, collapse inner whitespace, lowercase.
 * MIRRORS `coach-liveness.ts` normalize() exactly (SPEC §7.4).
 */
export function normalize(text) {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
/** Whole-word tokens of a normalized string (the anchor-token signature unit). */
export function anchorTokens(text) {
    const norm = normalize(text);
    if (norm.length === 0)
        return [];
    // Whole-word tokens: split on any run of non-word chars (mirrors the
    // word-boundary discipline of rule (ii)).
    return norm.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}
/** True iff `prompt` contains every token of `phrase` as a WHOLE WORD (not substring). */
function containsAllWholeWords(promptTokens, phraseTokens) {
    if (phraseTokens.length === 0)
        return false;
    for (const tok of phraseTokens) {
        if (!promptTokens.has(tok))
            return false;
    }
    return true;
}
/**
 * Does the normalized `prompt` match this single `phrase` per §7.4?
 *  (i) exact equality, OR
 *  (ii) whole-word containment of ALL phrase tokens, ONLY for phrases >= 4 tokens.
 */
function phraseMatches(normPrompt, promptTokens, phrase) {
    const normPhrase = normalize(phrase);
    if (normPhrase.length === 0)
        return false;
    // (i) exact equality fires regardless of length.
    if (normPrompt === normPhrase)
        return true;
    // (ii) whole-word containment — only for phrases of >= MIN_ANCHOR_TOKENS tokens.
    const phraseTokens = anchorTokens(phrase);
    if (phraseTokens.length < MIN_ANCHOR_TOKENS)
        return false;
    return containsAllWholeWords(promptTokens, phraseTokens);
}
/**
 * The DETERMINISTIC core matcher (no LLM): return the first `open` pattern whose
 * `match_phrases` the prompt matches per §7.4, else null. Only `open` patterns are
 * eligible (surfaced/dismissed never re-fire).
 */
export function matchHabit(prompt, openPatterns) {
    const normPrompt = normalize(prompt);
    if (normPrompt.length === 0)
        return null;
    const promptTokens = new Set(anchorTokens(prompt));
    for (const pattern of openPatterns) {
        if (pattern.status !== 'open')
            continue;
        for (const phrase of pattern.match_phrases) {
            if (phraseMatches(normPrompt, promptTokens, phrase))
                return pattern;
        }
    }
    return null;
}
/**
 * Cheap pre-filter for the OPTIONAL fuzzy fallback: does the prompt LOOK like an
 * end-of-session / handoff ask? Lexical-only, no LLM. Keeps the Haiku call rare
 * (gated again by the 24h habit cooldown upstream).
 */
const HANDOFF_HINTS = [
    'next session',
    'next time',
    'handoff',
    'hand off',
    'hand-off',
    'wrap up',
    'wrap-up',
    'end of session',
    'pick up',
    'where we left off',
    'context for',
    'summarize what',
    'summary of what',
    'continue tomorrow',
    'resume',
];
/** True iff the prompt looks handoff/end-of-session-ish (cheap lexical pre-filter). */
export function looksHandoffish(prompt) {
    const norm = normalize(prompt);
    return HANDOFF_HINTS.some((h) => norm.includes(h));
}
/**
 * OPTIONAL async fuzzy fallback (SPEC §5.5.6c) — clearly SEPARATE from the
 * deterministic core. Runs at most ONE cheap Haiku yes/no call, and ONLY when:
 *   - the lexical `matchHabit` returns null, AND
 *   - the cheap `looksHandoffish` pre-filter says the prompt is handoff-ish, AND
 *   - the backend is configured.
 * Returns the matched pattern (the first open pattern the model affirms) or null.
 * Never throws (the backend never throws; a non-"yes" answer is null).
 */
export async function fuzzyFallback(prompt, openPatterns, backend) {
    // Behind the lexical match: if the deterministic core already matched, do nothing.
    if (matchHabit(prompt, openPatterns) !== null)
        return null;
    if (!backend.configured)
        return null;
    if (!looksHandoffish(prompt))
        return null;
    const open = openPatterns.filter((p) => p.status === 'open');
    for (const pattern of open) {
        const answer = await backend.complete({
            model: 'haiku',
            maxTokens: 4,
            system: 'You decide if a developer prompt expresses a specific recurring intent. ' +
                'Answer with ONLY the single word "yes" or "no". No punctuation, no explanation.',
            user: `Does this prompt express the intent "${pattern.habit}"?\n\n` +
                `Prompt: ${prompt}\n\nAnswer yes or no.`,
        });
        if (answer !== null && /^\s*yes\b/i.test(answer))
            return pattern;
    }
    return null;
}
/** Human label for a draft kind in the habit tip (M3). */
const DRAFT_KIND_LABEL = {
    skill: 'skill',
    claude_md_rule: 'CLAUDE.md rule',
    hook: 'hook',
};
/**
 * Sentence-lead words that make a habit a full clause (NOT a `you've ___` completion).
 * A habit starting with one of these ("Across multiple sessions the developer…") would
 * render the ungrammatical "you've Across…"; detect it and use a neutral lead instead.
 */
const SENTENCE_LEAD_WORDS = [
    'the', 'across', 'every', 'when', 'this', 'these', 'there', 'they',
    'you', 'your', 'developer', 'user', 'it', 'a', 'an', 'in', 'on',
    'during', 'whenever', 'each', 'because', 'while', 'after', 'before',
];
/**
 * Does `habit` cleanly complete the frame "you've <habit>"? A cheap deterministic
 * heuristic (NO LLM, no truncation): it reads as a participle/verb phrase (e.g.
 * "asked for a next-session prompt") rather than a full sentence. TRUE only when it
 *   - starts LOWERCASE (a mid-clause continuation, not a capitalized sentence lead), AND
 *   - its first word is NOT a sentence-lead word (The/Across/Every/When/This/…), AND
 *   - it does NOT name the actor ("the developer" / "the user") — a sentence tell.
 * Ambiguous shapes fall back to the neutral lead — never produce "you've <Sentence>".
 */
export function completesYouve(habit) {
    const trimmed = habit.trim();
    if (trimmed.length === 0)
        return false;
    const first = trimmed[0];
    // Must start lowercase (a participle/verb phrase, not a capitalized sentence lead).
    if (first !== first.toLowerCase() || first === first.toUpperCase())
        return false;
    const firstWord = trimmed.split(/[^a-z0-9]+/i)[0]?.toLowerCase() ?? '';
    if (SENTENCE_LEAD_WORDS.includes(firstWord))
        return false;
    const lower = trimmed.toLowerCase();
    if (lower.includes('the developer') || lower.includes('the user'))
        return false;
    return true;
}
/**
 * Join the habit-relative fix onto the tip with a single terminal period — WITHOUT
 * producing a double-period when the fix already ends in terminal punctuation. The fix
 * text is preserved verbatim; only a redundant trailing "." is elided (owner bug B: the
 * screenshot's "proactive observable.." was this template "." on an already-period fix).
 */
function withTerminalPeriod(fix) {
    const trimmed = fix.trimEnd();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
/**
 * Compose the cited habit nudge BODY (SPEC §7.4/§7.5 guardrail #2 — name WHEN, with a
 * concrete fix). No button (advice text). The `🐾 habit:` marker tags it as a habit nudge;
 * the caller wraps this body in the shared `formatCoachBanner` so Boris speaks with ONE
 * voice everywhere (the old bare `🐾 PM:` prefix — a pre-rename pm-service leftover — is gone).
 *
 * GRAMMAR-ROBUST (owner fix A): the habit text is NEVER dropped or truncated. A well-shaped
 * participle habit keeps today's byte-identical "you've <habit> in your last N … — <fix>."
 * lead; a full-SENTENCE habit ("Across multiple sessions the developer…") uses a NEUTRAL
 * lead that reads correctly ("noticed a recurring pattern across your last N … — <habit>
 * Fix: <fix>"), preserving the habit + fix verbatim — only the connective framing changes.
 *
 * M3: when the pattern carries a draft, append the `/coach build` affordance —
 * same intent-gated fire, same cooldown; a draft-less well-shaped tip stays byte-identical.
 */
export function composeHabitTip(pattern, occurrenceCount) {
    const sessions = occurrenceCount === 1 ? 'session' : 'sessions';
    const window = `your last ${occurrenceCount} ${sessions}`;
    const fix = withTerminalPeriod(pattern.fix);
    const base = completesYouve(pattern.habit)
        ? `🐾 habit: you've ${pattern.habit} in ${window} — ${fix}`
        : `🐾 habit: noticed a recurring pattern across ${window} — ${pattern.habit} Fix: ${fix}`;
    if (!pattern.draft)
        return base;
    const label = DRAFT_KIND_LABEL[pattern.draft.kind] ?? pattern.draft.kind;
    return `${base} — a draft ${label} is ready: run /coach build to write it for review (or /coach dismiss to reject)`;
}
