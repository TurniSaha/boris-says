/**
 * F-L06 — Front-load context (DEMOTE the giant-dump nag only).
 *
 * USER STORY: A terse prompt that points at a FETCHABLE external referent (a ticket id,
 * a file path, a URL, a named doc, a prior decision) the agent can open ITSELF stays
 * SILENT — the context is ANCHORED, not missing, so "add more context" would be noise.
 * BUT a prompt missing genuinely-non-inferable, load-bearing context (the task spec is
 * absent and nothing in the prompt/transcript pins it) still fires context_sufficiency.
 *
 * TUNING-SPEC §A0 (line ~847): L06 "front-load specific scoped context" — DEMOTE THE
 * GIANT-DUMP NAG ONLY. Not a blanket demote: front-loading the TASK SPEC and ordering a
 * genuine artifact at the top are recommended. Strengthen the external-referent / "the
 * agent can fetch this" suppressor so a terse prompt pointing at fetchable context does
 * NOT trigger "add more context"; a prompt missing the load-bearing TASK SPEC SHOULD
 * still fire L06.
 *
 * ENCODING UNDER TEST:
 *  - context_sufficiency rubric + fetchable-artifact clause (prompt-coach-skill.ts:68-74)
 *  - external-referent anchoring STEP 6 (prompt-coach-skill.ts:161)
 *
 * This is a DETERMINISTIC PINNING test over the SHIPPING cascade (runQualityCascade) +
 * the frozen JUDGE_SYSTEM/RUBRIC policy. It does NOT call a live model: the judge tier is
 * a stub returning the crafted verdict the real Sonnet judge emits for each case (anchored
 * → interrupt:false; missing task spec → interrupt:true on context_sufficiency). It pins
 * the firing/silence routing + the policy ENCODING — the parts we own — while the
 * live-matrix eval scores the judge's real verdict quality. Every assertion reflects what
 * the CURRENT shipping code does; discrepancies are flagged // BEHAVIOR-NOTE.
 */
import { describe, it, expect } from 'vitest';
import { runQualityCascade, type MergedSkillCatalog } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import type { QualityCascadeInput } from '../src/brain/judge-cascade.js';
import { reflex } from '../src/brain/judge-reflex.js';
import { CAPABILITY_CATALOG, type CapabilityModelFamily } from '../src/capability/catalog.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * A FIRE verdict whose primary lever is context_sufficiency — what the judge emits when
 * the load-bearing TASK SPEC is genuinely absent and non-inferable (not a giant-dump nag,
 * a real missing-spec interrupt). High confidence + non-null missing_piece + nudge so it
 * clears the static firing gate.
 */
function contextVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { context_sufficiency: 0.1 },
    missing_piece: 'no task spec: which endpoint, what shape, against which schema?',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'context_sufficiency',
    nudge: 'name the one endpoint and its expected shape before this runs',
    ...over,
  });
}

/**
 * The SILENT verdict the judge emits for a terse prompt that NAMES a fetchable external
 * referent (STEP 6 external-referent anchoring): context is ANCHORED → interrupt:false,
 * missing_piece:null, no nudge. The cascade's firing gate drops this (interrupt false
 * AND null missing_piece AND null nudge), so the cascade returns null = SILENCE.
 */
function anchoredSilentVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { context_sufficiency: 0.85 },
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

/** Backend stub: '0.9' for the haiku prospector, the crafted judge JSON for sonnet. */
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
  return `fl06-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'build the thing',
    transcript: ['earlier prompt'],
    backend: backend(contextVerdict()),
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

describe('F-L06 — front-load context (demote the giant-dump nag only)', () => {
  it('FIRES context_sufficiency when the load-bearing task spec is genuinely absent', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: ['prime'], prompt: 'build the endpoint' }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('context_sufficiency');
    // Short contiguous fragments survive the banner soft-wrap (PANEL_WIDTH=50).
    expect(res!.tip).toContain('name the one endpoint');
  });

  it('stays SILENT when a terse prompt points at a FETCHABLE external referent (anchored)', async () => {
    // STEP 6 external-referent anchoring: "implement PROJ-1423" / "fix the bug in
    // src/auth/session.ts" names a resolvable referent the agent can open itself → the
    // judge classifies it anchored (interrupt:false, missing_piece:null, nudge:null). The
    // firing gate drops it → SILENCE. We pin the cascade ROUTING for that verdict shape.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'implement PROJ-1423',
        backend: backend(anchoredSilentVerdict()),
      }),
    );
    expect(res).toBeNull();
  });

  it('an anchored verdict that nonetheless arrives interrupt:true but missing_piece:null is DROPPED (fail-safe gate)', async () => {
    // Defense in depth: even if the judge mis-set interrupt:true on an anchored case, the
    // STATIC firing gate requires a NON-NULL missing_piece — a null missing_piece silences
    // regardless of the interrupt flag. This pins that the anchoring suppression does not
    // rely solely on the model zeroing `interrupt`.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'fix the bug in src/auth/session.ts',
        backend: backend(
          anchoredSilentVerdict({ interrupt: true, confidence: 0.85, missing_piece: null }),
        ),
      }),
    );
    expect(res).toBeNull();
  });

  it('the rubric carries a context_sufficiency dimension with the fetchable-artifact clause (the encoding exists)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'context_sufficiency');
    expect(dim).toBeDefined();
    // §5.5.2 EDIT (prompt-coach-skill.ts:68-74): terse is FINE when the prompt points at a
    // fetchable external artifact the agent can open itself.
    expect(dim!.probe.toLowerCase()).toContain('fetchable external artifact');
    expect(dim!.probe.toLowerCase()).toContain('open itself');
  });

  it('JUDGE_SYSTEM encodes STEP 6 external-referent anchoring (treat a resolvable referent as ANCHORED)', () => {
    // §5.5.2 EDIT (prompt-coach-skill.ts:161): a resolvable external referent (ticket id,
    // file path, URL, named doc, prior decision) is treated as ANCHORED, not missing, and
    // must NOT raise context_sufficiency / goal_clarity / acceptance_criteria as the gap.
    expect(JUDGE_SYSTEM).toContain('resolvable external referent');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('anchored');
    expect(JUDGE_SYSTEM).toContain('context_sufficiency');
  });

  // ── F-L25 idiom: model-scoped capability presence in the judge input ──────────────
  it('F-L25: a model-scoped capability is FILTERED OUT of the judge input when the active model is codex', async () => {
    // §5.5.5b model-gate: --effort xhigh is model-scoped (modelFamilies: opus/fable/sonnet5/mythos). With
    // activeModel:'codex' the cascade re-filters the AVAILABLE list before building the
    // judge input, so the judge never even sees it. We capture the judge USER input to
    // assert the model-scoped capability is ABSENT.
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: { judgeUser?: string } = {};
    const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
    const codex: CapabilityModelFamily = 'codex';
    // NOTE: effort-xhigh is appliesAt:'launch'; mid-session (transcript present) the
    // launch-only DROP would ALSO remove it, so to ISOLATE the model-gate we pass NO
    // transcript (fresh launch context) — then only the model-gate can exclude it.
    await runQualityCascade(
      input({
        sessionId,
        transcript: [],
        prompt: 'build the endpoint',
        backend: backend(contextVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel: codex,
      }),
    );
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).not.toContain('--effort xhigh');
  });

  it('F-L25: the same model-scoped capability IS present in the judge input when the active model is opus', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: { judgeUser?: string } = {};
    const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
    const opus: CapabilityModelFamily = 'opus';
    // Fresh launch context (no transcript) so the launch-only drop does not also remove it;
    // with activeModel:'opus' the model-gate passes → the capability reaches the judge.
    await runQualityCascade(
      input({
        sessionId,
        transcript: [],
        prompt: 'build the endpoint',
        backend: backend(contextVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel: opus,
      }),
    );
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).toContain('--effort xhigh');
  });

  // ── F-SILENCE idiom: the Tier-0 reflex suppresses trivial/approval shapes ──────────
  it('F-SILENCE: the Tier-0 reflex suppresses a bare approval ("yes") before any model call', () => {
    // The cascade runs reflex() FIRST (judge-cascade.ts step 2); a suppressing reflex means
    // a terse approval never even reaches the prospector — pure, no-model silence.
    expect(reflex('yes').suppress).toBe(true);
    expect(reflex('yes').reason).toBe('approval');
    // A terse-but-substantive new ask is NOT reflex-suppressed (it escalates to the judge,
    // where the L06 anchoring policy decides) — pins that anchoring is the JUDGE's job, not
    // the reflex's.
    expect(reflex('implement PROJ-1423').suppress).toBe(false);
  });
});
