/**
 * F-L01-complexity — A0 complexity-gating for plan-first (process_fit).
 *
 * USER STORY: a genuinely COMPLEX/multi-surface/migration/destructive unplanned build with
 * no plan should still get the plan-first nudge (process_fit FIRES). BUT a vague-but-BOUNDED
 * single-surface ask (one file/component, additive, no migration, no risk surface) must NOT
 * be nudged to "plan first" — a modern coding agent plans such a task implicitly, so the
 * nudge would be noise. This is the DEMOTE half of F-L01: raise the bar on low-complexity,
 * keep firing on high-complexity.
 *
 * v1 adversarial verdict was REVISE (precision_safe=false). The fix tightens the complexity
 * signal so it is read FROM THE PROMPT (multi-file/surface/migration/destructive vs
 * single-surface bounded), composes with the §5.5.5c "prefer process_fit on big/risky"
 * tie-break (this clause GATES it — process_fit must not fire on a bounded change in the
 * first place) and with SUP-1 plan-mode suppression, and uses a QUALITATIVE gate only (no
 * numeric floor in JUDGE_SYSTEM).
 *
 * This is a DETERMINISTIC CONTRACT test over the SHIPPING cascade (runQualityCascade) + the
 * frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a stub
 * returning the crafted verdict the real Sonnet judge emits for each case (FIRE on the
 * complex build, SILENT — interrupt:false/missing_piece:null — on the bounded single-surface
 * ask). It pins the firing/silence routing + the A0 policy encoding (the parts we own); the
 * live-matrix eval scores the judge's real verdict quality on these prompts.
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * A FIRE verdict whose primary lever is process_fit — the verdict the real Sonnet judge
 * emits for a genuinely COMPLEX/multi-surface unplanned build (HIGH-complexity → may fire).
 */
function complexBuildVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { process_fit: 0.15, scope_boundaries: 0.2, risk_awareness: 0.2 },
    missing_piece: 'no plan for a multi-file rewrite touching the payments surface',
    risk_level: 'high',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'process_fit',
    nudge: 'sketch the steps and the riskiest part before diving in — plan first',
    ...over,
  });
}

/**
 * The SILENT verdict for a vague-but-BOUNDED single-surface ask: under the A0 complexity
 * gate the judge must NOT raise plan-first on a one-surface additive change, so it returns
 * interrupt:false / missing_piece:null. The firing gate then SILENCEs.
 */
function boundedSingleSurfaceSilentVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { process_fit: 0.6, scope_boundaries: 0.6 },
    missing_piece: null,
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: false,
    confidence: 0.3,
    primary_lever: 'process_fit',
    nudge: null,
    ...over,
  });
}

/** A backend stub keyed by tier: '0.9' for Haiku (escalate), the crafted judge JSON for Sonnet. */
function backend(judge: string): LlmBackend {
  return {
    configured: true,
    async complete(opts: LlmCompleteOptions): Promise<string | null> {
      return opts.model === 'haiku' ? '0.9' : judge;
    },
  };
}

let sid = 0;
function nextSession(): string {
  sid += 1;
  return `fl01c-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'rewrite the billing module onto a new pricing engine',
    transcript: ['earlier prompt'],
    backend: backend(complexBuildVerdict()),
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

describe('F-L01-complexity — A0 complexity-gating for plan-first (process_fit)', () => {
  it('FIRES process_fit on a genuinely COMPLEX/multi-surface/migration unplanned build', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'rewrite the billing module onto a new pricing engine',
        backend: backend(complexBuildVerdict()),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('plan first');
    expect(res!.lever).toBe('process_fit');
  });

  it('LEANS SILENT on a vague-but-BOUNDED single-surface ask (the DEMOTE half — no plan-first nudge)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // "add a dark-mode toggle to the settings page" — single-surface, additive, no migration,
    // no risk surface. Under the A0 gate the judge returns interrupt:false / missing_piece:null,
    // so the firing gate SILENCEs (a modern agent plans this one-surface change itself).
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'add a dark-mode toggle to the settings page',
        backend: backend(boundedSingleSurfaceSilentVerdict()),
      }),
    );
    expect(res).toBeNull();
  });

  it('LOOK-ALIKE CONTROL: a bounded ask that ALSO touches a risk surface still FIRES (complexity present)', async () => {
    // A single-surface-LOOKING ask that touches auth IS complex by the A0 gate (risk surface),
    // so the judge fires process_fit — proving the gate keys on what the WORK touches, not on
    // surface-count alone. This is the control that the demote does NOT over-suppress.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'add login to the settings page',
        backend: backend(
          complexBuildVerdict({
            missing_piece: 'no plan or method named for an auth change',
            nudge: 'auth touches sessions, token storage, and protected routes — plan first',
          }),
        ),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });

  it('composes with SUP-1: a COMPLEX build still goes SILENT when the dev is already in plan mode', async () => {
    // The A0 gate raises the bar on LOW complexity; SUP-1 suppresses even a HIGH-complexity
    // fire when the dev is already planning. Both must hold — they do not contradict.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        backend: backend(complexBuildVerdict()),
        localContext: { mode: 'plan' },
      }),
    );
    expect(res).toBeNull();
  });

  it('JUDGE_SYSTEM encodes the A0 complexity gate (qualitative, no numeric floor)', () => {
    expect(JUDGE_SYSTEM).toContain('A0 COMPLEXITY GATE');
    // The complexity signal is defined from the prompt: multi-file/surface/migration/risk.
    const lower = JUDGE_SYSTEM.toLowerCase();
    expect(lower).toContain('single-surface');
    expect(lower).toContain('migration');
    // The DEMOTE half: lean silent on the bounded single-surface ask.
    expect(lower).toContain('lean silent');
    // The worked SILENT example (the suppressor) is present.
    expect(JUDGE_SYSTEM).toContain('dark-mode toggle');
    // QUALITATIVE only — no numeric complexity floor smuggled into the policy text.
    expect(JUDGE_SYSTEM).not.toMatch(/complexity\s*(?:>=|≥|>|of at least)\s*0?\.\d/i);
  });

  it('does NOT contradict §5.5.5c: the tie-break preferring process_fit on a big/risky change still stands', () => {
    // The A0 gate GATES the tie-break (process_fit must not fire on a bounded change) but the
    // §5.5.5c preference among competing levers on a genuinely big/risky change is unchanged.
    expect(JUDGE_SYSTEM).toContain('plan before diving in');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('gates the §5.5.5c tie-break');
  });

  it('the rubric carries a process_fit dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'process_fit');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('plan');
  });
});
