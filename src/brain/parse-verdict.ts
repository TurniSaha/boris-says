/**
 * src/brain/parse-verdict.ts — the PURE defensive parsers for the two LLM responses.
 *
 * PORT (verbatim logic) of `parseProspectorScore` + `parseJudgeVerdict` from the upstream coach service
 * `pm-service/src/triggers/judge-dispatch.ts` (+ the `JudgeVerdict` interface). These are
 * pure functions consumed by the later judge-cascade module; they are extracted here so
 * the cascade can import them and so they are testable now.
 *
 * Defensive contract (preserved byte-for-byte in semantics):
 *  - parseProspectorScore: find the first number; non-numeric -> fail-OPEN (score 1).
 *  - parseJudgeVerdict: find the first {...} block; malformed -> fail-CLOSED (null).
 */
import type { PromptPhase } from './prompt-coach-skill.js';

export interface JudgeVerdict {
  readonly phase: PromptPhase;
  readonly dimension_scores: Record<string, number>;
  readonly missing_piece: string | null;
  readonly risk_level: 'low' | 'medium' | 'high';
  readonly skill_fit: { candidate_skill: string | null; confidence: number };
  /**
   * Capability-awareness: the ONE Claude capability (from the AVAILABLE-CAPABILITIES
   * list rendered into the judge input) that would materially help this exact gap, or
   * null. Parsed defensively, identically to skill_fit. SKILL WINS over capability when
   * both fit (skills are executable/higher-value).
   */
  readonly capability_fit: { candidate_capability: string | null; confidence: number };
  readonly interrupt: boolean;
  readonly confidence: number;
  readonly primary_lever: string;
  readonly nudge: string | null;
}

/**
 * Parse the Haiku prospector's coarse score. Non-numeric -> 1 (fail-OPEN to escalate).
 * Returns `failOpen:true` when the text was unparseable so the caller can make the
 * otherwise-silent escalation observable (the fail-open default itself is unchanged).
 */
export function parseProspectorScore(text: string): { score: number; failOpen: boolean } {
  const match = /-?\d*\.?\d+/.exec(text);
  if (match === null) return { score: 1, failOpen: true }; // unparseable -> escalate.
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return { score: 1, failOpen: true };
  return { score: Math.max(0, Math.min(1, n)), failOpen: false };
}

/**
 * Parse the Sonnet judge's structured JSON defensively. The model is instructed to emit
 * ONLY JSON; we tolerate stray prose by extracting the first {...} block. A malformed
 * verdict returns null (the dispatch then SILENCEs — fail-closed: a parse failure must
 * never fire a nudge).
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const phase = o.phase;
  const phases: readonly PromptPhase[] = ['continuation', 'correction', 'new-task', 'escalation', 'ambiguous'];
  if (typeof phase !== 'string' || !phases.includes(phase as PromptPhase)) return null;

  const interrupt = o.interrupt === true;
  const confidence = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : 0;
  const primaryLever = typeof o.primary_lever === 'string' ? o.primary_lever : '';
  const missingPiece = typeof o.missing_piece === 'string' && o.missing_piece.length > 0 ? o.missing_piece : null;
  const nudge = typeof o.nudge === 'string' && o.nudge.trim().length > 0 ? o.nudge.trim() : null;
  const risk = o.risk_level === 'high' || o.risk_level === 'medium' ? o.risk_level : 'low';

  const sf = (o.skill_fit ?? {}) as Record<string, unknown>;
  const candidateSkill = typeof sf.candidate_skill === 'string' && sf.candidate_skill.length > 0 ? sf.candidate_skill : null;
  const sfConfidence = typeof sf.confidence === 'number' && Number.isFinite(sf.confidence) ? sf.confidence : 0;

  // Capability-awareness: parse capability_fit with the SAME defensive pattern as
  // skill_fit. A missing/malformed block -> { candidate_capability:null, confidence:0 }.
  const cf = (o.capability_fit ?? {}) as Record<string, unknown>;
  const candidateCapability =
    typeof cf.candidate_capability === 'string' && cf.candidate_capability.length > 0 ? cf.candidate_capability : null;
  const cfConfidence = typeof cf.confidence === 'number' && Number.isFinite(cf.confidence) ? cf.confidence : 0;

  const scores: Record<string, number> = {};
  const ds = (o.dimension_scores ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ds)) {
    if (typeof v === 'number' && Number.isFinite(v)) scores[k] = v;
  }

  return {
    phase: phase as PromptPhase,
    dimension_scores: scores,
    missing_piece: missingPiece,
    risk_level: risk,
    skill_fit: { candidate_skill: candidateSkill, confidence: sfConfidence },
    capability_fit: { candidate_capability: candidateCapability, confidence: cfConfidence },
    interrupt,
    confidence,
    primary_lever: primaryLever,
    nudge,
  };
}
