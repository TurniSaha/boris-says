/**
 * F-L10 — Scope-boundaries nudge: MULTI-DELIVERABLE BUNDLING (split into separate asks).
 *
 * USER STORY: I type ONE prompt that bundles MULTIPLE distinct, independently-shippable
 * deliverables — "build the auth flow AND the billing dashboard AND migrate the DB". The
 * coach nudges me (in one sentence) to split them into separate asks so each gets its own
 * plan, scope, and review. BUT it stays SILENT on the look-alikes the precision wall
 * protects: a single deliverable broken into sub-steps / tightly-coupled facets
 * ("add the endpoint, its handler, and a test" is ONE deliverable), and a terse
 * multi-clause CONTINUATION that proceeds with established work (suppressed by the
 * eligible-phase gate even at high confidence).
 *
 * This is a DETERMINISTIC CONTRACT test over the SHIPPING cascade (runQualityCascade) +
 * the frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a stub
 * returning the crafted `scope_boundaries` verdict the real Sonnet judge emits for this
 * case. It pins the firing/silence routing + the policy encoding we own; the live-matrix
 * eval (Phase 2) scores the real judge's verdict quality on the bundle vs sub-step
 * distinction.
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

/** A FIRE verdict whose primary lever is scope_boundaries (multi-deliverable bundle). */
function bundleVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { scope_boundaries: 0.1 },
    missing_piece: 'three distinct deliverables bundled into one ask',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'scope_boundaries',
    nudge:
      'split this into separate asks — the auth flow, the billing dashboard, and the DB migration each deserve their own plan and review',
    ...over,
  });
}

/** A backend stub: '0.9' for the haiku prospector (escalate), the crafted JSON for sonnet. */
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
  return `fl10-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'build the auth flow AND the billing dashboard AND migrate the DB',
    transcript: ['earlier prompt'],
    backend: backend(bundleVerdict()),
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

describe('F-L10 — scope-boundaries nudge (multi-deliverable bundling)', () => {
  // ── FIRE: the genuine multi-deliverable bundle nudges a split ───────────────────────
  it('FIRES a split nudge when one prompt bundles multiple distinct deliverables', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.tip.toLowerCase()).toContain('split');
    expect(res!.lever).toBe('scope_boundaries');
  });

  // ── SILENT (look-alike #1): one deliverable broken into sub-steps → judge returns
  //    interrupt:false / missing_piece:null per the precision wall; the gate SILENCEs. ──
  it('stays SILENT on ONE deliverable broken into sub-steps (endpoint + handler + test)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'add the POST /sessions endpoint, its handler, and a test',
        backend: backend(
          bundleVerdict({ interrupt: false, missing_piece: null, nudge: null }),
        ),
      }),
    );
    expect(res).toBeNull();
  });

  // ── SILENT (look-alike #2): a terse multi-clause CONTINUATION — even at high
  //    confidence the eligible-phase gate suppresses it (continuation ∉ eligible). ──────
  it('stays SILENT on a terse multi-clause CONTINUATION that lists several things', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'now do the same for logout, password reset, and email verify',
        backend: backend(bundleVerdict({ phase: 'continuation', confidence: 0.95 })),
      }),
    );
    expect(res).toBeNull();
  });

  // ── CONTROL: the SAME bundle shape on an ELIGIBLE phase fires (proves the gate, not
  //    the prompt text, is what silenced the continuation above). ──────────────────────
  it('CONTROL: the same bundle shape FIRES on an eligible phase (escalation)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        backend: backend(bundleVerdict({ phase: 'escalation' })),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('scope_boundaries');
  });

  // ── POLICY ENCODING: the clause + suppressors live in the frozen JUDGE_SYSTEM ────────
  it('the rubric carries a scope_boundaries dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'scope_boundaries');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toMatch(/bounded|sprawl/);
  });

  it('JUDGE_SYSTEM encodes the multi-deliverable bundling clause with its suppressor', () => {
    expect(JUDGE_SYSTEM).toContain('MULTI-DELIVERABLE BUNDLING');
    // The clause must route to scope_boundaries and instruct a split.
    expect(JUDGE_SYSTEM).toContain('split them into separate asks');
    expect(JUDGE_SYSTEM).toContain('primary_lever = scope_boundaries');
    // The concrete suppressor: ONE deliverable with sub-steps / tightly-coupled facets.
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('tightly-coupled facets');
    expect(JUDGE_SYSTEM).toContain('is ONE deliverable');
    // Not mere length; and a continuation that lists several things is not a bundle.
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('not triggered by mere length');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('continuation, not a bundle');
  });
});
