/**
 * intent-gate.test.ts — M1 relevance overhaul: the cascade's PROMPT-INTENT GATE.
 *
 * GOAL.md relevance invariant: read-only / investigative prompts suppress CHANGE-DIRECTED
 * nudges (verify-your-change, risk-of-your-change, definition-of-done, plan-your-change).
 * The gate is LEVER-SCOPED and SUPPRESS-ONLY — pinned rules:
 *   - read_only + a change-directed lever's FIRE → SILENT (intent_suppressed).
 *   - read_only NEVER blocks a non-change-directed lever (goal_clarity still fires).
 *   - unknown intent NEVER suppresses anything (terse/imperative prompts fire as today).
 *   - the gate NEVER causes a fire (a silent verdict stays silent).
 *   - the additive first-seen ping still rides alone when the gate suppresses.
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** A FIRE verdict on `lever` (high confidence, interrupt, eligible phase). */
function fireVerdict(lever: string, nudge: string): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { [lever]: 0.2 },
    missing_piece: 'a concrete gap the judge saw',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.9,
    primary_lever: lever,
    nudge,
  });
}

/** A SILENT verdict (interrupt:false, no nudge). */
function silentVerdict(): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: {},
    missing_piece: null,
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: false,
    confidence: 0.1,
    primary_lever: 'goal_clarity',
    nudge: null,
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
  return `intent-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'check the deploy webhook config in the repo',
    transcript: ['earlier prompt'],
    backend: backend(silentVerdict()),
    skill: PROMPT_COACH_SKILL,
    state,
    catalog: emptyCatalog,
    capabilities: [],
    sessionId: nextSession(),
    now: () => 1_000_000,
    ...over,
  };
}

describe('intent gate — read_only suppresses change-directed levers', () => {
  it('read-only prompt + verification_path FIRE → silent (intent_suppressed observed)', async () => {
    const stages: string[] = [];
    const res = await runQualityCascade(
      input({
        backend: backend(fireVerdict('verification_path', 'add a runnable check before you ship')),
        observe: (stage) => stages.push(stage),
      }),
    );
    expect(res).toBeNull();
    expect(stages).toContain('intent_suppressed');
    expect(stages).not.toContain('dispatched');
  });

  it('read-only prompt naming auth + risk_awareness FIRE → silent (inspect ≠ change)', async () => {
    const res = await runQualityCascade(
      input({
        prompt: 'check the auth middleware config',
        backend: backend(fireVerdict('risk_awareness', 'branch first — auth changes need an undo')),
      }),
    );
    expect(res).toBeNull();
  });

  it.each(['acceptance_criteria', 'process_fit'])(
    'read-only prompt + %s FIRE → silent (all four change-directed levers gated)',
    async (lever) => {
      const res = await runQualityCascade(
        input({ backend: backend(fireVerdict(lever, 'plan the change before diving in')) }),
      );
      expect(res).toBeNull();
    },
  );
});

describe('intent gate — lever-scoped, not a blanket mute', () => {
  it('read-only prompt + goal_clarity FIRE → still fires (non-change-directed lever)', async () => {
    const res = await runQualityCascade(
      input({
        backend: backend(fireVerdict('goal_clarity', 'name which webhook config counts as the one')),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('goal_clarity');
    expect(res!.tip).toContain('name which webhook config');
  });
});

describe('intent gate — unknown intent is INERT (never suppresses)', () => {
  it('a change-directed prompt + risk_awareness FIRE → fires as today', async () => {
    const res = await runQualityCascade(
      input({
        prompt: 'now wire the export button to the new endpoint',
        backend: backend(fireVerdict('risk_awareness', 'branch first so the wiring has an undo')),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
  });
});

describe('intent gate — suppress-only (never causes a fire)', () => {
  it('read-only prompt + SILENT verdict → null (the gate adds nothing)', async () => {
    const res = await runQualityCascade(input({ backend: backend(silentVerdict()) }));
    expect(res).toBeNull();
  });

  it('read-only + verification_path FIRE + firstSeen → the bare additive tour rides alone (no lever)', async () => {
    const res = await runQualityCascade(
      input({
        transcript: [],
        firstSeen: true,
        backend: backend(fireVerdict('verification_path', 'add a runnable check before you ship')),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBeUndefined();
    expect(res!.tip).toContain('corner');
    expect(res!.tip).not.toContain('runnable check');
  });
});
