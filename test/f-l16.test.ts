/**
 * F-L16 — One fresh-session nudge (doom-loop / unrelated-switch).
 *
 * USER STORY: I am stuck. I have re-asked the SAME unresolved thing in near-identical
 * wording three-plus times with no new information (a doom-loop), OR I have abruptly
 * switched to wholly UNRELATED work deep into a long session. The coach fires ONCE:
 * stop, `/clear` / start a fresh session, restate the goal + the sticking point and name
 * what to STOP trying (doom-loop), or start the unrelated work clean (switch). BUT it
 * stays SILENT on HEALTHY ITERATION (each turn adds a new error/finding/hypothesis), on a
 * single re-ask or a short ≤2-turn back-and-forth, on a related follow-on, and when the
 * dev already requested a compact/handoff (that is V04 — never double-fire).
 *
 * THE PRECISION WALL: the doom-loop arm is a NARROW carve-out of the §5.5.4 debug-loop
 * guard ("never second-guess a normal debug loop") — it fires ONLY on the circular
 * ≥3-re-ask-with-no-new-info pattern; any re-ask that ADDS NEW INFORMATION is healthy
 * iteration → continuation → SILENT. Both arms SET phase=escalation (an interrupt-eligible
 * phase); a continuation/correction verdict is excluded by INTERRUPT_ELIGIBLE_PHASES at
 * the firing gate (defense in depth). The lever is process_fit (start fresh), distinct
 * from F-V02's verification_path (hand off the command).
 *
 * This is a DETERMINISTIC CONTRACT test over the SHIPPING cascade (runQualityCascade) + the
 * frozen JUDGE_SYSTEM policy. It does NOT call a live model: the judge tier is a stub
 * returning the crafted verdict the real Sonnet judge emits per case. It pins the
 * firing/silence routing + the policy encoding — the parts we own — while the live-matrix
 * eval (Phase 2) scores the judge's real doom-loop-vs-iteration call.
 *
 * NOTE on substring assertions: formatCoachBanner word-wraps the nudge to a ~50-char panel,
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
 * The FIRE verdict the judge emits for the doom-loop pattern: phase=escalation (the SET
 * interrupt-eligible phase — NOT a continuation the gate would suppress),
 * primary_lever=process_fit, and a nudge that says to start fresh (`/clear`), restate the
 * goal + sticking point, and name what to STOP trying. Pure-prose nudge (no skill/capability
 * rides) so the backtick-token gate stays out of the way. Kept short for the 50-char panel.
 */
function doomLoopVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'escalation',
    dimension_scores: { process_fit: 0.1 },
    missing_piece: 'circling on the same goal with no new info; more re-prompting will not break it',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'process_fit',
    nudge: 'stop and /clear, then restate the goal plus the sticking point and what to STOP trying',
    ...over,
  });
}

/** The FIRE verdict for the unrelated-switch arm: same phase/lever, switch-flavored nudge. */
function switchVerdict(over: Record<string, unknown> = {}): string {
  return doomLoopVerdict({
    missing_piece: 'switching to unrelated work mid-session; stale context will dilute it',
    nudge: 'start this unrelated work in a fresh session so stale context does not bleed in',
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
  return `fl16-${sid}`;
}

// Three near-identical re-asks of the SAME goal with NO new info — the doom-loop signal.
const REASK_1 = 'fix the login bug';
const REASK_2 = 'still broken, fix the login bug';
const REASK_3 = 'it is STILL failing — why is the login bug not fixed?';
// A re-ask that ADDS NEW INFORMATION (a new error surfaced) — healthy iteration, NOT a loop.
const REASK_ADVANCED = 'now it throws TypeError: cannot read token of undefined in refreshSession';

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: REASK_3,
    transcript: [REASK_1, REASK_2],
    backend: backend(doomLoopVerdict()),
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

describe('F-L16 — fresh-session nudge (doom-loop / unrelated-switch)', () => {
  it('FIRES on the doom-loop: ≥3 near-identical re-asks with no new info (escalation, process_fit)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: [REASK_1, REASK_2] }));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
    // The composed nudge says to start fresh AND restate the sticking point.
    expect(res!.tip.toLowerCase()).toContain('/clear');
    expect(res!.tip.toLowerCase()).toContain('sticking point');
  });

  it('FIRES on the unrelated-switch arm (escalation, process_fit, start-fresh nudge)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // ≥4 prior prompts on the SAME prior task (the corrected policy floor), THEN a wholly
    // unrelated pivot — the precision-walled fire case.
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'forget all that — add a CSV export to the reports page',
        transcript: [
          'debug the auth token refresh',
          'still failing in refreshSession',
          'check the token expiry handling in auth/session.ts',
          'the refresh middleware still 401s on the second call',
        ],
        backend: backend(switchVerdict()),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
    expect(res!.tip.toLowerCase()).toContain('fresh session');
  });

  it('SILENT on a SHORT prior session (<4 same-task prompts) with an abrupt pivot — the precision floor', async () => {
    // The corrected UNRELATED-SWITCH policy requires ≥4 prior same-task prompts. A 2-turn
    // prior session that pivots is a normal short-session topic change → the judge returns a
    // continuation/interrupt:false verdict → SILENT. (Stub the realistic judge verdict.)
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'forget all that — add a CSV export to the reports page',
        transcript: ['debug the auth token refresh', 'still failing in refreshSession'],
        backend: backend(
          switchVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null }),
        ),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT on HEALTHY ITERATION: each re-ask adds new info (advancing → continuation → suppressed)', async () => {
    // The latest turn surfaces a NEW error → the §5.5.4 debug-loop guard holds: classify
    // continuation, do NOT interrupt. The doom-loop carve-out requires NO new info.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: REASK_ADVANCED,
        transcript: [REASK_1, REASK_2],
        backend: backend(doomLoopVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT on a SINGLE re-ask / short ≤2-turn back-and-forth (continuation → suppressed)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: REASK_2,
        transcript: [REASK_1], // only one prior turn on the topic — not a doom-loop yet.
        backend: backend(doomLoopVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT on a related follow-on (downstream/dependent task reusing the prior files = continuation)', async () => {
    // A switch-LOOKALIKE that is actually a continuation: it builds on the prior output.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'now add a test for the refreshSession fix we just made',
        transcript: ['debug the auth token refresh', 'fixed it in refreshSession'],
        backend: backend(switchVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT when the dev already requested a compact/handoff (defer to V04 — never double-fire)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        prompt: 'summarize where we are, then start the unrelated CSV export work',
        transcript: ['debug the auth token refresh', 'still failing in refreshSession'],
        backend: backend(switchVerdict({ phase: 'continuation', interrupt: false, missing_piece: null, nudge: null })),
      }),
    );
    expect(res).toBeNull();
  });

  it('SILENT if a continuation verdict slips through (defense in depth: phase gate excludes continuation)', async () => {
    // Even if the judge mis-classifies the doom-loop as a continuation, the firing gate
    // suppresses it — the carve-out MUST set escalation to fire (it cannot ride continuation).
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: [REASK_1, REASK_2],
        backend: backend(doomLoopVerdict({ phase: 'continuation', confidence: 0.95 })),
      }),
    );
    expect(res).toBeNull();
  });

  it('process_fit is NOT a local-context-suppression target for the doom-loop (plan-mode never silences it here)', async () => {
    // SUP-1 suppresses process_fit ONLY on mode==='plan' / planModeMandated. A doom-loop in
    // plan mode is a degenerate edge; the suppressor exists, so we assert the lever still
    // routes through and is genuinely process_fit (the real silence guard is healthy-iteration,
    // not plan-mode). We pass an UNKNOWN mode so the fail-safe keeps it firing.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: [REASK_1, REASK_2], localContext: { mode: null } }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });
});

describe('F-L16 — JUDGE_SYSTEM encodes the fresh-session policy (both arms)', () => {
  it('encodes the DOOM-LOOP EXCEPTION with the ≥3-re-ask / no-new-info signal', () => {
    expect(JUDGE_SYSTEM).toContain('DOOM-LOOP EXCEPTION');
    expect(JUDGE_SYSTEM).toContain('NO NEW INFORMATION');
  });

  it('the doom-loop arm SETS phase=escalation + primary_lever=process_fit + a fresh-session nudge', () => {
    expect(JUDGE_SYSTEM).toContain('set phase=escalation, primary_lever=process_fit');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('/clear');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('fresh session');
    // escalation is interrupt-eligible; continuation/correction are not.
    expect(PROMPT_COACH_SKILL.interruptEligiblePhases.has('escalation')).toBe(true);
    expect(PROMPT_COACH_SKILL.interruptEligiblePhases.has('continuation')).toBe(false);
  });

  it('the doom-loop arm does NOT weaken the debug-loop guard (advancing re-asks stay SILENT)', () => {
    const lower = JUDGE_SYSTEM.toLowerCase();
    expect(lower).toContain('does not weaken the debug-loop guard');
    expect(lower).toContain('healthy iteration');
    expect(JUDGE_SYSTEM).toContain('never second-guess a normal debug loop'); // guard still present verbatim.
  });

  it('encodes the UNRELATED-SWITCH arm: weaker than doom-loop, defers to V04 phase-handoff', () => {
    expect(JUDGE_SYSTEM).toContain('UNRELATED-SWITCH EXCEPTION');
    const lower = JUDGE_SYSTEM.toLowerCase();
    expect(lower).toContain('weaker than the doom-loop arm');
    expect(lower).toContain('do not double-fire');
    // unrelatedness judged by overlap, never by verb change (precision wall).
    expect(JUDGE_SYSTEM).toContain('NEVER by mere verb change');
  });

  it('strongest-signal-wins: relay-loop (verification_path) beats the doom-loop (process_fit) on a shared turn', () => {
    // The unified policy lets at most one arm fire; the clause pins the tie-break.
    expect(JUDGE_SYSTEM).toContain('the relay-loop lever (verification_path) wins');
  });

  it('the rubric carries process_fit (the lever F-L16 fires on)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'process_fit');
    expect(dim).toBeDefined();
  });
});
