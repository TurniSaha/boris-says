/**
 * F-L08 — Paste the raw error/log/artifact (context_sufficiency). RECOMMENDATION: BLOCKED.
 *
 * THE LEVER (research L08-paste-raw-error): when a dev REFERENCES an observed ephemeral
 * output — "the error I got", "it crashed with...", "tests are red", "the build fails" —
 * but does NOT paste the raw artifact, an expert would nudge "show, don't describe: paste
 * the full stack trace / log / JSON / screenshot". Maps to context_sufficiency. Distinct
 * from F-L06 (a FETCHABLE referent — ticket/file/URL — the agent can open ITSELF).
 *
 * WHY BLOCKED (the honest v2 verdict, after the v1 REVISE `detectable_from_typed=false`):
 *  - The RAW trigger (error-reference keywords + no pasted code/log block) IS typed-
 *    detectable. That part of the reviewer's doubt is answerable: keyword + block-absence
 *    are pure text-surface signals.
 *  - BUT the precision-safe SUBSET — an artifact the agent genuinely CANNOT re-derive
 *    (a one-off prod log, a UI screenshot, the JSON an external API returned, a crash seen
 *    outside the agent's reach) — is NOT separable from the dominant population that
 *    matches the same keywords: the NORMAL DEBUG LOOP ("tests are red, fix it", "it errors
 *    when I save"), where the agent reproduces the failure by RE-RUNNING the test/build.
 *    "it crashed with a TypeError" is ambiguous between a reproducible local crash (agent
 *    reruns → no paste needed) and a non-reproducible incident (must paste). The typed text
 *    does NOT carry that discriminator.
 *  - JUDGE_SYSTEM already SILENCES that population on purpose (the §5.5.4 debug-loop guard,
 *    prompt-coach-skill.ts: "If ANY error/symptom/failing test is visible, classify
 *    continuation or correction and do NOT interrupt — never second-guess a normal debug
 *    loop"). Any F-L08 firing clause broad enough to catch the real artifact case ALSO
 *    re-fires this currently-correctly-silenced debug loop → it ERODES a suppressor. Per
 *    the precision wall, a clause that fires on a currently-silenced case is WORSE than no
 *    clause. So: NO firing clause is added.
 *
 * WHAT THIS TEST IS: a PRECISION-WALL PINNING / regression guard. It proves that the
 * F-L08 target case stays correctly SILENT under the SHIPPING policy today, so a future
 * careless "fire on referenced-but-not-pasted error" clause that re-fires the debug loop
 * would break a test instead of silently regressing precision. Deterministic contract test
 * over runQualityCascade + the frozen JUDGE_SYSTEM (judge tier stubbed; no live model) —
 * same idiom as test/lever-f-v01-verification-loop.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { runQualityCascade, type MergedSkillCatalog } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import type { QualityCascadeInput } from '../src/brain/judge-cascade.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * The verdict the real Sonnet judge emits for a prose-error reference under the §5.5.4
 * debug-loop guard: a NAMED symptom is visible, so the judge classifies it
 * continuation/correction and returns interrupt:false / missing_piece:null / nudge:null.
 * The firing gate then SILENCEs. (Phase continuation is also NOT interrupt-eligible — a
 * second, independent reason this never fires.)
 */
function debugGuardSilentVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'continuation',
    dimension_scores: { context_sufficiency: 0.6 },
    missing_piece: null,
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: false,
    confidence: 0.2,
    primary_lever: 'context_sufficiency',
    nudge: null,
    ...over,
  });
}

/**
 * A HYPOTHETICAL fire verdict on context_sufficiency for the prose-error case — the shape a
 * (rejected) F-L08 firing clause WOULD have produced. We use it to prove the DANGER: IF the
 * judge fired this, the gate would surface it. That is exactly the debug-loop case §5.5.4
 * silences — demonstrating why no such clause is encoded.
 */
function hypotheticalFireVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { context_sufficiency: 0.1 },
    missing_piece: 'error described in prose, not pasted',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'context_sufficiency',
    nudge: 'paste the full error verbatim and just say fix it',
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
  return `fl08-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'the build fails, fix it',
    transcript: ['earlier prompt'],
    backend: backend(debugGuardSilentVerdict()),
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

describe('F-L08 — paste-raw-error (BLOCKED: precision-wall pinning, no firing clause)', () => {
  // SILENT — the F-L08 target case stays correctly silent under the §5.5.4 debug-loop guard.
  it('stays SILENT on a prose error reference ("the build fails, fix it") — debug-loop guard', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: ['prime'], prompt: 'the build fails, fix it' }),
    );
    expect(res).toBeNull();
  });

  it('stays SILENT on "it crashed with a TypeError when I save" (named symptom, not pasted)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'it crashed with a TypeError when I save, fix the root cause',
      }),
    );
    expect(res).toBeNull();
  });

  // LOOK-ALIKE CONTROL — the F-L08 SUPPRESSOR: the output IS pasted (a multi-line stack).
  // The judge sees a visible failing artifact → §5.5.4 keeps it a debug loop → SILENT.
  it('stays SILENT when the raw stack trace IS pasted (the suppressor — output is present)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const pastedStack = [
      'fix this:',
      'Traceback (most recent call last):',
      '  File "app.py", line 42, in handler',
      '    return record["id"]',
      'KeyError: \'id\'',
    ].join('\n');
    const res = await runQualityCascade(
      input({ sessionId, transcript: ['prime'], prompt: pastedStack }),
    );
    expect(res).toBeNull();
  });

  // THE DANGER, made explicit: IF a firing clause produced a context_sufficiency interrupt
  // for the prose-error case, the gate WOULD surface it — re-firing the very debug loop
  // §5.5.4 silences. This pins WHY no such clause is added (it would erode the suppressor).
  it('a HYPOTHETICAL F-L08 fire verdict WOULD surface (proving such a clause erodes the debug-loop suppressor)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'the build fails, fix it',
        backend: backend(hypotheticalFireVerdict()),
      }),
    );
    // It fires — and "the build fails, fix it" is a normal debug loop. That collision is
    // exactly why F-L08 is BLOCKED: the typed text cannot separate this from a non-
    // reproducible artifact case, so any firing clause re-fires the silenced majority.
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('context_sufficiency');
  });

  // ENCODING CHECKS — the EXISTING coverage that makes a new F-L08 clause unnecessary AND
  // unsafe. The debug-loop guard (§5.5.4) and the context_sufficiency lever already route
  // this correctly to silence.
  it('JUDGE_SYSTEM already encodes the §5.5.4 debug-loop guard (the load-bearing suppressor)', () => {
    expect(JUDGE_SYSTEM).toContain('never second-guess a normal debug loop');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('failing test');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('symptom');
  });

  it('the context_sufficiency lever exists (the home a future F-L08 would have mapped to)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'context_sufficiency');
    expect(dim).toBeDefined();
  });

  it('JUDGE_SYSTEM contains NO paste-the-error firing instruction (no clause was added)', () => {
    const sys = JUDGE_SYSTEM.toLowerCase();
    expect(sys).not.toContain('paste the full error');
    expect(sys).not.toContain('paste the raw');
    expect(sys).not.toContain('show, don\'t describe');
  });
});
