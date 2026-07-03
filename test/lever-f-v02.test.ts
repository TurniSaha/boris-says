/**
 * F-V02 — Manual-relay-loop nudge (hand-out the command + lock a regression test).
 *
 * USER STORY: I paste the SAME failing test/build output back to Claude turn after turn
 * (≥2 near-identical relays — I've become the manual courier of the runner result). The
 * coach fires ONCE: let Claude run the command itself and loop to green, then lock the
 * fixed bug in as a regression test. BUT it stays SILENT on a SINGLE failure, on
 * ADVANCING/DIFFERENT failures (healthy iteration), when a runnable command/test is
 * already named, and when the project documents the test command (SUP-2 testCmdDocumented).
 *
 * THE PRECISION WALL: the firing case (a failing test IS visible) sits directly on top of
 * the §5.5.4 debug-loop guard ("If ANY error/symptom/failing test is visible … do NOT
 * interrupt — never second-guess a normal debug loop"). F-V02 is a NARROW carve-out of
 * that guard for the repeated-IDENTICAL-paste pattern ONLY; advancing failures stay
 * continuation → SILENT, so the guard is preserved. The clause SETS phase=escalation (an
 * interrupt-eligible phase) rather than relying on continuation (which the firing gate
 * suppresses via INTERRUPT_ELIGIBLE_PHASES).
 *
 * This is a DETERMINISTIC CONTRACT test over the SHIPPING cascade (runQualityCascade) +
 * the frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a stub
 * returning the crafted verdict the real Sonnet judge emits for each case. It pins the
 * firing/silence routing + the policy encoding — the parts we own — while the live-matrix
 * eval (Phase 2) scores the judge's real verdict quality on the relay-vs-iteration call.
 *
 * NOTE on substring assertions: formatCoachBanner word-wraps the nudge to a 50-char panel,
 * so every asserted nudge substring is kept short enough to survive one wrapped line.
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import {
  PROMPT_COACH_SKILL,
  RUBRIC_DIMENSIONS,
  JUDGE_SYSTEM,
} from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * The FIRE verdict the judge emits for the manual-relay-loop pattern: phase=escalation
 * (the SET interrupt-eligible phase — NOT a continuation the gate would suppress),
 * primary_lever=verification_path, and a nudge that hands the loop to Claude AND locks a
 * regression test. Kept short to survive the 50-char panel word-wrap for substring checks.
 */
function relayLoopVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'escalation',
    dimension_scores: { verification_path: 0.1 },
    missing_piece: 'human is relaying the same failing test each turn; no command handed to Claude',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'verification_path',
    nudge: 'let Claude run the test and loop to green, then lock it as a regression test',
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
  return `fv02-${sid}`;
}

// Two near-identical pasted failures (the same test name + same assertion) across turns —
// the textual signal that the human has become the manual relay courier.
const FAIL_PASTE_1 = 'FAIL parseSemver › two-segment: expected "1.2.0" but got "1.2"';
const FAIL_PASTE_2 = 'still red — FAIL parseSemver › two-segment: expected "1.2.0" but got "1.2"';
// An ADVANCING failure (different assertion) — healthy iteration, NOT a relay loop.
const FAIL_ADVANCED = 'FAIL parseSemver › prerelease: expected "1.2.0-rc.1" but got null';

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: FAIL_PASTE_2,
    transcript: [FAIL_PASTE_1],
    backend: backend(relayLoopVerdict()),
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

describe('F-V02 — manual-relay-loop nudge (hand off the command + lock a regression test)', () => {
  it('FIRES on ≥2 near-identical pasted failures (escalation phase, verification_path lever)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: [FAIL_PASTE_1] }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('verification_path');
    // The composed nudge hands the loop to Claude AND names the regression-test lock.
    expect(res!.tip).toContain('loop to green');
    expect(res!.tip).toContain('regression test');
  });

  it('SILENT on a SINGLE failure (no prior identical paste → continuation → suppressed)', async () => {
    // One pasted failure is a normal debug turn: the judge classifies it continuation, and
    // INTERRUPT_ELIGIBLE_PHASES excludes continuation → the firing gate suppresses it.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: FAIL_PASTE_1,
        transcript: ['prime'], // no prior identical failing paste.
        backend: backend(relayLoopVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT on ADVANCING failures (different assertion turn-to-turn — healthy iteration)', async () => {
    // The output CHANGES (new assertion) → the debug-loop guard holds: classify
    // continuation, do NOT interrupt. The relay-loop carve-out requires NEAR-IDENTICAL output.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: FAIL_ADVANCED,
        transcript: [FAIL_PASTE_1],
        backend: backend(relayLoopVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT (look-alike control) when a runnable command/test is ALREADY named (mechanical handoff)', async () => {
    // "rerun `npm test parseSemver` until green" already hands Claude the loop → the
    // mechanical / EXPERTISE-PRE-EMPTION cases suppress; the judge returns interrupt:false.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'rerun npm test parseSemver until it goes green',
        transcript: [FAIL_PASTE_1],
        backend: backend(relayLoopVerdict({ interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT when the project documents the test command (SUP-2 testCmdDocumented)', async () => {
    // verification_path is a SUP-2 lever: a documented test command means the how-to-verify
    // already lives in CLAUDE.md → suppress even though the verdict fired.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [FAIL_PASTE_1],
        localContext: { project: { testCmdDocumented: true } },
      }),
    );
    expect(res).toBeNull();
  });

  it('still FIRES when testCmdDocumented is UNKNOWN (null never suppresses — fail-safe)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [FAIL_PASTE_1],
        localContext: { project: { testCmdDocumented: null } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('verification_path');
  });

  it('SILENT if a continuation verdict slips through (defense in depth: phase gate excludes continuation)', async () => {
    // Even if the judge mis-classifies the relay loop as a continuation, the firing gate
    // suppresses it — the carve-out MUST set escalation to fire (it cannot ride continuation).
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [FAIL_PASTE_1],
        backend: backend(relayLoopVerdict({ phase: 'continuation', confidence: 0.95 })),
      }),
    );
    expect(res).toBeNull();
  });
});

describe('F-V02 — JUDGE_SYSTEM encodes the manual-relay-loop policy', () => {
  it('encodes the MANUAL-RELAY-LOOP EXCEPTION naming the ≥2 near-identical paste signal', () => {
    expect(JUDGE_SYSTEM).toContain('MANUAL-RELAY-LOOP EXCEPTION');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('near-identical');
  });

  it('the clause SETS phase=escalation (an interrupt-eligible phase, not continuation)', () => {
    expect(JUDGE_SYSTEM).toContain('set phase=escalation');
    // escalation is interrupt-eligible; continuation/correction are not.
    expect(PROMPT_COACH_SKILL.interruptEligiblePhases.has('escalation')).toBe(true);
    expect(PROMPT_COACH_SKILL.interruptEligiblePhases.has('continuation')).toBe(false);
  });

  it('the clause names verification_path + the loop-to-green + regression-test lock', () => {
    expect(JUDGE_SYSTEM).toContain('primary_lever=verification_path');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('loop to green');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('regression test');
  });

  it('the clause does NOT weaken the debug-loop guard (advancing/single failures stay SILENT)', () => {
    // The carve-out explicitly excludes a single paste and advancing output.
    const lower = JUDGE_SYSTEM.toLowerCase();
    expect(lower).toContain('does not weaken the debug-loop guard');
    expect(lower).toContain('advances/changes');
    expect(JUDGE_SYSTEM).toContain('SINGLE pasted failure');
  });

  it('the clause defers to the mechanical / EXPERTISE-PRE-EMPTION suppressors (command already named)', () => {
    expect(JUDGE_SYSTEM).toContain('ALREADY names a runnable command/test');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('loop is already handed off');
    // The guard it carves from is still present verbatim.
    expect(JUDGE_SYSTEM).toContain('never second-guess a normal debug loop');
  });

  it('the rubric still carries verification_path (the lever F-V02 fires on)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'verification_path');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('verify');
  });
});
