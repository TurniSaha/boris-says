/**
 * src/habit/miner-parse.ts — the PURE defensive parser for the miner's LLM output
 * (SPEC §7.2: "Defensive parse — mirror parseJudgeVerdict").
 *
 * The miner is instructed to emit ONLY a JSON array; we tolerate stray prose by
 * extracting the first [...] block. A malformed response yields [] (fail-closed: a
 * parse failure must never produce a pattern). Each element is validated field by
 * field; a structurally-invalid element is dropped (not fatal to the others). The
 * structural quality drops (< 3 distinct sessions / empty fix / empty why_inefficient
 * — §5.5.6a) live in the miner, NOT here — this layer only shapes raw JSON into the
 * typed `MinedPattern`.
 */

export interface MinedOccurrence {
  readonly sessionId: string;
  readonly ts: number;
  readonly evidence: string;
}

export interface MinedPattern {
  readonly habit_key: string;
  readonly match_phrases: string[];
  readonly anchorSignature?: string[];
  readonly habit: string;
  readonly fix: string;
  readonly why_inefficient: string;
  readonly occurrences: MinedOccurrence[];
  readonly confidence: number;
}

/** Extract the first [...] block from `text` and JSON.parse it; null on failure. */
function extractArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Coerce a value to a trimmed string, or '' when absent/non-string. */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce a value to a finite number, or 0. */
function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse + validate one occurrence; null if it lacks a usable sessionId/evidence. */
function parseOccurrence(v: unknown): MinedOccurrence | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const sessionId = asString(o.sessionId);
  const evidence = asString(o.evidence);
  if (sessionId.length === 0 || evidence.length === 0) return null;
  return { sessionId, ts: asNumber(o.ts), evidence };
}

/** Parse + shape one pattern element; null when it has no usable habit_key. */
function parsePattern(v: unknown): MinedPattern | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;

  const habit_key = asString(o.habit_key).trim();
  if (habit_key.length === 0) return null;

  const match_phrases = Array.isArray(o.match_phrases)
    ? o.match_phrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];

  const anchorSignature = Array.isArray(o.anchorSignature)
    ? o.anchorSignature.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : undefined;

  const occurrences = Array.isArray(o.occurrences)
    ? o.occurrences.map(parseOccurrence).filter((x): x is MinedOccurrence => x !== null)
    : [];

  return {
    habit_key,
    match_phrases,
    ...(anchorSignature ? { anchorSignature } : {}),
    habit: asString(o.habit).trim(),
    fix: asString(o.fix).trim(),
    why_inefficient: asString(o.why_inefficient).trim(),
    occurrences,
    confidence: asNumber(o.confidence),
  };
}

/**
 * Parse the miner's response into a list of `MinedPattern`. Malformed / non-array /
 * empty -> []. Individual malformed elements are dropped.
 */
export function parseMinerPatterns(text: string): MinedPattern[] {
  const arr = extractArray(text);
  if (!Array.isArray(arr)) return [];
  return arr.map(parsePattern).filter((p): p is MinedPattern => p !== null);
}
