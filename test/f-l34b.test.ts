/**
 * F-L34b DEMOTED (M1 relevance overhaul) — cascade-level pins.
 *
 * The prompt-path prune lever (SPEC §4 `next_prompt_budgeted`) was the live silence-filling
 * violation of the GOAL.md relevance invariant, and is DELETED from the cascade: no lever's
 * firing condition may reference "the cascade would otherwise stay silent". Its retrospective
 * value moved to the SessionEnd outcome recap (outcome-signals.ts), where the change-size
 * signal is agent-attributed by construction.
 *
 * Pinned here:
 *   - a SILENT verdict stays SILENT — the prune nudge text can never ride a silence.
 *   - a stale/legacy `l34bPendingPrune` flag smuggled into the input is IGNORED.
 *   - a real quality tip still wins/fires exactly as before.
 *   - the additive first-seen ping still rides alone (no lever, no prune text).
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

/** The retired lever's distinctive nudge text — must never appear in any cascade result. */
const RETIRED_PRUNE_TEXT = 'prune any dead code';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** A FIRE verdict (process_fit) — proves real coaching still works post-demote. */
function fireVerdict(): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { process_fit: 0.2 },
    missing_piece: 'no plan for the refactor',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'process_fit',
    nudge: 'sketch the data contract and key views before diving in',
  });
}

/** A SILENT verdict (interrupt:false) — the pre-run cascade stays quiet. */
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
  return `fl34b-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'now wire the export button to the new endpoint',
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

/**
 * Smuggle the RETIRED `l34bPendingPrune` flag into the input (an old caller / stale build
 * shape). The cascade must ignore it entirely — the property no longer exists on the
 * input contract, so this cast models a legacy payload, not a supported seam.
 */
function withLegacyPruneFlag(base: QualityCascadeInput): QualityCascadeInput {
  return { ...base, l34bPendingPrune: true } as QualityCascadeInput;
}

describe('F-L34b demoted — no silence-conditioned lever remains in the cascade', () => {
  it('a SILENT verdict stays SILENT (no prune nudge fills the silence)', async () => {
    const res = await runQualityCascade(input());
    expect(res).toBeNull();
  });

  it('a legacy l34bPendingPrune flag is IGNORED: silent verdict → null, never the prune text', async () => {
    const res = await runQualityCascade(withLegacyPruneFlag(input()));
    expect(res).toBeNull();
  });

  it('a real quality tip still fires (the demote removed the filler, not the coaching)', async () => {
    const res = await runQualityCascade(withLegacyPruneFlag(input({ backend: backend(fireVerdict()) })));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
    expect(res!.tip).toContain('sketch the data contract');
    expect(res!.tip).not.toContain(RETIRED_PRUNE_TEXT);
  });

  it('the additive first-run tour rides ALONE on a silent turn (no lever, no prune text)', async () => {
    const res = await runQualityCascade(
      withLegacyPruneFlag(input({ transcript: [], firstSeen: true })),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBeUndefined();
    expect(res!.tip).toContain('corner');
    expect(res!.tip).not.toContain(RETIRED_PRUNE_TEXT);
  });
});
