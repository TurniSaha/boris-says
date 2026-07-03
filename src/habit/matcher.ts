/**
 * src/habit/matcher.ts — deterministic trigger-matched delivery for the habit
 * coach (SPEC §7.4, §5.5.6c).
 *
 * On every typed prompt, for each `open` pattern, test whether the in-hand prompt
 * matches one of the pattern's `match_phrases`. The CORE matcher is pure and
 * deterministic (NO LLM): it mirrors the §7.4 / coach-liveness normalization
 * (trim + whitespace-collapse + lowercase) and fires ONLY when the normalized
 * prompt EITHER
 *   (i)  exactly equals one normalized match_phrase, OR
 *   (ii) contains ALL of a phrase's anchor tokens as WHOLE WORDS (word-boundary),
 *        and only for phrases of >= 4 tokens (short phrases require exact equality).
 * Rule (ii) deliberately uses whole-word containment, NOT raw substring, to avoid
 * false hits (the §7.4 pin: a coincidental substring must NOT fire).
 *
 * §5.5.6c adds an OPTIONAL, clearly-separate async `fuzzyFallback` that does ONE
 * cheap Haiku yes/no call ONLY when the deterministic matcher returns null AND a
 * cheap pre-filter says the prompt looks handoff / end-of-session-ish. It is
 * opt-in and never part of the deterministic core.
 *
 * `composeHabitTip` renders the cited nudge (no button — advice text, §7.4/§7.5).
 */
import type { LlmBackend } from '../llm/backend.js';
import type { Pattern } from './patterns-store.js';

/** Phrases shorter than this (in tokens) require EXACT equality (rule ii guard). */
export const MIN_ANCHOR_TOKENS = 4;

/**
 * Normalize text for matching: trim, collapse inner whitespace, lowercase.
 * MIRRORS `coach-liveness.ts` normalize() exactly (SPEC §7.4).
 */
export function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Whole-word tokens of a normalized string (the anchor-token signature unit). */
export function anchorTokens(text: string): string[] {
  const norm = normalize(text);
  if (norm.length === 0) return [];
  // Whole-word tokens: split on any run of non-word chars (mirrors the
  // word-boundary discipline of rule (ii)).
  return norm.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** True iff `prompt` contains every token of `phrase` as a WHOLE WORD (not substring). */
function containsAllWholeWords(promptTokens: ReadonlySet<string>, phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0) return false;
  for (const tok of phraseTokens) {
    if (!promptTokens.has(tok)) return false;
  }
  return true;
}

/**
 * Does the normalized `prompt` match this single `phrase` per §7.4?
 *  (i) exact equality, OR
 *  (ii) whole-word containment of ALL phrase tokens, ONLY for phrases >= 4 tokens.
 */
function phraseMatches(normPrompt: string, promptTokens: ReadonlySet<string>, phrase: string): boolean {
  const normPhrase = normalize(phrase);
  if (normPhrase.length === 0) return false;
  // (i) exact equality fires regardless of length.
  if (normPrompt === normPhrase) return true;
  // (ii) whole-word containment — only for phrases of >= MIN_ANCHOR_TOKENS tokens.
  const phraseTokens = anchorTokens(phrase);
  if (phraseTokens.length < MIN_ANCHOR_TOKENS) return false;
  return containsAllWholeWords(promptTokens, phraseTokens);
}

/**
 * The DETERMINISTIC core matcher (no LLM): return the first `open` pattern whose
 * `match_phrases` the prompt matches per §7.4, else null. Only `open` patterns are
 * eligible (surfaced/dismissed never re-fire).
 */
export function matchHabit(prompt: string, openPatterns: readonly Pattern[]): Pattern | null {
  const normPrompt = normalize(prompt);
  if (normPrompt.length === 0) return null;
  const promptTokens = new Set(anchorTokens(prompt));
  for (const pattern of openPatterns) {
    if (pattern.status !== 'open') continue;
    for (const phrase of pattern.match_phrases) {
      if (phraseMatches(normPrompt, promptTokens, phrase)) return pattern;
    }
  }
  return null;
}

/**
 * Cheap pre-filter for the OPTIONAL fuzzy fallback: does the prompt LOOK like an
 * end-of-session / handoff ask? Lexical-only, no LLM. Keeps the Haiku call rare
 * (gated again by the 24h habit cooldown upstream).
 */
const HANDOFF_HINTS: readonly string[] = [
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
export function looksHandoffish(prompt: string): boolean {
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
export async function fuzzyFallback(
  prompt: string,
  openPatterns: readonly Pattern[],
  backend: LlmBackend,
): Promise<Pattern | null> {
  // Behind the lexical match: if the deterministic core already matched, do nothing.
  if (matchHabit(prompt, openPatterns) !== null) return null;
  if (!backend.configured) return null;
  if (!looksHandoffish(prompt)) return null;

  const open = openPatterns.filter((p) => p.status === 'open');
  for (const pattern of open) {
    const answer = await backend.complete({
      model: 'haiku',
      maxTokens: 4,
      system:
        'You decide if a developer prompt expresses a specific recurring intent. ' +
        'Answer with ONLY the single word "yes" or "no". No punctuation, no explanation.',
      user:
        `Does this prompt express the intent "${pattern.habit}"?\n\n` +
        `Prompt: ${prompt}\n\nAnswer yes or no.`,
    });
    if (answer !== null && /^\s*yes\b/i.test(answer)) return pattern;
  }
  return null;
}

/** Human label for a draft kind in the habit tip (M3). */
const DRAFT_KIND_LABEL: Record<string, string> = {
  skill: 'skill',
  claude_md_rule: 'CLAUDE.md rule',
  hook: 'hook',
};

/**
 * Compose the cited habit nudge BODY (SPEC §7.4/§7.5 guardrail #2 — name WHEN, with a
 * concrete fix). No button (advice text). The `🐾 habit:` marker tags it as a habit nudge;
 * the caller wraps this body in the shared `formatCoachBanner` so Boris speaks with ONE
 * voice everywhere (the old bare `🐾 PM:` prefix — a pre-rename pm-service leftover — is gone).
 * M3: when the pattern carries a draft, append the `/coach build` affordance —
 * same intent-gated fire, same cooldown; a draft-less tip stays byte-identical.
 */
export function composeHabitTip(pattern: Pattern, occurrenceCount: number): string {
  const sessions = occurrenceCount === 1 ? 'session' : 'sessions';
  const base = `🐾 habit: you've ${pattern.habit} in your last ${occurrenceCount} ${sessions} — ${pattern.fix}.`;
  if (!pattern.draft) return base;
  const label = DRAFT_KIND_LABEL[pattern.draft.kind] ?? pattern.draft.kind;
  return `${base} — a draft ${label} is ready: run /coach build to write it for review (or /coach dismiss to reject)`;
}
