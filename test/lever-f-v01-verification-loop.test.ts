/**
 * F-V01 — Verification-loop nudge (the durable #1 lever; Boris + Karpathy).
 *
 * USER STORY: I type an implement/fix prompt that names no test or check, and none is
 * visible in the recent transcript. The coach nudges me — in ONE sentence — to give
 * Claude a way to verify the change (a test, a check). BUT if my project already
 * documents the test command (CLAUDE.md / testCmdDocumented), the coach stays SILENT —
 * the how-to-verify already lives in the repo and a nudge would be noise.
 *
 * This is a DETERMINISTIC CONTRACT test over the SHIPPING cascade (runQualityCascade) +
 * the frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a
 * stub returning a crafted `verification_path` verdict (what the real Sonnet judge emits
 * for this case). It pins the firing/silence routing + the policy encoding — the parts we
 * own — while the live-matrix eval (Phase 2) scores the judge's real verdict quality.
 */
import { describe, it, expect } from 'vitest';
import { runQualityCascade, type MergedSkillCatalog } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import type { QualityCascadeInput } from '../src/brain/judge-cascade.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** A FIRE verdict whose primary lever is verification_path (what the judge emits here). */
function verificationVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { verification_path: 0.1 },
    missing_piece: 'no test or check named for the new parser',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'verification_path',
    nudge: 'give Claude a way to verify this — name the test or check it should pass',
    ...over,
  });
}

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
  return `fv01-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'implement the new semver parser',
    transcript: ['earlier prompt'],
    backend: backend(verificationVerdict()),
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

describe('F-V01 — verification-loop nudge', () => {
  it('fires a one-sentence verify nudge when no test/check is named and none is documented', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('give Claude a way to verify');
    expect(res!.lever).toBe('verification_path');
  });

  it('stays SILENT when the project documents the test command (testCmdDocumented)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { project: { testCmdDocumented: true } },
      }),
    );
    expect(res).toBeNull();
  });

  it('still fires when testCmdDocumented is UNKNOWN (null never suppresses — fail-safe)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { project: { testCmdDocumented: null } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('verification_path');
  });

  it('the rubric carries a verification_path dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'verification_path');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('verify');
  });

  it('JUDGE_SYSTEM encodes the verification-clause policy (escalation/new-task low on verification_path)', () => {
    // §5.5.3: the judge must append a verification safety clause on new-task/escalation
    // scored low on verification_path — the doc-grounded #1 durable lever behavior.
    expect(JUDGE_SYSTEM).toContain('verification_path');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('characterization test');
  });
});
