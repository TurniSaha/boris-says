/**
 * F-L23 — Right-primitive (hook vs skill) on a RE-PASTED intra-session workflow.
 *
 * USER STORY: I paste the SAME multi-step workflow (scaffold → seed → snapshot) into a
 * second prompt this session — I'm hand-relaying a fixed recipe instead of giving it a
 * reusable primitive. The coach fires ONCE: make it a SKILL (loads on demand) if it runs
 * sometimes, or a HOOK if it must run every time. BUT it stays SILENT on the look-alikes
 * the precision wall protects: a FIRST single paste (one occurrence — you cannot recommend
 * a primitive yet), a single deliverable broken into sub-steps (MULTI-DELIVERABLE
 * suppressor), and a workflow the dev has ALREADY wrapped in a skill/command/hook.
 *
 * FEASIBILITY (the load-bearing finding): re-paste is detectable from the typed
 * transcript ALONE — the cascade already feeds the judge the PRIOR typed prompts
 * (recentTranscriptWindow, oldest-first, current excluded) plus the latest prompt verbatim
 * (buildJudgeUser). A re-paste is "the latest prompt's recipe also appears in a prior
 * transcript turn" — a within-window comparison the judge can make with NO session-local
 * state. This is the SAME mechanism the shipping F-V02 manual-relay-loop clause already
 * uses for repeated-near-identical pastes. CROSS-session repetition is a different path
 * (the habit-miner) and is out of scope for this clause.
 *
 * This is a DETERMINISTIC CONTRACT test over the SHIPPING cascade (runQualityCascade) +
 * the frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a stub
 * returning the crafted verdict the real Sonnet judge emits for each case. It pins the
 * firing/silence routing + the policy encoding we own; the live-matrix eval scores the
 * real judge's verdict quality on the re-paste vs continuation call.
 *
 * NOTE on substring assertions: formatCoachBanner word-wraps the nudge to a 50-char panel,
 * so every asserted nudge substring is kept short enough to survive one wrapped line.
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  localContextSuppresses,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import type { JudgeVerdict } from '../src/brain/parse-verdict.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** The novel primary lever this clause rides on (NOT a rubric scoring dimension). */
const PRIMITIVE_FIT = 'primitive_fit';

/**
 * The FIRE verdict the judge emits for a re-pasted multi-step workflow: phase=escalation
 * (the SET interrupt-eligible phase — a re-paste is NOT a continuation the gate would
 * suppress), primary_lever=primitive_fit, and a nudge naming skill (sometimes) vs hook
 * (every time). Kept short to survive the 50-char panel word-wrap for substring checks.
 */
function primitiveVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'escalation',
    dimension_scores: { process_fit: 0.2 },
    missing_piece: 'same multi-step workflow re-pasted; no reusable skill or hook for it',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: PRIMITIVE_FIT,
    nudge: 'make this a skill (loads on demand), or a hook if it must run every time',
    ...over,
  });
}

/** A backend stub: '0.9' for the haiku prospector (escalate), crafted JSON for sonnet. */
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
  return `fl23-${sid}`;
}

// The fixed multi-step recipe the dev keeps hand-relaying within this session.
const WORKFLOW =
  'scaffold the Recipe model, then seed fixtures, then snapshot the schema';
// A near-identical re-paste of the same recipe (the within-transcript signal).
const WORKFLOW_REPASTE =
  'again: scaffold the Recipe model, then seed fixtures, then snapshot the schema';

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: WORKFLOW_REPASTE,
    transcript: [WORKFLOW],
    backend: backend(primitiveVerdict()),
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
  await runQualityCascade(input({ prompt: 'prime', sessionId, transcript: [] }));
}

describe('F-L23 — right-primitive on a re-pasted intra-session workflow', () => {
  it('FIRES when the SAME multi-step workflow is re-pasted within this session', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: [WORKFLOW] }));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe(PRIMITIVE_FIT);
    // The composed nudge names the right-primitive choice: skill (sometimes) vs hook (always).
    expect(res!.tip.toLowerCase()).toContain('skill');
    expect(res!.tip.toLowerCase()).toContain('hook');
  });

  it('SILENT on a FIRST single paste (one occurrence → new-task → no primitive yet)', async () => {
    // The first time the workflow appears there is no prior identical paste to compare to;
    // the judge classifies it new-task and does NOT interrupt (you cannot recommend a
    // primitive off a single occurrence).
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: WORKFLOW,
        transcript: ['prime'], // no prior identical workflow paste.
        backend: backend(primitiveVerdict({ phase: 'new-task', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT on ONE deliverable broken into sub-steps (MULTI-DELIVERABLE suppressor)', async () => {
    // "add the endpoint, its handler, and a test" is ONE deliverable, not a re-pasted
    // recipe — the judge returns interrupt:false per the precision wall.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'add the POST /sessions endpoint, its handler, and a test',
        transcript: ['add the POST /sessions endpoint, its handler, and a test'],
        backend: backend(primitiveVerdict({ interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT when the workflow is ALREADY wrapped (prompt names an existing skill/command)', async () => {
    // If the dev already invokes the primitive ("/scaffold-seed-snapshot"), it exists —
    // the judge returns interrupt:false (suppressor (c)).
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'run /scaffold-seed-snapshot for the Recipe model',
        transcript: ['run /scaffold-seed-snapshot for the User model'],
        backend: backend(primitiveVerdict({ interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT if a continuation verdict slips through (defense in depth: phase gate)', async () => {
    // Even if the judge mis-classifies the re-paste as a continuation, the firing gate
    // suppresses it — the clause MUST set escalation to fire (it cannot ride continuation).
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [WORKFLOW],
        backend: backend(primitiveVerdict({ phase: 'continuation', confidence: 0.95 })),
      }),
    );
    expect(res).toBeNull();
  });

  it('CONTROL: the same re-paste shape FIRES on the escalation phase (the gate, not the text, gates)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: [WORKFLOW], backend: backend(primitiveVerdict({ phase: 'escalation' })) }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe(PRIMITIVE_FIT);
  });

  it('primitive_fit is NOT silenced by any local-context suppressor (plan-mode/test-cmd/clean-branch)', () => {
    // The re-paste gap is not covered by plan-mode, a documented test command, or a clean
    // branch — so the novel lever must pass every positive local fact untouched.
    const verdict = { primary_lever: PRIMITIVE_FIT } as unknown as JudgeVerdict;
    expect(localContextSuppresses(PRIMITIVE_FIT, verdict, { mode: 'plan', project: { planModeMandated: true } })).toBe(false);
    expect(localContextSuppresses(PRIMITIVE_FIT, verdict, { project: { testCmdDocumented: true } })).toBe(false);
    expect(localContextSuppresses(PRIMITIVE_FIT, verdict, { git: { onBranch: true, dirty: false } })).toBe(false);
  });

  it('still FIRES under positive local facts (none of them covers the re-paste gap)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [WORKFLOW],
        localContext: { mode: 'plan', project: { testCmdDocumented: true, planModeMandated: true }, git: { onBranch: true, dirty: false } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe(PRIMITIVE_FIT);
  });
});

describe('F-L23 — JUDGE_SYSTEM encodes the right-primitive (re-pasted workflow) policy', () => {
  it('encodes the RIGHT-PRIMITIVE clause naming the re-paste signal + the primitive_fit lever', () => {
    expect(JUDGE_SYSTEM).toContain('RIGHT-PRIMITIVE (RE-PASTED WORKFLOW)');
    expect(JUDGE_SYSTEM).toContain('primary_lever=primitive_fit');
  });

  it('the clause SETS phase=escalation (an interrupt-eligible phase, not continuation)', () => {
    expect(JUDGE_SYSTEM).toContain('set phase=escalation');
    expect(PROMPT_COACH_SKILL.interruptEligiblePhases.has('escalation')).toBe(true);
    expect(PROMPT_COACH_SKILL.interruptEligiblePhases.has('continuation')).toBe(false);
  });

  it('the nudge names BOTH primitives: skill (loads on demand) vs hook (every time)', () => {
    const lower = JUDGE_SYSTEM.toLowerCase();
    expect(lower).toContain('make this a skill');
    expect(lower).toContain('a hook if it must run every time');
  });

  it('the precision wall requires a within-transcript re-paste (single paste is SILENT)', () => {
    expect(JUDGE_SYSTEM).toContain('appears in the LATEST prompt AND a prior transcript turn');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('single paste is new-task/continuation and is silent');
  });

  it('the clause defers CROSS-SESSION repetition to the habit-miner (not this clause)', () => {
    expect(JUDGE_SYSTEM).toContain('CROSS-SESSION repetition');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('habit-miner');
  });

  it('the clause reuses the MULTI-DELIVERABLE suppressor (sub-steps of one ask are SILENT)', () => {
    expect(JUDGE_SYSTEM).toContain('MULTI-DELIVERABLE suppressors apply');
  });
});
