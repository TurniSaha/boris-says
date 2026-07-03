/**
 * F-L05 — Acceptance-criteria / definition-of-done nudge (TUNING-SPEC §A0 PROMOTE, L05).
 *
 * USER STORY: I type a subjective "make it nicer / better" ask with no checkable
 * condition — no definition of done. The coach nudges me — in ONE sentence — to name a
 * concrete definition-of-done. BUT if my project documents the test command
 * (CLAUDE.md / testCmdDocumented), the coach stays SILENT — the how-we-know-it-worked
 * already lives in the repo and a nudge would be noise. An UNKNOWN (null) signal NEVER
 * suppresses (the fail-safe is absolute).
 *
 * This is a DETERMINISTIC CONTRACT / PINNING test over the SHIPPING cascade
 * (runQualityCascade) + the frozen rubric/policy. It does NOT call a live model: the
 * judge tier is a stub returning a crafted `acceptance_criteria` verdict (what the real
 * Sonnet judge emits for this case). It pins the firing/silence routing + the policy
 * encoding we own (the SUP-2 testCmdDocumented suppression at judge-cascade.ts:398-401,
 * the acceptance_criteria rubric dim at prompt-coach-skill.ts:76) while the live-matrix
 * eval scores the judge's real verdict quality.
 *
 * Every assertion reflects what the CURRENT shipping code actually does — these are
 * PINNING tests of existing behavior, not aspirational. Where the code's behavior is
 * subtle or surprising, a // BEHAVIOR-NOTE: comment flags it for the human.
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
import { CAPABILITY_CATALOG, type CapabilityModelFamily } from '../src/capability/catalog.js';
import { reflex } from '../src/brain/judge-reflex.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * A FIRE verdict whose primary lever is acceptance_criteria (what the judge emits for a
 * subjective "make it nicer" ask with no checkable condition). Names a concrete
 * definition-of-done in the nudge per STEP 7 — the bounded-enumeration shape.
 */
function acceptanceVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { acceptance_criteria: 0.1 },
    missing_piece: 'no definition of done — "nicer" is not checkable',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'acceptance_criteria',
    nudge: 'name a concrete definition of done — which 2-3 checkable things make this "nicer"?',
    ...over,
  });
}

/**
 * A backend stub: '0.9' for the Haiku prospector (escalate), the crafted judge JSON for
 * the Sonnet judge. The optional `capture` records the judge USER input so F-L25 can
 * inspect what the judge was shown (model-scoped capability presence).
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
    prompt: 'make the dashboard nicer',
    transcript: ['earlier prompt'],
    backend: backend(acceptanceVerdict()),
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

describe('F-L05 — acceptance-criteria / definition-of-done nudge', () => {
  it('fires a one-sentence definition-of-done nudge for a subjective ask with no checkable condition', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('definition of done');
    expect(res!.lever).toBe('acceptance_criteria');
  });

  it('stays SILENT when the project documents the test command (SUP-2 testCmdDocumented)', async () => {
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
    expect(res!.lever).toBe('acceptance_criteria');
  });

  it('still fires when testCmdDocumented is explicitly FALSE (only a positive observation suppresses)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        localContext: { project: { testCmdDocumented: false } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('acceptance_criteria');
  });

  it('still fires when localContext.project is null (UNKNOWN project facts never suppress)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: ['prime'], localContext: { project: null } }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('acceptance_criteria');
  });

  it('the rubric carries an acceptance_criteria dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'acceptance_criteria');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('definition of done');
  });

  it('JUDGE_SYSTEM bans the vague "decide what it shows" phrasing and requires a concrete definition of done', () => {
    // §5.5.3: the nudge must name a CONCRETE undecided choice, not a vague category —
    // and goal/scope levers must keep the nudge about pinning ONE outcome + a definition
    // of done (the L05 acceptance-criteria spine).
    expect(JUDGE_SYSTEM).toContain('definition of done');
    expect(JUDGE_SYSTEM).toContain('decide what it shows'); // listed as a BANNED phrasing.
  });

  // ── F-SILENCE: a bare approval / continuation reflex-suppresses BEFORE the cascade ──
  describe('F-SILENCE — Tier-0 reflex never lets an approval reach the judge', () => {
    it('reflex("yes") suppresses (approval) so an acceptance nudge can never fire on it', () => {
      const v = reflex('yes');
      expect(v.suppress).toBe(true);
      expect(v.reason).toBe('approval');
    });

    it('reflex("make the dashboard nicer") does NOT suppress (the real L05 ask escalates)', () => {
      // BEHAVIOR-NOTE: the L05 trigger ask is NOT a trivial-fix (no marker, no trivial
      // verb, and it is short but the reflex only swallows short prompts matching a
      // marker/intent) — so Tier-0 PROCEEDs and the prompt reaches the judge. This pins
      // that the lever's own canonical prompt is reflex-eligible to fire.
      const v = reflex('make the dashboard nicer');
      expect(v.suppress).toBe(false);
      expect(v.reason).toBeNull();
    });

    it('cascade returns null when the prompt reflex-suppresses (no ping, no tip on turn 2)', async () => {
      const sessionId = nextSession();
      await primed(sessionId);
      // 'yes' is an approval → Tier-0 suppress; the first-seen ping was consumed by
      // priming, so the whole cascade is silent.
      const res = await runQualityCascade(input({ sessionId, prompt: 'yes', transcript: ['prime'] }));
      expect(res).toBeNull();
    });
  });

  // ── F-L25: model-scoped capability gate (only show a capability the dev's model can use) ──
  describe('F-L25 — model-gate: the judge only sees capabilities the active model can use', () => {
    it('a model-scoped capability appears in the judge input when the active model is opus', async () => {
      const sessionId = nextSession();
      const capture: { judgeUser?: string } = {};
      const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
      // effort-xhigh is launch-only AND model-scoped (modelFamilies: opus/fable/sonnet5/mythos);
      // use a FRESH launch (no transcript)
      // so the §5.5.5a launch-only drop does not apply and we isolate the §5.5.5b model
      // gate. The activeModel is threaded into the AVAILABLE re-filter.
      const activeModel: CapabilityModelFamily = 'opus';
      await runQualityCascade(
        input({
          sessionId,
          transcript: [],
          capabilities: [effortXhigh],
          activeModel,
          backend: backend(acceptanceVerdict(), capture),
        }),
      );
      expect(capture.judgeUser).toBeDefined();
      expect(capture.judgeUser).toContain('--effort xhigh');
    });

    it('a model-scoped capability is FILTERED OUT of the judge input when the active model is codex', async () => {
      const sessionId = nextSession();
      const capture: { judgeUser?: string } = {};
      const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
      const activeModel: CapabilityModelFamily = 'codex';
      await runQualityCascade(
        input({
          sessionId,
          transcript: [],
          capabilities: [effortXhigh],
          activeModel,
          backend: backend(acceptanceVerdict(), capture),
        }),
      );
      expect(capture.judgeUser).toBeDefined();
      // The model-scoped flag must not appear in what a codex-active dev's judge is shown.
      expect(capture.judgeUser).not.toContain('--effort xhigh');
    });

    it('without an activeModel, the cascade applies NO model gate (the capability is shown)', async () => {
      // BEHAVIOR-NOTE: when activeModel is undefined the cascade's AVAILABLE re-filter
      // skips the modelFamily check entirely (judge-cascade.ts:267) — version-only
      // resolution. So a model-scoped capability is still shown to the judge; the gate
      // is opt-in via activeModel, not always-on.
      const sessionId = nextSession();
      const capture: { judgeUser?: string } = {};
      const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
      await runQualityCascade(
        input({
          sessionId,
          transcript: [],
          capabilities: [effortXhigh],
          backend: backend(acceptanceVerdict(), capture),
        }),
      );
      expect(capture.judgeUser).toBeDefined();
      expect(capture.judgeUser).toContain('--effort xhigh');
    });
  });
});
