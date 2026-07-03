/**
 * F-L29 — invite-clarification on materially-unstated assumptions (TUNING-SPEC §A0
 * PROMOTE; Karpathy clarify-1). Primary lever: goal_clarity.
 *
 * USER STORY: I type a prompt with materially-unstated assumptions / an unquantified
 * subjective goal ("make the dashboard better") and no anchoring context. The coach fires
 * a goal_clarity nudge that names the SINGLE most consequential undecided choice as a
 * CONCRETE QUESTION — never the banned "add more detail" / "scope it down" /
 * "decide what it shows". goal_clarity is a NON-TARGETED lever for local-context
 * suppression, so being in plan mode, on a clean branch, or having the test command
 * documented does NOT silence it (the gap is "what do you even want?", which no on-disk
 * fact resolves). And because goal_clarity is an UNDEFINED-TASK lever, the composer
 * forces OFF any how-to skill / capability the judge recommends (you can't optimize
 * toward an undefined outcome yet) — pinned here against the model-scoped capability path.
 *
 * This is a DETERMINISTIC CONTRACT / PINNING test over the SHIPPING cascade
 * (runQualityCascade) + the frozen JUDGE_SYSTEM policy. It does NOT call a live model: the
 * judge tier is a stub returning a crafted `goal_clarity` verdict (what the real Sonnet
 * judge emits for this case). It pins the firing / non-suppression routing + the policy
 * encoding — the parts we own — while the live-matrix eval scores the judge's real verdict
 * quality. Every assertion reflects CURRENT shipping behavior.
 */
import { describe, it, expect } from 'vitest';
import { runQualityCascade, localContextSuppresses, type MergedSkillCatalog } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import type { QualityCascadeInput } from '../src/brain/judge-cascade.js';
import type { JudgeVerdict } from '../src/brain/parse-verdict.js';
import { CAPABILITY_CATALOG, type CapabilityModelFamily } from '../src/capability/catalog.js';
import { reflex } from '../src/brain/judge-reflex.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * A FIRE verdict whose primary lever is goal_clarity, with the nudge phrased as a CONCRETE
 * QUESTION (what the judge is required to emit for an unquantified subjective goal). This
 * is the canonical shape the live judge produces for "make the dashboard better".
 */
function goalClarityVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { goal_clarity: 0.1 },
    missing_piece: 'no concrete definition of "better" for the dashboard',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'goal_clarity',
    nudge: "what's the one data source and 2-3 metrics this dashboard should show first?",
    ...over,
  });
}

/**
 * A backend stub: '0.9' for the haiku prospector (escalate), the crafted judge JSON for
 * the sonnet judge. The optional `capture` records the judge USER input so the F-L25
 * model-scoped-capability assertions can inspect exactly what the judge was shown.
 */
function backend(judge: string, capture?: { judgeUser?: string }): LlmBackend {
  return {
    configured: true,
    async complete(opts: LlmCompleteOptions): Promise<string | null> {
      if (opts.model === 'haiku') return '0.9';
      if (capture) capture.judgeUser = opts.user;
      return judge;
    },
  };
}

let sid = 0;
function nextSession(): string {
  sid += 1;
  return `fl29-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'make the dashboard better',
    transcript: ['earlier prompt'],
    backend: backend(goalClarityVerdict()),
    skill: PROMPT_COACH_SKILL,
    state,
    catalog: emptyCatalog,
    capabilities: [],
    sessionId: nextSession(),
    now: () => 1_000_000,
    ...over,
  };
}

/** Consume the additive first-seen ping so later turns isolate the fire/silence decision. */
async function primed(sessionId: string): Promise<void> {
  await runQualityCascade(input({ prompt: 'prime', sessionId }));
}

/** A minimal goal_clarity JudgeVerdict for the pure localContextSuppresses unit checks. */
function goalClarityJudgeVerdict(): JudgeVerdict {
  return {
    phase: 'new-task',
    dimension_scores: { goal_clarity: 0.1 },
    missing_piece: 'no concrete definition of "better"',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'goal_clarity',
    nudge: 'what one outcome should this nail first?',
  };
}

describe('F-L29 — invite-clarification on unstated assumptions (goal_clarity)', () => {
  it('fires a goal_clarity nudge that names the gap as a CONCRETE QUESTION', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('goal_clarity');
    // The nudge is phrased as a concrete question (the required shape), never a category.
    // NOTE: the banner soft-wraps the body at the 50-char panel width, so we assert on a
    // substring that survives the wrap rather than the full sentence.
    expect(res!.tip).toContain('?');
    expect(res!.tip).toContain('dashboard should show first');
  });

  it('the FIRED tip never emits a banned vague phrasing', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    const tip = res!.tip;
    expect(tip).not.toContain('add more detail');
    expect(tip).not.toContain('scope it down');
    expect(tip).not.toContain('decide what it shows');
  });

  // ── goal_clarity is a NON-TARGETED lever for local-context suppression ────────────────

  it('localContextSuppresses returns FALSE for goal_clarity under EVERY local fact', () => {
    const v = goalClarityJudgeVerdict();
    // plan-mode-on (the SUP-1 fact) does NOT touch a non-targeted lever.
    expect(localContextSuppresses('goal_clarity', v, { mode: 'plan' })).toBe(false);
    expect(localContextSuppresses('goal_clarity', v, { project: { planModeMandated: true } })).toBe(false);
    // testCmdDocumented (the SUP-2 fact) does NOT touch it either.
    expect(localContextSuppresses('goal_clarity', v, { project: { testCmdDocumented: true } })).toBe(false);
    // A positively-observed clean branch (the SUP-3 fact) does NOT touch it.
    expect(localContextSuppresses('goal_clarity', v, { git: { onBranch: true, dirty: false } })).toBe(false);
  });

  it('still FIRES with plan mode + clean branch + testCmdDocumented all set at once', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: {
          mode: 'plan',
          git: { onBranch: true, dirty: false },
          project: { testCmdDocumented: true, planModeMandated: true },
        },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('goal_clarity');
    expect(res!.tip).toContain('dashboard should show first');
  });

  // ── F-L25 angle: goal_clarity is an UNDEFINED-TASK lever → no affordance attaches ─────

  it('drops a model-scoped capability the judge recommends (undefined-task lever forces it off)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: { judgeUser?: string } = {};
    // effort-xhigh is an OPUS-scoped capability; with activeModel='opus' it IS available
    // and rendered into the judge input. But goal_clarity is an undefined-task lever, so
    // composeTip nulls the capability regardless — the tip carries NO affordance/cost tail.
    const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
    const activeModel: CapabilityModelFamily = 'opus';
    const res = await runQualityCascade(
      input({
        sessionId,
        // transcript empty so the launch-only effort-xhigh is NOT dropped pre-judge by the
        // §5.5.5a mid-session guard — isolating the §5.5.5c undefined-task drop instead.
        transcript: [],
        backend: backend(
          goalClarityVerdict({ capability_fit: { candidate_capability: 'effort-xhigh', confidence: 0.9 } }),
          capture,
        ),
        capabilities: [effortXhigh],
        activeModel,
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('goal_clarity');
    // The opus-scoped capability survived the model gate and reached the judge input...
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).toContain('--effort xhigh');
    // ...but goal_clarity forced it OFF, so the composed tip carries no trigger / cost tail.
    expect(res!.tip).not.toContain('--effort xhigh');
    expect(res!.tip).not.toContain('uses extra usage');
  });

  it('a model-scoped capability OUT of the active scope is filtered out of the judge input', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: { judgeUser?: string } = {};
    // effort-xhigh is model-scoped (opus/fable/sonnet5/mythos); active model 'codex' is out of scope → the §5.5.5b
    // model-gate re-filter drops it BEFORE the judge ever sees it.
    const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
    const activeModel: CapabilityModelFamily = 'codex';
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [],
        backend: backend(goalClarityVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel,
      }),
    );
    expect(res).not.toBeNull();
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).not.toContain('--effort xhigh');
    // No usable capability → the judge sees the "(none available on this build)" placeholder.
    expect(capture.judgeUser).toContain('none available on this build');
  });

  // ── policy / rubric encoding ──────────────────────────────────────────────────────────

  it('the rubric carries a goal_clarity dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'goal_clarity');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('outcome');
  });

  it('JUDGE_SYSTEM bans the vague phrasings and requires a CONCRETE QUESTION', () => {
    // §5.5.3 STEP 7 nudge-composition policy: the three banned phrasings + concrete-question rule.
    expect(JUDGE_SYSTEM).toContain('"add more detail"');
    expect(JUDGE_SYSTEM).toContain('"scope it down"');
    expect(JUDGE_SYSTEM).toContain('"decide what it shows"');
    expect(JUDGE_SYSTEM).toContain('CONCRETE QUESTION');
  });

  it('JUDGE_SYSTEM keeps goal_clarity nudges free of a how-to skill/capability (undefined task)', () => {
    // §5.5.5c STEP 4/7: goal_clarity (task not yet defined) must not carry a how-to affordance.
    expect(JUDGE_SYSTEM).toContain('goal_clarity');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('not yet defined');
  });

  // ── F-SILENCE: the Tier-0 reflex still swallows the obvious-fine majority ──────────────

  it('reflex suppresses an approval before the cascade ever reaches the judge', () => {
    expect(reflex('yes').suppress).toBe(true);
    expect(reflex('yes').reason).toBe('approval');
    // ...while a materially-vague fresh ask is NOT reflex-suppressed (it reaches the judge).
    expect(reflex('make the dashboard better').suppress).toBe(false);
  });
});
