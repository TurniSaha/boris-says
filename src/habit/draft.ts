/**
 * src/habit/draft.ts — the PURE draft seam for M3 (repetition→artifact).
 *
 * When the miner promotes a survivor (a repetition that passed EVERY §5.5.6
 * gate), it may ask Sonnet for ONE drafted primitive: a skill, a CLAUDE.md
 * rule, or a hook script. This module owns the three pure pieces of that seam:
 *
 *   - DRAFT_SYSTEM + renderDraftRequest: the prompt (evidence-only, may answer null)
 *   - parseDraft: fail-closed shaping of the model's raw text into a proposal
 *   - isDraftGrounded: the DETERMINISTIC groundedness guardrail (D3) — a draft
 *     whose body introduces steps/tools absent from the cited evidence is
 *     mechanically rejected, never trusted to the prompt alone.
 *
 * Precision over recall: ANY failure (null answer, parse fail, groundedness
 * fail, oversize) means NO draft — detection is never blocked by drafting.
 */
import type { Pattern, PatternDraft } from './patterns-store.js';
import { anchorTokens } from './matcher.js';

/** Hard cap on a drafted file body (chars) — oversize → no draft. */
export const MAX_DRAFT_CONTENT_CHARS = 4000;
/** At most this many draft LLM calls per mine (rides the 24h miner throttle). */
export const MAX_DRAFTS_PER_MINE = 2;
/** Minimum fraction of a draft's content tokens that must appear in the evidence. */
export const DRAFT_GROUNDEDNESS_MIN_RATIO = 0.6;

/** A parsed draft proposal — `createdAt` is stamped by the miner on attach. */
export type DraftProposal = Omit<PatternDraft, 'createdAt'>;

const DRAFT_KINDS: ReadonlySet<string> = new Set(['skill', 'claude_md_rule', 'hook']);

/**
 * The one-shot draft system prompt (D2). Output contract: a single raw JSON
 * object or the literal `null` — parseDraft fails closed on anything else.
 */
export const DRAFT_SYSTEM =
  'You turn ONE recurring developer habit (mined from their real typed prompts) into ONE draft ' +
  'automation primitive for Claude Code. You are given the habit, its concrete fix, and the verbatim ' +
  'evidence lines (the actual prompts the developer typed).\n\n' +
  'Pick the kind by shape:\n' +
  '- "skill": the evidence shows a MULTI-STEP relayed workflow (>= 2 ordered steps). content MUST be a ' +
  'complete SKILL.md: `---` frontmatter with `name` and `description` keys, then the body.\n' +
  '- "claude_md_rule": an every-time single directive. content is a short markdown section ' +
  '(a `## title` line + 1-3 bullets) suitable for appending to CLAUDE.md.\n' +
  '- "hook": a mechanically-checkable rule. content is a standalone script whose HEADER COMMENT contains ' +
  'the proposed settings.json hook snippet (the script is the whole artifact; settings are never edited).\n\n' +
  'HARD RULE: the content may ONLY restate what appears in the cited evidence lines, the habit, and the ' +
  'fix — NEVER invent steps, tools, file paths, or behavior that the evidence does not show. If the ' +
  'evidence is not enough for a complete, correct artifact, output the literal `null`.\n\n' +
  'Output ONLY one raw JSON object (no prose, no markdown fences) exactly of the form:\n' +
  '{ "kind": "skill" | "claude_md_rule" | "hook", "name": "<a-z0-9- slug>", "content": "<file body>" }\n' +
  'or the literal `null`.';

/** Render the per-pattern user message: habit, fix, why, and verbatim evidence. */
export function renderDraftRequest(pattern: Pattern): string {
  const evidence = pattern.occurrences
    .map((o) => `- [session ${o.sessionId}] ${o.evidence}`)
    .join('\n');
  return (
    `habit_key: ${pattern.habit_key}\n` +
    `habit: ${pattern.habit}\n` +
    `fix: ${pattern.fix}\n` +
    `why_inefficient: ${pattern.why_inefficient}\n` +
    `evidence (verbatim typed prompts):\n${evidence}`
  );
}

/** Extract the first {...} block from `text` and JSON.parse it; null on failure. */
function extractObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A safe artifact slug: lowercase [a-z0-9-] only (no `..`, no `/`, no spaces). */
const SLUG_RE = /^[a-z0-9-]+$/;

/** Does `content` open with a `---` frontmatter block (required for skills)? */
function hasFrontmatter(content: string): boolean {
  return /^---\r?\n[\s\S]+?\r?\n---(\r?\n|$)/.test(content);
}

/**
 * Fail-closed parse of the draft model response (D2). Returns null on: no JSON
 * object, literal `null` answer, kind outside the enum, unsafe/empty name,
 * empty or oversize content, or a skill body without frontmatter.
 */
export function parseDraft(text: string): DraftProposal | null {
  const obj = extractObject(text);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const kind = o.kind;
  if (typeof kind !== 'string' || !DRAFT_KINDS.has(kind)) return null;

  const name = o.name;
  if (typeof name !== 'string' || !SLUG_RE.test(name)) return null;

  const content = o.content;
  if (typeof content !== 'string') return null;
  if (content.trim().length === 0) return null;
  if (content.length > MAX_DRAFT_CONTENT_CHARS) return null;
  if (kind === 'skill' && !hasFrontmatter(content)) return null;

  return { kind: kind as DraftProposal['kind'], name, content };
}

/**
 * Scaffold tokens a draft legitimately needs that the evidence never contains:
 * frontmatter keys + markdown structure words. Everything else must be grounded.
 */
const SCAFFOLD_TOKENS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'step',
  'steps',
  'when',
  'then',
  'title',
  'usage',
  'instructions',
]);

/** The unique content tokens of a draft body that must be evidence-grounded. */
function contentTokens(content: string): Set<string> {
  const out = new Set<string>();
  for (const tok of anchorTokens(content)) {
    if (tok.length < 4) continue; // drop glue words / markdown noise.
    if (SCAFFOLD_TOKENS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * D3 groundedness guardrail (deterministic, PURE): >= 60% of the draft body's
 * content tokens must appear in the token union of (all occurrence evidence +
 * habit + fix + match_phrases). A body with NO content tokens fails closed.
 */
export function isDraftGrounded(draft: DraftProposal, pattern: Pattern): boolean {
  const tokens = contentTokens(draft.content);
  if (tokens.size === 0) return false; // nothing checkable → no draft (fail closed).

  const grounded = new Set<string>();
  const sources = [
    ...pattern.occurrences.map((o) => o.evidence),
    pattern.habit,
    pattern.fix,
    ...pattern.match_phrases,
  ];
  for (const src of sources) for (const tok of anchorTokens(src)) grounded.add(tok);

  let hits = 0;
  for (const tok of tokens) if (grounded.has(tok)) hits += 1;
  return hits / tokens.size >= DRAFT_GROUNDEDNESS_MIN_RATIO;
}
