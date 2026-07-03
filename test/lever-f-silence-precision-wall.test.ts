/**
 * F-SILENCE — THE PRECISION WALL (the survival condition).
 *
 * USER STORY: the coach stays SILENT on the cases that, if nudged, would get it disabled —
 * terse-expert corrections, in-flight continuations, single-token approvals, trivial fixes,
 * named-method prompts (git bisect / profiling / failing-test-first), and mechanical
 * self-verifying prompts (bump X to a pinned version and rerun the test). Two independent
 * mechanisms enforce this:
 *   1. TIER-0 REFLEX (pure, NO model call): suppresses trivial/approval/continuation TEXT
 *      shapes before a token is spent (judge-reflex.ts).
 *   2. THE FIRING GATE: even at high confidence, a continuation/correction-phase verdict is
 *      suppressed because INTERRUPT_ELIGIBLE_PHASES excludes those phases
 *      (judge-cascade.ts:316 + prompt-coach-skill.ts INTERRUPT_ELIGIBLE_PHASES).
 *   3. THE POLICY ENCODING: the EXPERTISE/PRE-EMPTION + named-method + mechanical clauses
 *      live in JUDGE_SYSTEM (the judge is INSTRUCTED to return interrupt:false on them).
 *
 * This is a DETERMINISTIC CONTRACT / PINNING test over the SHIPPING reflex() + cascade +
 * the frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a stub
 * returning a crafted verdict (what the real Sonnet judge emits for these cases). It pins
 * the silence routing we own — the live-matrix eval (Phase 2) scores the judge's real
 * verdict quality on the named-method / mechanical / terse-expert prompts.
 *
 * F-L25 sub-check: the model-scoped capability gate — a model-scoped capability
 * (effort-xhigh; modelFamilies opus/fable/sonnet5/mythos) is rendered into the judge input
 * when the active model is opus and is
 * GONE when the active model is codex (judge-cascade.ts model-gate filter + catalog).
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { reflex } from '../src/brain/judge-reflex.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import { CAPABILITY_CATALOG, type CapabilityModelFamily } from '../src/capability/catalog.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * A HIGH-CONFIDENCE, COMPLETE verdict (interrupt:true, confidence 0.85, non-null
 * missing_piece + nudge). The `phase` is overridable so a test can craft the precise
 * continuation/correction verdict the firing gate must suppress.
 */
function fireVerdict(over: Record<string, unknown> = {}): string {
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
    ...over,
  });
}

/**
 * A backend stub: '0.9' for the haiku prospector (escalate), the crafted judge JSON for
 * sonnet. An optional capture object records the judge USER input (for the F-L25 gate).
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
  return `fl05-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'implement the new semver parser',
    transcript: ['earlier prompt'],
    backend: backend(fireVerdict()),
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

describe('F-SILENCE — TIER 0 reflex (pure, NO model call)', () => {
  it('suppresses a single-token approval ("yes") with reason approval', () => {
    const v = reflex('yes');
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe('approval');
  });

  it('suppresses an in-flight continuation ("go on") with reason trivial-continuation', () => {
    const v = reflex('go on');
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe('trivial-continuation');
  });

  it('suppresses approvals/continuations case-insensitively and with trailing punctuation', () => {
    expect(reflex('YES!').suppress).toBe(true);
    expect(reflex('  ok.  ').suppress).toBe(true);
    expect(reflex('continue').suppress).toBe(true);
    expect(reflex('lgtm').reason).toBe('approval');
  });

  it('suppresses a trivial in-context fix (short, single-clause, trivial-INTENT verb)', () => {
    const v = reflex('rename this variable to userId');
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe('trivial-fix');
  });

  it('suppresses a short "fix the typo" follow-up via the trivial-fix marker', () => {
    const v = reflex('fix the typo in the header');
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe('trivial-fix');
  });

  it('does NOT suppress a terse-expert prompt that is neither approval nor trivial-INTENT', () => {
    // A short prompt that is not a recognized continuation is a terse expert follow-up —
    // Tier 0 PROCEEDS (lets Haiku/Sonnet judge with the transcript). NO model call here,
    // but the reflex itself does not swallow it.
    const v = reflex('use a trie for the prefix lookup');
    expect(v.suppress).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('does NOT suppress a risk-token trivial-LOOKING fix (escalates instead — fail-safe)', () => {
    // §5.5.5 risk-token guard: even a short "rename ..." escalates when a risk token
    // (migration/auth/drop/…) is present, so a dangerous "trivial" prompt still gets judged.
    const v = reflex('rename the users table in the migration');
    expect(v.suppress).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('does NOT suppress a multi-clause prompt even when it opens with a trivial verb', () => {
    // §5.5.5 single-clause guard: "and"/"then"/"," means it is not a single short clause.
    const v = reflex('rename the User model and migrate all 40 call sites');
    expect(v.suppress).toBe(false);
  });
});

describe('F-SILENCE — firing gate suppresses ineligible phases at HIGH confidence', () => {
  it('SILENT on a continuation verdict even at confidence 0.85 + interrupt:true', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // The judge (hypothetically) returned a high-confidence interrupt — but the phase is
    // continuation, which is NOT in INTERRUPT_ELIGIBLE_PHASES, so the gate suppresses it.
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'now do the same for the logout flow',
        backend: backend(fireVerdict({ phase: 'continuation', confidence: 0.95 })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT on a correction verdict even at confidence 0.85 + interrupt:true', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'no, use the second helper not the first',
        backend: backend(fireVerdict({ phase: 'correction', confidence: 0.9 })),
      }),
    );
    expect(res).toBeNull();
  });

  it('FIRES on the same shape when the phase IS eligible (new-task) — control', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        backend: backend(fireVerdict({ phase: 'new-task' })),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });

  it('the eligible-phase set excludes continuation AND correction (the precision lever)', () => {
    const phases = PROMPT_COACH_SKILL.interruptEligiblePhases;
    expect(phases.has('continuation')).toBe(false);
    expect(phases.has('correction')).toBe(false);
    expect(phases.has('new-task')).toBe(true);
    expect(phases.has('escalation')).toBe(true);
    expect(phases.has('ambiguous')).toBe(true);
  });
});

describe('F-SILENCE — mechanical self-verifying verdict is suppressed (interrupt:false)', () => {
  it('SILENT when the judge returns interrupt:false / missing_piece:null (the mechanical case)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // "bump lodash to 4.17.21 and rerun the failing test" — JUDGE_SYSTEM instructs the
    // judge to return interrupt:false, missing_piece:null. The firing gate then SILENCEs.
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'bump lodash to 4.17.21 and rerun the failing test',
        backend: backend(
          fireVerdict({ phase: 'new-task', interrupt: false, missing_piece: null, nudge: null }),
        ),
      }),
    );
    expect(res).toBeNull();
  });
});

describe('F-SILENCE — JUDGE_SYSTEM encodes the silence policy (EXPERTISE/named-method/mechanical)', () => {
  it('encodes the EXPERTISE / PRE-EMPTION check (do not pivot to an unstated dimension)', () => {
    expect(JUDGE_SYSTEM).toContain('EXPERTISE / PRE-EMPTION CHECK');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('marginally better');
  });

  it('encodes the named-method clause (git bisect / profiling / failing test first)', () => {
    expect(JUDGE_SYSTEM).toContain('git bisect');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('profiling');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('failing test first');
  });

  it('encodes the mechanical self-verifying clause (pinned version + rerun → interrupt:false)', () => {
    expect(JUDGE_SYSTEM).toContain('mechanical, self-verifying');
    expect(JUDGE_SYSTEM).toContain('bump lodash to 4.17.21');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('interrupt:false');
  });

  it('encodes the terse-anchored-pick continuation clause (no nudging a loose modifier)', () => {
    expect(JUDGE_SYSTEM).toContain('the second one, but lighter');
  });

  it('the eligible-phase restriction is stated in JUDGE_SYSTEM prose too', () => {
    expect(JUDGE_SYSTEM).toContain('continuation or correction anchored in recent context is presumptively FINE');
  });
});

describe('F-L25 — model-scoped capability gate (model-scoped effort-xhigh)', () => {
  const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;

  it('a model-scoped capability IS rendered into the judge input when activeModel is opus', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: { judgeUser?: string } = {};
    const opus: CapabilityModelFamily = 'opus';
    // NOTE: effort-xhigh is appliesAt:'launch', so it survives only at fresh launch
    // (transcript:[]); mid-session it would be dropped by the launch-only gate. Use a
    // fresh-launch input so the model-gate (not the launch gate) is what we isolate.
    await runQualityCascade(
      input({
        sessionId,
        transcript: [],
        backend: backend(fireVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel: opus,
      }),
    );
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).toContain('--effort xhigh');
  });

  it('the SAME model-scoped capability is GONE from the judge input when activeModel is codex', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: { judgeUser?: string } = {};
    const codex: CapabilityModelFamily = 'codex';
    await runQualityCascade(
      input({
        sessionId,
        transcript: [],
        backend: backend(fireVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel: codex,
      }),
    );
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).not.toContain('--effort xhigh');
  });

  it('effort-xhigh declares modelFamilies:[opus,fable,sonnet5,mythos] + appliesAt:launch (the catalog facts the gate reads)', () => {
    expect(effortXhigh.modelFamilies).toEqual(['opus', 'fable', 'sonnet5', 'mythos']);
    expect(effortXhigh.appliesAt).toBe('launch');
  });
});

describe('F-SILENCE — the rubric carries the precision dimensions', () => {
  it('verification_path and effort_level_fit dimensions exist in the skill', () => {
    expect(RUBRIC_DIMENSIONS.find((d) => d.id === 'verification_path')).toBeDefined();
    expect(RUBRIC_DIMENSIONS.find((d) => d.id === 'effort_level_fit')).toBeDefined();
  });
});
