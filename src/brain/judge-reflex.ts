/**
 * TIER 0 REFLEX — the LOCAL, NO-MODEL gate that fires first in the cascade.
 *
 * Its job is to suppress the obvious-trivial majority BEFORE any token is spent: a
 * single-token answer to the agent's own question ("yes", "go on"), an approval, a
 * one-word continuation, a tiny "fix the typo" follow-up. The design target is ~60-70%
 * of prompts exit HERE — never reaching Haiku, never reaching Sonnet.
 *
 * It is PURE and DETERMINISTIC (no clock, no I/O): a verdict over the prompt text alone.
 * The cooldown/rate-limit half of "Tier 0" lives elsewhere (it needs a clock + per-dev
 * state); this module owns the text-shape reflex only, so it is trivially unit-testable.
 * The cascade runs this FIRST, then the cadence cooldown, then Haiku.
 *
 * IMPORTANT (the reframe): this NEVER inspects errors/blockers/AI output. It looks only
 * at the human's prompt text — the coachable unit.
 *
 * PORT NOTE: ported verbatim from the upstream coach service `pm-service/src/triggers/judge-reflex.ts`.
 * The §5.5.5 efficiency edit is applied as a TRACKED CODE edit (see the EDIT markers):
 * TRIVIAL_CHAR_LIMIT raised 24 -> 60, a tighter trivial-INTENT regex, and a risk-token
 * guard so risky/multi-clause prompts still escalate. Tier 0 stays transcript-blind/pure.
 */

/**
 * A prompt at or under this many characters is treated as a candidate trivial fix.
 * §5.5.5 EDIT: raised 24 -> 60 so short trivia ("rename this variable to userId",
 * "fix the typo in the README install command") exit at Tier 0 instead of wasting a
 * Haiku call. The trivial-INTENT regex + risk-token guard below keep this safe.
 */
const TRIVIAL_CHAR_LIMIT = 60;

/**
 * Single-token / short approvals + continuations that are answers to the agent, not
 * fresh coachable prompts. Matched after trim + lowercase, against the WHOLE prompt.
 */
const CONTINUATION_PHRASES: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'yes please',
  'yep',
  'yeah',
  'ok',
  'okay',
  'sure',
  'go',
  'go on',
  'go ahead',
  'continue',
  'proceed',
  'do it',
  'do that',
  'sounds good',
  'lgtm',
  'approve',
  'approved',
  'accept',
  'no',
  'n',
  'nope',
  'stop',
  'cancel',
  'thanks',
  'thank you',
  'next',
]);

/** The approval subset (yes/no/stop-style), reported with reason 'approval'. */
const APPROVAL_PHRASES: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'yes please',
  'yep',
  'yeah',
  'ok',
  'okay',
  'sure',
  'approve',
  'approved',
  'accept',
  'lgtm',
  'no',
  'n',
  'nope',
  'stop',
  'cancel',
]);

/**
 * Phrases that mark a trivial in-context fix — a tweak to work already on screen, not a
 * fresh prompt worth coaching. Substring-matched on a SHORT prompt only (so "fix the
 * typo in the migration that drops the users table" is NOT swallowed — it is long).
 */
const TRIVIAL_FIX_MARKERS: readonly string[] = [
  'fix the typo',
  'typo',
  'rename',
  'same for',
  'do the same',
  'now the',
  'and the',
];

/**
 * §5.5.5 EDIT: a tighter trivial-INTENT regex. Fires ONLY for a single short imperative
 * clause whose verb is obviously trivial. Combined with the single-clause + risk-token
 * guards below, this lets "rename this variable to userId" exit at Tier 0 while keeping
 * "rename the User model and migrate all 40 call sites" escalating.
 */
const TRIVIAL_INTENT_RE = /^(rename|add a comment|bump (the )?version|run (the )?(linter|formatter)|format)\b/;

/**
 * §5.5.5 EDIT: risk/scope tokens. If ANY appears, the prompt is NEVER a trivial-fix at
 * Tier 0 — it escalates to the model regardless of length (so "fix the typo in the
 * migration that drops the users table" still gets judged).
 */
const RISK_TOKENS: readonly string[] = [
  'migration',
  'migrate',
  'auth',
  'drop',
  'delete',
  'truncate',
  'schema',
  'prod',
  'production',
  'payment',
  'token',
  'password',
];

export interface ReflexVerdict {
  /** True when Tier 0 suppresses the prompt locally (no Haiku, no Sonnet). */
  readonly suppress: boolean;
  /** Why it suppressed — for logging / per-dev analysis. null when not suppressed. */
  readonly reason: 'trivial-continuation' | 'approval' | 'trivial-fix' | null;
}

const PROCEED: ReflexVerdict = { suppress: false, reason: null };

/** §5.5.5: a single short clause = no `and`/`then`/`,` and no second imperative-ish split. */
function isSingleShortClause(lower: string): boolean {
  return !/(,|\band\b|\bthen\b)/.test(lower);
}

/** §5.5.5: true when any risk/scope token is present (then NEVER a trivial-fix). */
function hasRiskToken(lower: string): boolean {
  return RISK_TOKENS.some((tok) => new RegExp(`\\b${tok}\\b`).test(lower));
}

/**
 * The Tier 0 reflex decision over one prompt's text. Returns suppress:true for the
 * obvious-fine continuation/approval/trivial-fix majority, else PROCEED (escalate to the
 * cadence cooldown + Haiku). Pure — same text always yields the same verdict.
 */
export function reflex(promptText: string): ReflexVerdict {
  const trimmed = promptText.trim();
  const lower = trimmed.toLowerCase();

  // Empty / whitespace-only never reaches here in production (the normalizer drops it),
  // but guard defensively: nothing to coach.
  if (trimmed.length === 0) return { suppress: true, reason: 'trivial-continuation' };

  // Exact approval / single-token continuation (strip a trailing punctuation char).
  const bare = lower.replace(/[.!?]+$/, '').trim();
  if (CONTINUATION_PHRASES.has(bare)) {
    const isApproval = APPROVAL_PHRASES.has(bare);
    return { suppress: true, reason: isApproval ? 'approval' : 'trivial-continuation' };
  }

  // Short trivial fixes: a tiny prompt that just tweaks recent work. §5.5.5 — gate on
  // INTENT, not raw length: swallow only when SHORT, a single short clause, NO risk
  // token present, AND it matches either a trivial-fix marker or the trivial-INTENT verb.
  if (trimmed.length <= TRIVIAL_CHAR_LIMIT && isSingleShortClause(lower) && !hasRiskToken(lower)) {
    const matchesMarker = TRIVIAL_FIX_MARKERS.some((m) => lower.includes(m));
    const matchesIntent = TRIVIAL_INTENT_RE.test(lower);
    if (matchesMarker || matchesIntent) {
      return { suppress: true, reason: 'trivial-fix' };
    }
    // A very short prompt that is not a recognized continuation is still likely a terse
    // expert follow-up; do NOT swallow it here (let Haiku/Sonnet judge with transcript).
  }

  return PROCEED;
}
