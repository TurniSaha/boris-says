/**
 * src/brain/prompt-intent.ts — M1 relevance overhaul: the prompt-intent classifier.
 *
 * The GOAL.md relevance invariant's PROMPT-INTENT GATE detector: read-only / investigative
 * prompts ("check X", "look at Y", "why does Z…") suppress change-directed nudges. This
 * module only DETECTS; the cascade owns the gate.
 *
 * PURE, DETERMINISTIC, TRANSCRIPT-BLIND (mirrors judge-reflex.ts): a verdict over the
 * prompt text alone — no LLM, no clock, no I/O, so the hot path stays free.
 *
 * THE MODULE CONTRACT (precision over recall):
 *  - 'read_only' fires ONLY when BOTH hold on the trimmed, lowercased prompt:
 *      (1) it LEADS with an investigative shape ("check …", "why …", "show me …"), AND
 *      (2) NO change-directed token appears anywhere (the veto — mixed intent like
 *          "check the config and fix the timeout" is NOT read-only).
 *  - Everything else — empty input, terse expert prompts, non-leading questions,
 *    imperatives — is 'unknown'. UNKNOWN IS INERT: it never suppresses and never
 *    triggers anything. A misread here can only cost a suppression, never a fire.
 */

export type PromptIntent = 'read_only' | 'unknown';

/**
 * The leading investigative shape: the prompt's FIRST word/phrase is an inspect/explain
 * verb or a question opener. Anchored — a question buried mid-prompt does not count.
 */
const READ_ONLY_LEAD_RE =
  /^(check|look( at| into| through)?|read|show( me)?|list|find|search|grep|explain|describe|summarize|investigate|inspect|trace|compare|count|tell me|walk me through|why|what|where|when|which|who|how|is|are|does|do|did|was|were|can you (explain|tell|show|describe)|could you (explain|tell|show|describe))\b/;

/**
 * Change-directed tokens: ANY occurrence vetoes 'read_only' (word-boundary matched).
 * The list is verbs that ask the agent to change/plan/verify a change.
 */
const CHANGE_DIRECTED_TOKENS: readonly string[] = [
  'fix',
  'add',
  'implement',
  'write',
  'create',
  'build',
  'make',
  'update',
  'change',
  'edit',
  'modify',
  'refactor',
  'rewrite',
  'remove',
  'delete',
  'rename',
  'replace',
  'wire',
  'migrate',
  'install',
  'upgrade',
  'bump',
  'revert',
  'commit',
  'push',
  'merge',
  'deploy',
  'apply',
  'patch',
  'clean up',
  'prune',
  'optimize',
];

/**
 * A veto token immediately preceded by a determiner/possessive is in NOUN position
 * ("the deploy webhook config", "the fix for the timeout") — describing a thing to
 * inspect, not an action to take — so it does not veto. The live specimen depends on
 * this: "check the deploy webhook config in the repo" is read-only.
 */
const NOUN_POSITION_LOOKBEHIND =
  '(?<!\\b(?:the|a|an|this|that|these|those|your|my|our|its|their)\\s)';

const CHANGE_DIRECTED_RES: readonly RegExp[] = CHANGE_DIRECTED_TOKENS.map(
  (tok) => new RegExp(`${NOUN_POSITION_LOOKBEHIND}\\b${tok}\\b`),
);

/**
 * Classify one prompt's intent. Returns 'read_only' ONLY on a leading investigative shape
 * with no change-directed token anywhere; else 'unknown' (which is INERT — see the module
 * contract above). Pure — the same text always yields the same verdict.
 */
export function classifyPromptIntent(prompt: string): PromptIntent {
  const folded = prompt.trim().toLowerCase();
  if (folded.length === 0) return 'unknown';
  if (!READ_ONLY_LEAD_RE.test(folded)) return 'unknown';
  if (CHANGE_DIRECTED_RES.some((re) => re.test(folded))) return 'unknown';
  return 'read_only';
}
