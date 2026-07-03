/**
 * F-L01 — Plan-before-coding nudge (process_fit), as SHIPPED today.
 *
 * USER STORY (CURRENT-BEHAVIOR PINNING ONLY): a `process_fit` verdict on a big/risky
 * unplanned change fires a plan-first nudge. BUT when the dev is ALREADY in plan mode
 * (`localContext.mode === 'plan'`) OR the project mandates plan mode
 * (`localContext.project.planModeMandated === true`), the cascade stays SILENT (SUP-1).
 * An UNKNOWN mode (null/undefined) NEVER suppresses (the absolute fail-safe).
 *
 * SCOPE GUARD: this test pins ONLY the EXISTING process_fit + SUP-1 plan-mode behavior
 * encoded in the shipping code (prompt-coach-skill.ts rubric `process_fit`,
 * judge-cascade.ts `localContextSuppresses` SUP-1). It deliberately does NOT assert the
 * A0 complexity-GATING brain edit — that is a SEPARATE later iteration not yet built.
 *
 * Like F-V01 this is a DETERMINISTIC CONTRACT test over the shipping cascade
 * (`runQualityCascade`) + the frozen rubric/policy. No live model: the judge tier is a
 * stub returning the crafted `process_fit` verdict the real Sonnet judge emits here. It
 * pins the firing/silence routing — the part we own — not the live judge's verdict quality.
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import { reflex } from '../src/brain/judge-reflex.js';
import { CAPABILITY_CATALOG, type Capability, type CapabilityModelFamily } from '../src/capability/catalog.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** A FIRE verdict whose primary lever is process_fit (what the judge emits here). */
function processFitVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { process_fit: 0.15 },
    missing_piece: 'no plan for a big risky refactor before diving in',
    risk_level: 'medium',
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
 * A backend stub keyed by tier: '0.9' for the Haiku prospector, the crafted judge JSON
 * for the Sonnet judge. The optional `capture` records the judge USER input so the F-L25
 * capability-catalog test can inspect exactly what the judge was shown.
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
  return `fl01-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'rewrite the whole billing module to a new pricing engine',
    transcript: ['earlier prompt'],
    backend: backend(processFitVerdict()),
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

describe('F-L01 — plan-before-coding nudge (process_fit), as shipped', () => {
  it('fires a plan-first nudge on a big/risky unplanned change (no plan-mode context)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('plan first');
    expect(res!.lever).toBe('process_fit');
  });

  it('stays SILENT when the dev is ALREADY in plan mode (SUP-1, mode === "plan")', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { mode: 'plan' },
      }),
    );
    expect(res).toBeNull();
  });

  it('stays SILENT when the project MANDATES plan mode (SUP-1, project.planModeMandated === true)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { project: { planModeMandated: true } },
      }),
    );
    expect(res).toBeNull();
  });

  it('still FIRES in normal mode (mode === "normal" is NOT plan mode → no suppression)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { mode: 'normal' },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });

  it('still FIRES when mode is UNKNOWN (null never suppresses — the absolute fail-safe)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { mode: null, project: { planModeMandated: null } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });

  it('the rubric carries a process_fit dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'process_fit');
    expect(dim).toBeDefined();
    // BEHAVIOR-NOTE: the shipped probe phrases the process_fit lever as "plan-first vs
    // dive-in", so it contains "plan" (not the literal word "process"). Assert reality.
    expect(dim!.probe.toLowerCase()).toContain('plan');
  });

  it('JUDGE_SYSTEM encodes the §5.5.5c tie-break preferring process_fit on a big/risky change', () => {
    // The judge is told: when process_fit, scope_boundaries, and risk_awareness are all
    // weak on a big/risky change, prefer process_fit (the gap is `plan before diving in`).
    expect(JUDGE_SYSTEM).toContain('process_fit');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('plan before diving in');
  });

  // ── F-L25: capability-catalog model-scoped resolution (judge-input visibility) ───────
  it('F-L25: a model-scoped capability is shown to the judge only when the active model matches', async () => {
    // effort-xhigh is scoped to {opus, fable, sonnet5, mythos} (modelFamilies) AND launch-only
    // (appliesAt: 'launch'). The launch-only mid-session drop fires whenever a transcript
    // exists, so to isolate the §5.5.5b MODEL gate we run with NO transcript (midSession =
    // false → launch survives). codex is OUT of the xhigh scope, so it is the drop case below.
    const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh');
    expect(effortXhigh).toBeDefined();
    expect(effortXhigh!.modelFamilies).toEqual(['opus', 'fable', 'sonnet5', 'mythos']);

    const capabilities: readonly Capability[] = [effortXhigh!];

    // Active model = opus → the opus-scoped capability is rendered into the judge input.
    const opusCapture: { judgeUser?: string } = {};
    await runQualityCascade(
      input({
        sessionId: nextSession(),
        transcript: [],
        capabilities,
        activeModel: 'opus' as CapabilityModelFamily,
        backend: backend(processFitVerdict(), opusCapture),
      }),
    );
    expect(opusCapture.judgeUser).toBeDefined();
    expect(opusCapture.judgeUser).toContain('--effort xhigh');

    // Active model = codex → the opus-scoped capability is filtered out (model-gate).
    const codexCapture: { judgeUser?: string } = {};
    await runQualityCascade(
      input({
        sessionId: nextSession(),
        transcript: [],
        capabilities,
        activeModel: 'codex' as CapabilityModelFamily,
        backend: backend(processFitVerdict(), codexCapture),
      }),
    );
    expect(codexCapture.judgeUser).toBeDefined();
    expect(codexCapture.judgeUser).not.toContain('--effort xhigh');
  });

  // ── F-SILENCE: Tier-0 reflex pure suppression (no model spent) ───────────────────────
  it('F-SILENCE: the Tier-0 reflex suppresses bare approvals before any model is spent', () => {
    expect(reflex('yes').suppress).toBe(true);
    expect(reflex('yes').reason).toBe('approval');
    // A genuine fresh task is NOT suppressed at Tier 0 → it escalates to the model.
    expect(reflex('rewrite the whole billing module to a new pricing engine').suppress).toBe(false);
  });

  it('F-SILENCE: a Tier-0-suppressed prompt never reaches the judge (cascade stays silent)', async () => {
    let judgeCalled = false;
    const watchBackend: LlmBackend = {
      configured: true,
      async complete(opts: LlmCompleteOptions): Promise<string | null> {
        if (opts.model === 'sonnet') judgeCalled = true;
        return opts.model === 'haiku' ? '0.9' : processFitVerdict();
      },
    };
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: ['prime'], prompt: 'yes', backend: watchBackend }),
    );
    expect(res).toBeNull();
    expect(judgeCalled).toBe(false);
  });
});
