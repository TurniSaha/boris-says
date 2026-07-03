/**
 * src/brain/judge-cascade.ts — PILLAR 1, the per-prompt QUALITY CASCADE.
 *
 * THE heart of the prompt-coach: for one just-typed prompt, run the 8-step cascade and
 * return the composed coaching tip (or null = stay silent). The CALLER (judge.ts)
 * deposits the tip into the mailbox and records the cooldown/lever — this module is a
 * PURE decision function over its injected inputs (no dispatcher, no repos, no I/O of
 * its own beyond the injected backend).
 *
 * PORT NOTE (SPEC §5, §15): this is the server `createJudgeDispatch` cascade
 * (the upstream coach service `pm-service/src/triggers/judge-dispatch.ts`) with EVERY server seam
 * removed — no NormalizedEvent batch, no roomId/userId/source, no retrieval reader, no
 * peopleRepo, no nudgeDispatcher, no NudgeLedger, no CoachingOutcomesRepo, no adaptive
 * thresholdFor. The cascade ORDER and the THRESHOLDS are unchanged; identity collapses
 * to a single `sessionId` (decision #6) and the firing floor is the STATIC
 * `skill.preRunConfidence` (§9b). The §5.5.5 CODE GATES — deferred from the brain port —
 * are implemented HERE (launch-only drop, model-gate passthrough, expensive-multiagent +
 * goal/scope guards, backtick-token validation, narrowed skill-wins).
 */
import {
  buildJudgeUser,
  buildProspectorUser,
  renderExternalSection,
  type PromptCoachSkill,
} from './prompt-coach-skill.js';
import type { ExternalCandidate } from '../capability/skill-index.js';
import { reflex } from './judge-reflex.js';
import { classifyPromptIntent } from './prompt-intent.js';
import { namesDestructiveDataOp } from './destructive-op.js';
import { createCoachLiveness, COACH_FIRST_RUN_TOUR } from './coach-liveness.js';
import {
  parseJudgeVerdict,
  parseProspectorScore,
  type JudgeVerdict,
} from './parse-verdict.js';
import { formatCoachBanner } from './mailbox-format.js';
import { renderTasteSection, type TasteExample } from './taste.js';
import type { LlmBackend } from '../llm/backend.js';
import {
  resolveCapability,
  type Capability,
  type CapabilityModelFamily,
  type CapabilityPerson,
} from '../capability/catalog.js';
import { QUALITY_COOLDOWN_MS, adaptiveFloorDelta, type CoachState } from '../state/store.js';

// ── Ported constants (verbatim from judge-dispatch.ts) ───────────────────────
/** Prior typed prompts fed to the judge (oldest-first). Caller pre-trims; we re-clamp. */
const MAX_TRANSCRIPT = 8;
/** The Haiku prospector emits a single 0-1 score. */
const PROSPECTOR_MAX_TOKENS = 8;
/** The Sonnet judge emits one structured JSON verdict. */
const JUDGE_MAX_TOKENS = 600;
/** Hard cap on the composed nudge length. */
const NUDGE_CAP = 500;
/** Headroom reserved so a non-cheap capability's cost clause survives truncation. */
const COST_CLAUSE_RESERVE = 60;
/** Cost-disclosure clauses (§17). */
const BILLED_COST_CLAUSE = ' (uses extra usage)';
const EXPENSIVE_COST_CLAUSE = ' (runs a multi-agent cloud job — uses extra usage)';

/** Levers where the task itself is not yet defined → no how-to skill/capability (§5.5.5c). */
const UNDEFINED_TASK_LEVERS: ReadonlySet<string> = new Set(['goal_clarity', 'scope_boundaries']);
/** Levers where an expensive multi-agent capability is the wrong tool (§5.5.5c). */
const SCOPE_FIRST_LEVERS: ReadonlySet<string> = new Set(['scope_boundaries', 'acceptance_criteria']);

/**
 * PROMPT-INTENT GATE (GOAL.md relevance invariant): levers whose advice is an ask to
 * change / plan / verify a CHANGE. A READ-ONLY prompt ("check X", "why does Z…") is not
 * asking for a change, so these levers are suppressed on it. Lever-scoped on purpose —
 * a read-only prompt still legitimately receives goal_clarity / skill-surfacing tips.
 */
const CHANGE_DIRECTED_LEVERS: ReadonlySet<string> = new Set([
  'verification_path',
  'risk_awareness',
  'acceptance_criteria',
  'process_fit',
]);

/**
 * A 3-state skill action. Local structural mirror of the server `SkillAction` so the
 * cascade is decoupled from a concrete skill-catalog module. `kind:'none'` = no skill
 * rides (a capability may then ride).
 */
export interface SkillAction {
  readonly kind: 'none' | 'run' | 'install_run';
  readonly skillId?: string;
}

/**
 * The LOCAL CONTEXT the cascade reads to SUPPRESS a tip the dev does not need (SPEC
 * §8.6 / Part A). Every field is optional/nullable: a field that is null/undefined is
 * UNKNOWN — it NEVER suppresses (the fail-safe is absolute, see `localContextSuppresses`).
 * Gathered ONCE per run by `gatherLocalContext` (local-context-probe.ts) and passed in.
 *
 * NOTE: `activeModel` here is the RAW JSONL model string (e.g. 'claude-opus-4-8') — NOT
 * the §5.5.5b family enum. The cascade does NOT re-derive the family from this; judge.ts
 * maps the raw string → `CapabilityModelFamily` for the separate `activeModel` param.
 */
export interface LocalContext {
  /** Raw JSONL model string, e.g. 'claude-opus-4-8' (NOT the family enum). */
  readonly activeModel?: string | null;
  /** 'normal' | 'plan' | 'bypassPermissions' | ... — the dev's current mode. */
  readonly mode?: string | null;
  /** 'high' | 'xhigh' | ... — the dev's current coding effort. */
  readonly effort?: string | null;
  readonly git?: {
    readonly onBranch?: boolean | null;
    readonly dirty?: boolean | null;
    readonly branch?: string | null;
  } | null;
  readonly project?: {
    readonly claudeMdPresent?: boolean | null;
    readonly testCmdDocumented?: boolean | null;
    readonly planModeMandated?: boolean | null;
    readonly hooksConfigured?: boolean | null;
  } | null;
}

/** The neutral "no skill" action. */
export const NO_SKILL_ACTION: SkillAction = { kind: 'none' };

/**
 * The merged skill catalog the judge reads (installed-skills scan + curated set, SPEC
 * §15). `all` is the list of skill ids rendered into the judge input; `resolveAction`
 * turns a recommended skill id into a 3-state action. Structural so a test can inject a
 * stub and the real skill-catalog module can satisfy it later.
 */
export interface MergedSkillCatalog {
  readonly all: readonly string[];
  resolveAction(skillId: string): SkillAction;
}

/** The cascade input contract — SPEC §15 (server seams removed). */
export interface QualityCascadeInput {
  /** The stdin `prompt` (§4) — the verbatim just-typed prompt. */
  readonly prompt: string;
  /** Prior typed prompts, oldest-first, current EXCLUDED (§7.1). */
  readonly transcript: readonly string[];
  readonly backend: LlmBackend;
  readonly skill: PromptCoachSkill;
  readonly state: CoachState;
  readonly catalog: MergedSkillCatalog;
  /** Available-to-this-dev capabilities (§16/§17). */
  readonly capabilities: readonly Capability[];
  /** The surviving identity (decision #6). */
  readonly sessionId: string;
  readonly now: () => number;
  /**
   * Optional active model family for the §5.5.5b model-gate. When provided it is
   * threaded into `resolveCapability` so a model-scoped capability the dev cannot use is
   * never re-attached at deposit time. Omitted = version-only resolution.
   */
  readonly activeModel?: CapabilityModelFamily;
  /**
   * Optional LOCAL CONTEXT (SPEC §8.6 / Part B) — cheap on-disk facts (mode, git state,
   * project config) the LLM judge cannot see. When present, the suppression gate may
   * SILENCE a tip the dev does not need. ABSENT = today's behavior (no suppression). A
   * null/undefined signal within it is UNKNOWN and NEVER suppresses.
   */
  readonly localContext?: LocalContext;
  /**
   * Item 3: true ONCE PER INSTALL → prepend the first-run TOUR (additive, 4 lines). The
   * caller computes it via store.markTourShownIfFirst() (persisted install-wide, migration-
   * guarded for engaged upgraders). Omitted/false → no tour (the steady state — the
   * every-session ping is dead). Field name kept `firstSeen` for call-site stability.
   */
  readonly firstSeen?: boolean;
  /**
   * W2-LEVEL1: optional owner taste examples (their 👍/👎 on real prompts), selected by
   * taste.selectTasteExamples and loaded by judge.ts. Rendered into the judge user-prompt as
   * ADVISORY few-shot context (in-context learning, NO training). Omitted/empty = cold-start
   * → the judge input is byte-identical to pre-Level-1 (parity). NEVER overrides the judge's
   * own safety policy; only nudges borderline calls.
   */
  readonly tasteExamples?: readonly TasteExample[];
  /**
   * M4: optional pre-matched EXTERNAL skill candidates (matchExternalSkills output —
   * ≤ 5, floor-gated, installed/curated/capability collisions already dropped). They ride
   * the judge input as a bounded one-line-each section; omitted/empty = the judge input is
   * byte-identical to a build without the index (the M4 parity guarantee). Resolution is
   * fail-closed: a verdict naming an id NOT in this list stays today's silent no-op.
   */
  readonly externalCandidates?: readonly ExternalCandidate[];
  /** Optional debug observer (replaces the server `onObserve` seam — §15a). */
  readonly observe?: (stage: string, delivered: boolean) => void;
}

/**
 * The cascade result: the composed tip to deposit, or null = stay silent. `lever` is the
 * primary lever the firing gate fired on — the CALLER (judge.ts) records it in the same
 * atomic state write that marks the quality cooldown (§15b same-lever suppression). It is
 * absent for non-firing surfaces (a bare liveness ping/sentinel deposits no lever).
 */
export type QualityCascadeResult = { tip: string; lever?: string } | null;

/** A process-local liveness checker (one per process; sessionId-keyed — §15c). */
const liveness = createCoachLiveness();

/** Cost-disclosure clause for a capability's costClass (disclose, never gate — §17). */
function costClauseFor(costClass: Capability['costClass']): string {
  if (costClass === 'expensive_multiagent') return EXPENSIVE_COST_CLAUSE;
  if (costClass === 'billed') return BILLED_COST_CLAUSE;
  return '';
}

/**
 * Extract the backticked / exact-trigger tokens a nudge names (§5.5.5f). We look for
 * any text wrapped in backticks — the JUDGE_SYSTEM instructs the model to name a
 * capability's exact trigger in backticks (e.g. "try `/design-sync`"). Returns the inner
 * tokens, trimmed, in source order.
 */
function backtickTokens(nudge: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(nudge)) !== null) {
    const tok = m[1].trim();
    if (tok.length > 0) out.push(tok);
  }
  return out;
}

const fold = (s: string): string => s.trim().toLowerCase();

/**
 * §5.5.5f BACKTICK-TOKEN VALIDATION (fail-CLOSED). For every backticked token in the
 * composed nudge, if it resolves to a catalog entry that is NOT in the AVAILABLE list,
 * the verdict named a thing the dev cannot use → treat as malformed and SILENCE. A token
 * that maps to no catalog entry at all is benign prose (a file path, a var name) — only
 * a token that IS a real capability but is unavailable trips the gate. Do NOT inline-scrub.
 */
function nudgeNamesUnavailableCapability(
  nudge: string,
  available: readonly Capability[],
): boolean {
  const availableKeys = new Set<string>();
  for (const c of available) {
    availableKeys.add(fold(c.id));
    availableKeys.add(fold(c.trigger));
  }
  for (const token of backtickTokens(nudge)) {
    // Resolve against the FULL catalog (resolveCapability's default) to learn whether
    // this token is a real capability at all.
    const resolved = resolveCapability(token, { installedCommands: null, cliVersion: null });
    if (resolved.capability === null) continue; // not a capability → benign prose.
    const key = fold(token);
    const idKey = fold(resolved.capability.id);
    const triggerKey = fold(resolved.capability.trigger);
    // It IS a known capability; is it in the available list?
    if (!availableKeys.has(key) && !availableKeys.has(idKey) && !availableKeys.has(triggerKey)) {
      return true; // names an unavailable capability → fail-closed.
    }
  }
  return false;
}

/**
 * Run the per-prompt quality cascade (SPEC §5.1, §15). Returns the composed tip to
 * surface, or null to stay silent. Pure w.r.t. its inputs aside from the injected
 * backend; the caller deposits + records.
 */
export async function runQualityCascade(input: QualityCascadeInput): Promise<QualityCascadeResult> {
  const { prompt, backend, skill, state, catalog, sessionId, now } = input;
  const observe = input.observe ?? (() => {});

  // (1) LIVENESS (zero cost). SENTINEL ('when life gives you lemons') short-circuits with the
  // canned reply — fire-every-time, no persistence needed (pure text gate via `liveness`).
  const live = liveness.check(sessionId, prompt);
  if (live.sentinel !== null) {
    observe('liveness_sentinel', true);
    return { tip: formatCoachBanner(live.sentinel) };
  }
  // The FIRST-RUN TOUR is ONE-TIME PER INSTALL. Its flag is PERSISTENT install-wide
  // (input.firstSeen, computed by the caller via store.markTourShownIfFirst) — the every-
  // session ping is dead (item 3); a new user sees the 4-line tour exactly once, then silence.
  // ADDITIVE: the cascade still runs so a genuinely weak first prompt still gets real coaching.
  let pingPrefix = '';
  if (input.firstSeen === true) {
    observe('liveness_ping', true);
    pingPrefix = `${formatCoachBanner(COACH_FIRST_RUN_TOUR)}\n`;
  }

  // (2) TIER-0 REFLEX (pure, no LLM). Trivial/continuation/approval → SILENCE.
  if (reflex(prompt).suppress) {
    observe('reflex_suppressed', false);
    return pingFallback(pingPrefix);
  }

  // (3) CADENCE — the PER-SESSION quality cooldown (replaces the server JudgeRateLimit). Keyed
  // by THIS session's last tip, NOT the global lastQualityTipAt — a tip in another session must
  // not throttle coaching here (the cross-session "intro then nothing" bleed). The ?? guards an
  // old on-disk state.json that predates the per-session map.
  const lastAt = (state.lastQualityTipBySession ?? {})[sessionId] ?? null;
  if (lastAt !== null && now() - lastAt < QUALITY_COOLDOWN_MS) {
    observe('cadence_suppressed', false);
    return pingFallback(pingPrefix);
  }

  // (4) CONTEXT — the caller supplies the prior transcript (current excluded). We
  // re-clamp to MAX_TRANSCRIPT defensively and keep oldest-first. rollingSummary is '' —
  // there is no server profile locally.
  const transcript = input.transcript.slice(-MAX_TRANSCRIPT);
  const rollingSummary = '';

  // §5.5.5a LAUNCH-ONLY DROP: mid-session (a transcript exists) a launch-only capability
  // would mean killing the loaded session, so drop them BEFORE building the judge input —
  // a launch-only flag is never even offered mid-session. §5.5.5b model-gate is honored
  // by resolveCapability via the optional activeModel; we re-filter the AVAILABLE list
  // through it here so the judge only ever sees usable capabilities.
  const midSession = transcript.length > 0;
  const capabilities = input.capabilities.filter((c) => {
    if (midSession && c.appliesAt === 'launch') return false;
    // Re-confirm model-gate with the active model when known (defense in depth). Honor the
    // SET form (`modelFamilies`) when present, else the scalar `modelFamily` — matching
    // resolveCapability — so a multi-family capability (e.g. xhigh on Opus+Fable) is not
    // wrongly dropped/kept. UNKNOWN active model never gates (fail-safe).
    const scoped: readonly CapabilityModelFamily[] | undefined =
      c.modelFamilies ?? (c.modelFamily !== undefined ? [c.modelFamily] : undefined);
    if (input.activeModel !== undefined && scoped !== undefined && !scoped.includes(input.activeModel)) {
      return false;
    }
    return true;
  });
  const capabilityLines = capabilities.map(capabilityLine);

  // (5) TIER-1 HAIKU PROSPECTOR (suppress-only). Guard null FIRST (§6.2): unavailable
  // backend → silence. Then parse; below the band → SILENCE; fail-OPEN on unparseable
  // (escalate, source semantics).
  const prospect = await backend.complete({
    system: skill.prospectorSystem,
    user: buildProspectorUser(prompt, transcript),
    model: 'haiku',
    maxTokens: PROSPECTOR_MAX_TOKENS,
  });
  if (prospect === null) {
    observe('prospector_unavailable', false);
    return pingFallback(pingPrefix);
  }
  const prospectorScore = parseProspectorScore(prospect);
  if (prospectorScore.failOpen) observe('prospector_fail_open', false);
  if (prospectorScore.score < skill.prospectorEscalateBand) {
    observe('prospector_suppressed', false);
    return pingFallback(pingPrefix);
  }

  // (6) TIER-2 SONNET JUDGE+COMPOSER. Guard null FIRST (§6.2): unavailable → silence.
  // Then parse; malformed → fail-CLOSED (null → silence).
  // W2-LEVEL1: render the owner's taste examples (advisory few-shot). '' on cold-start →
  // buildJudgeUser omits the section → byte-identical to pre-Level-1.
  const tasteSection = renderTasteSection(input.tasteExamples ?? []);
  // M4: the pre-matched external candidates (≤ 5 one-liners) — '' when absent/empty →
  // buildJudgeUser omits the section → byte-identical judge input (parity).
  const externalSection = renderExternalSection(input.externalCandidates ?? []);
  const judgment = await backend.complete({
    system: skill.judgeSystem,
    user: buildJudgeUser(prompt, transcript, rollingSummary, catalog.all, capabilityLines, tasteSection, externalSection),
    model: skill.judgeModel, // default opus (deepest reasoner); env-overridable to sonnet.
    maxTokens: JUDGE_MAX_TOKENS,
  });
  if (judgment === null) {
    observe('verdict_unavailable', false);
    return pingFallback(pingPrefix);
  }
  const verdict = parseJudgeVerdict(judgment);
  if (verdict === null) {
    observe('verdict_malformed', false);
    return pingFallback(pingPrefix);
  }

  // (7) FIRING GATE — eligible phase AND interrupt AND confidence ≥ the ADAPTIVE per-lever
  // floor AND a non-empty missing_piece AND a non-empty nudge AND the lever not already used
  // this session. NO aggregate ceiling/ledger (§5.1 step 7).
  //
  // F-FEEDBACK: the floor is the static `skill.preRunConfidence` PLUS the lever's learned
  // delta from the owner's 👍/👎 ratings (a 👎-heavy lever fires LESS, a 👍-loved one fires
  // MORE). The delta is 0 until ≥ N ratings on that lever (no single-rating swing), bounded,
  // and computed PURELY from the passed-in state — so the gate stays a pure decision.
  const lever = verdict.primary_lever || 'goal_clarity';
  const floorDelta = adaptiveFloorDelta(state.feedbackByLever[lever]);
  const adaptiveFloor = skill.preRunConfidence + floorDelta;
  const eligiblePhase = skill.interruptEligiblePhases.has(verdict.phase);
  if (!(eligiblePhase && verdict.interrupt && verdict.confidence >= adaptiveFloor)) {
    observe('firing_gate_suppressed', false);
    return pingFallback(pingPrefix);
  }
  if (verdict.missing_piece === null) {
    observe('firing_gate_suppressed', false);
    return pingFallback(pingPrefix);
  }
  if (verdict.nudge === null) {
    observe('firing_gate_suppressed', false);
    return pingFallback(pingPrefix);
  }
  const usedThisSession = state.leversUsedBySession[sessionId] ?? [];
  if (usedThisSession.includes(lever)) {
    observe('firing_gate_suppressed', false);
    return pingFallback(pingPrefix);
  }

  // (7c) PROMPT-INTENT GATE (GOAL.md relevance invariant). A READ-ONLY / investigative
  // prompt is not asking for a change, so a change-directed lever's nudge would be about
  // work the dev did NOT just ask for → SILENCE. SUPPRESS-ONLY and LEVER-SCOPED: 'unknown'
  // intent never suppresses anything, a non-change-directed lever always passes, and the
  // gate can never cause a fire.
  if (CHANGE_DIRECTED_LEVERS.has(lever) && classifyPromptIntent(prompt) === 'read_only') {
    observe('intent_suppressed', false);
    return pingFallback(pingPrefix);
  }

  // (7b) LOCAL-CONTEXT SUPPRESSION (SPEC §8.6 / Part B). A POSITIVELY-OBSERVED local fact
  // (in plan mode already, test command documented, clean branch with an undo) means the
  // gap the verdict fired on is already covered → SILENCE. The fail-safe is ABSOLUTE: an
  // UNKNOWN (null/undefined) signal never suppresses, and an ABSENT localContext is
  // today's behavior. Runs AFTER the same-lever gate, BEFORE composeTip.
  if (input.localContext && localContextSuppresses(lever, verdict, input.localContext, prompt)) {
    observe('localcontext_suppressed', false);
    return pingFallback(pingPrefix);
  }

  // (8) RESOLVE AFFORDANCE + COMPOSE. SKILL WINS over capability (narrowed per §5.5.5).
  const tip = composeTip(verdict, lever, catalog, capabilities, input.activeModel, input.externalCandidates ?? []);
  if (tip === null) {
    // §5.5.5f fail-closed silence, or an empty composed message.
    observe('firing_gate_suppressed', false);
    return pingFallback(pingPrefix);
  }

  observe('dispatched', true);
  return { tip: pingPrefix + tip, lever };
}

/**
 * When the cascade decides NOT to fire a quality tip but a first-seen ping is pending,
 * the ping is still ADDITIVE — surface it alone. No ping → null (silence).
 */
function pingFallback(pingPrefix: string): QualityCascadeResult {
  if (pingPrefix.length === 0) return null;
  // Strip the trailing newline the prefix carries for concatenation with a real tip.
  return { tip: pingPrefix.replace(/\n$/, '') };
}

/**
 * §8.6 / Part B — decide whether a POSITIVELY-OBSERVED local fact makes the fired lever's
 * nudge redundant (→ suppress). PURE. The fail-safe is ABSOLUTE:
 *  - UNKNOWN (null/undefined) NEVER suppresses; only a positive observation suppresses.
 *  - A lever not in the three targeted cases is NEVER suppressed here.
 *  - The caller only invokes this when `input.localContext` is present; an ABSENT
 *    localContext is today's behavior (no suppression) by construction.
 *
 * Three cases:
 *  SUP-1 process_fit (L01): suppress when the dev is ALREADY in plan mode
 *    (`mode === 'plan'`) OR the project mandates plan mode
 *    (`project.planModeMandated === true`). Don't tell a planner to plan.
 *  SUP-2 verification_path (V01) / acceptance_criteria (L05): suppress when the test
 *    command is documented (`project.testCmdDocumented === true`) — the how-to-verify /
 *    definition-of-done already lives in CLAUDE.md.
 *  SUP-3 risk_awareness (L26): suppress ONLY on a positively-observed CLEAN BRANCH
 *    (`git.onBranch === true && git.dirty === false`) — an undo already exists. Anything
 *    null/undefined, dirty, or `git === null` → no suppression (fire as today).
 *    CARVE-OUT (item 7): a clean branch is NOT an undo for a DATA-DESTRUCTIVE op the prompt
 *    names (DROP/DELETE FROM/TRUNCATE/destructive prod migration) — a git branch does not
 *    roll back a dropped table. When `namesDestructiveDataOp(prompt)` is true, SUP-3 does NOT
 *    suppress risk_awareness (deterministic typed-prompt detection, no LLM; innocent prose
 *    like "drop me a note" / "dropdown" / "delete the comment in the code" never trips it).
 *    SUP-3 still suppresses for ordinary CODE-risk on a clean branch (the original case).
 */
export function localContextSuppresses(
  lever: string,
  _verdict: JudgeVerdict,
  localContext: LocalContext,
  prompt = '',
): boolean {
  // SUP-1 — plan-mode-on → process_fit silent.
  if (lever === 'process_fit') {
    if (localContext.mode === 'plan') return true;
    if (localContext.project?.planModeMandated === true) return true;
    return false;
  }

  // SUP-2 — testCmdDocumented → verification_path / acceptance_criteria silent.
  if (lever === 'verification_path' || lever === 'acceptance_criteria') {
    return localContext.project?.testCmdDocumented === true;
  }

  // SUP-3 — clean branch → risk_awareness silent (positive observation only).
  if (lever === 'risk_awareness') {
    // CARVE-OUT (item 7): a data-destructive op named in the prompt is NOT undone by a git
    // branch — never suppress risk_awareness on it, even on a clean branch.
    if (namesDestructiveDataOp(prompt)) return false;
    const git = localContext.git;
    if (git === null || git === undefined) return false; // UNKNOWN.
    return git.onBranch === true && git.dirty === false;
  }

  return false; // not a targeted lever → never suppress.
}

/**
 * Compose the quality tip: resolve the skill action and capability, apply the §5.5.5
 * code gates, validate backtick tokens (fail-closed), append the cost clause, and render
 * the banner. Returns null when the §5.5.5f gate trips or the message is empty.
 */
function composeTip(
  verdict: JudgeVerdict,
  lever: string,
  catalog: MergedSkillCatalog,
  available: readonly Capability[],
  activeModel: CapabilityModelFamily | undefined,
  externalCandidates: readonly ExternalCandidate[] = [],
): string | null {
  // §5.5.5c — the task itself is not yet defined: force NO skill action AND null
  // capability (do not attach a how-to skill/capability when the gap is goal/scope).
  const undefinedTask = UNDEFINED_TASK_LEVERS.has(lever);

  // 1. Resolve the 3-state skill action for the recommended skill, if any.
  const action: SkillAction =
    !undefinedTask && verdict.skill_fit.candidate_skill
      ? catalog.resolveAction(verdict.skill_fit.candidate_skill)
      : NO_SKILL_ACTION;

  // M4 — EXTERNAL fallback: ONLY after the merged catalog resolves 'none' (installed /
  // curated resolution ALWAYS pre-empts an external — installed-catalog-wins), look the
  // verdict's id up (fold) in the pre-matched candidates. Fail-closed: an id not in the
  // list (a judge hallucination) stays today's silent skill no-op. Gated by the
  // undefined-task levers like every other affordance. NEVER executes anything — the tip
  // only PRINTS the source URL + stars and the install command.
  const externalHit: ExternalCandidate | null =
    !undefinedTask && action.kind === 'none' && verdict.skill_fit.candidate_skill
      ? (externalCandidates.find(
          (c) => fold(c.name) === fold(verdict.skill_fit.candidate_skill as string),
        ) ?? null)
      : null;

  // 2. Resolve the recommended capability — ONLY if available to THIS dev.
  const capabilityPerson: CapabilityPerson = {
    installedCommands: null,
    cliVersion: null,
    activeModel,
  };
  const resolved =
    !undefinedTask && verdict.capability_fit.candidate_capability
      ? resolveCapability(verdict.capability_fit.candidate_capability, capabilityPerson, available)
      : null;
  let fitCapability: Capability | null =
    resolved && resolved.available ? resolved.capability : null;

  // §5.5.5c — drop an expensive multi-agent capability on a scope/acceptance lever (scope
  // before parallelizing). The wrong tool for an unbounded task.
  if (
    fitCapability !== null &&
    fitCapability.costClass === 'expensive_multiagent' &&
    SCOPE_FIRST_LEVERS.has(lever)
  ) {
    fitCapability = null;
  }

  // 3. SKILL WINS: a capability only rides when no skill action fires. M4: an external
  // hit OCCUPIES the skill slot, so it too suppresses the capability payload (skill-wins
  // preserved — no cost clause rides alongside an external suggestion).
  const capabilityPayload: Capability | null =
    action.kind !== 'none' || externalHit !== null ? null : fitCapability;

  // 4. COMPOSE the message + cost clause (must survive NUDGE_CAP — §17). nudge is
  // guaranteed non-null by the firing gate.
  const nudge = verdict.nudge as string;
  const costClause = capabilityPayload ? costClauseFor(capabilityPayload.costClass) : '';
  let message =
    costClause.length > 0
      ? nudge.slice(0, NUDGE_CAP - COST_CLAUSE_RESERVE) + costClause
      : nudge.slice(0, NUDGE_CAP);
  if (message.length === 0) return null;

  // M4 — append the plain-text external lines (NO backticks — they must never trip the
  // §5.5.5f gate): a review pointer (source URL + stars when known) and the PRINTED
  // install command. The dev runs it themselves; nothing is ever auto-installed.
  // CAP DISCIPLINE: the composed message must never exceed NUDGE_CAP — if the append
  // would bust it (long nudge, or oversized upstream install/sourceUrl), SKIP the append
  // entirely rather than truncate it (a truncated install command is worse than none).
  if (externalHit !== null) {
    // G-M4b: a NON-official hit is labeled `(community · ★ N)` so the human never
    // mistakes it for a vetted source; official rendering stays byte-identical (`(★ N)`).
    const community = externalHit.trust !== 'official';
    const stars =
      externalHit.repoStars !== null
        ? community
          ? ` (community · ★ ${externalHit.repoStars})`
          : ` (★ ${externalHit.repoStars})`
        : community
          ? ' (community)'
          : '';
    const appendix = `\nreview: ${externalHit.sourceUrl}${stars}\ninstall: ${externalHit.install}`;
    if (message.length + appendix.length <= NUDGE_CAP) {
      message += appendix;
    }
  }

  // §5.5.5f BACKTICK-TOKEN VALIDATION (fail-CLOSED): silence if the nudge names a
  // capability that is NOT in the available list. Validate against the COMPOSED message
  // (the nudge the dev would actually see).
  if (nudgeNamesUnavailableCapability(message, available)) return null;

  // F-FEEDBACK: a real coaching fire shows the 👍/👎 rate hint (a rateable lever rode).
  return formatCoachBanner(message, { withRateHint: true });
}

/**
 * Render one available capability as a judge-input line. Mirrors the server
 * `capabilityLine`: `trigger (kind): what [costClass]`. The §5.5.5a `appliesAt` is
 * appended so the judge can read launch/in_turn context.
 */
function capabilityLine(c: Capability): string {
  const cost =
    c.costClass === 'expensive_multiagent'
      ? ' [expensive_multiagent]'
      : c.costClass === 'billed'
        ? ' [billed]'
        : '';
  return `${c.trigger} (${c.kind}, ${c.appliesAt}): ${c.what}${cost}`;
}
