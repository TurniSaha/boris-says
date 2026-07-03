/**
 * F-L22 — Skill-fit / reuse-before-hand-roll (skill_fit), as SHIPPED today.
 *
 * USER STORY: I plan to HAND-ROLL / reinvent something an available skill (or well-known
 * tooling) already provides. The coach nudges me — in ONE sentence — to reuse the existing
 * skill before I run, naming the EXACT skill id from the catalog (registry-gated). BUT when
 * my hand-roll is JUSTIFIED (I name why the existing thing doesn't fit AND name a check),
 * that is sound engineering and the coach must stay SILENT.
 *
 * RECOMMENDATION = PIN-EXISTING (no new clause). The v1 adversarial verdict was REJECT
 * (precision_safe=false): the PROSPECTOR already scores hand-rolling HIGH
 * (prompt-coach-skill.ts PROSPECTOR_SYSTEM "hand-rolling or reinventing something that
 * likely already exists" + the worked design-tokens HIGH example), STEP 4 already emits a
 * registry-gated skill_fit, and `composeTip` already resolves ONLY a catalog skill through
 * `catalog.resolveAction`. A NEW JUDGE_SYSTEM clause would add no detection power and would
 * COLLIDE with two live suppressors — the §5.5.4 justified-hand-roll PROSPECTOR-LOW example
 * and the §5.5.5c goal/scope skill-fit guard — eroding the precision wall. So this file
 * PINS the existing skill_fit routing instead of adding a clause.
 *
 * Like F-V01 / F-L01 this is a DETERMINISTIC CONTRACT / PINNING test over the SHIPPING
 * cascade (`runQualityCascade`) + the frozen rubric/policy. It does NOT call a live model:
 * the judge tier is a stub returning the crafted `skill_fit` verdict the real Sonnet judge
 * emits for these cases. It pins the firing/silence routing we own — not the live judge's
 * verdict quality (that is the Phase-2 live-matrix eval's job).
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
  type SkillAction,
} from '../src/brain/judge-cascade.js';
import {
  PROMPT_COACH_SKILL,
  RUBRIC_DIMENSIONS,
  JUDGE_SYSTEM,
  PROSPECTOR_SYSTEM,
  buildJudgeUser,
} from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

/**
 * A catalog that HAS the `design-sync` skill (the registry-gated reuse target for the
 * hand-rolled-design-tokens case). resolveAction returns a real `run` action for it and
 * `none` for anything else — mirroring the merged-skill-catalog contract.
 */
const tokensCatalog: MergedSkillCatalog = {
  all: ['design-sync', 'audit', 'critique'],
  resolveAction(skillId: string): SkillAction {
    return skillId === 'design-sync'
      ? { kind: 'run', skillId: 'design-sync' }
      : { kind: 'none' };
  },
};

/** A catalog that does NOT carry the recommended skill (registry-gate negative control). */
const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * A FIRE verdict whose primary lever is skill_fit and whose skill_fit names a real catalog
 * skill — what the real judge emits when the dev plans to hand-roll something a skill covers.
 */
function skillFitVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { skill_fit: 0.1 },
    missing_piece: 'hand-rolling design tokens a skill already generates',
    risk_level: 'low',
    skill_fit: { candidate_skill: 'design-sync', confidence: 0.85 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'skill_fit',
    nudge: 'reuse the design-sync skill instead of hand-coding the tokens by hand',
    ...over,
  });
}

/**
 * The JUSTIFIED-hand-roll verdict: the real judge returns interrupt:false / missing_piece
 * null (the §5.5.4 PROSPECTOR-LOW + EXPERTISE-check case — a named reason the existing
 * thing does not fit AND a named check). The firing gate then SILENCEs.
 */
function justifiedHandRollVerdict(): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { skill_fit: 0.8 },
    missing_piece: null,
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: false,
    confidence: 0.3,
    primary_lever: 'skill_fit',
    nudge: null,
  });
}

/** A backend stub: '0.9' for the haiku prospector (escalate), crafted JSON for sonnet. */
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
  return `fl22-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: "I'll hand-code all our design tokens and copy each component by hand",
    transcript: ['earlier prompt'],
    backend: backend(skillFitVerdict()),
    skill: PROMPT_COACH_SKILL,
    state,
    catalog: tokensCatalog,
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

describe('F-L22 — skill-fit reuse-before-hand-roll (skill_fit), as shipped', () => {
  // ── FIRE: hand-rolling what a catalog skill covers → a registry-gated reuse nudge ────
  it('FIRES a reuse nudge when the dev hand-rolls what a catalog skill (design-sync) covers', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('skill_fit');
    expect(res!.tip).toContain('design-sync');
  });

  // ── SILENT: the JUSTIFIED hand-roll (named reason + named check) → interrupt:false ───
  it('stays SILENT on a JUSTIFIED hand-roll (judge returns interrupt:false / missing_piece null)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // "hand-write a small debounce because we dropped lodash for bundle size and need a
    // leading-edge flush it lacks, with a unit test" — §5.5.4 PROSPECTOR-LOW / EXPERTISE
    // check: the judge returns interrupt:false, the firing gate SILENCEs.
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt:
          'hand-write a small debounce because we dropped lodash for bundle size and need a leading-edge flush it lacks, with a unit test',
        backend: backend(justifiedHandRollVerdict()),
      }),
    );
    expect(res).toBeNull();
  });

  // ── LOOK-ALIKE CONTROL: a continuation that mentions a skill is NOT interrupted ──────
  it('LOOK-ALIKE control: a continuation-phase skill_fit verdict is suppressed by the firing gate', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // Same high-confidence skill_fit shape, but the phase is continuation (anchored in
    // recent work) — INTERRUPT_ELIGIBLE_PHASES excludes it, so the gate SILENCEs even
    // though interrupt:true. (Mirrors the precision-wall continuation suppression.)
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'now also generate the tokens the same way',
        backend: backend(skillFitVerdict({ phase: 'continuation', confidence: 0.95 })),
      }),
    );
    expect(res).toBeNull();
  });

  // ── REGISTRY GATE: a recommended skill NOT in the catalog yields no skill action ─────
  it('REGISTRY-GATED: a skill_fit verdict still fires the nudge text, but no skill action rides when the catalog lacks it', async () => {
    // The verdict names design-sync, but the injected catalog is EMPTY → resolveAction
    // returns {kind:'none'}. The nudge text (the judge's words) still surfaces, but no
    // skill is *resolved* — the registry gate is the catalog, not the judge's free text.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      input({ sessionId, transcript: ['prime'], catalog: emptyCatalog }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('skill_fit');
  });

  // ── REGISTRY GATE (input): the judge is only ever SHOWN catalog skills to recommend ──
  it('REGISTRY-GATED (input): buildJudgeUser renders ONLY catalog skills under a recommend-only-from-this-list instruction', () => {
    const user = buildJudgeUser(
      'hand-roll the tokens',
      [],
      '',
      ['design-sync', 'audit'],
      [],
    );
    expect(user).toContain('recommend ONLY from this list');
    expect(user).toContain('- design-sync');
    expect(user).toContain('- audit');
    // A skill NOT in the catalog is never rendered for the judge to pick.
    expect(user).not.toContain('- some-uninstalled-skill');
  });

  // ── POLICY PIN: the skill_fit lever + STEP 4 + the prospector hand-roll guidance ─────
  it('the rubric carries a skill_fit dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'skill_fit');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('skill');
  });

  it('STEP 4 instructs the judge to set a registry-gated skill_fit (exact id from the list)', () => {
    expect(JUDGE_SYSTEM).toContain('STEP 4');
    expect(JUDGE_SYSTEM).toContain('the exact skill id from the list');
  });

  it('the PROSPECTOR scores hand-rolling/reinventing HIGH (the existing detection — no new clause needed)', () => {
    expect(PROSPECTOR_SYSTEM).toContain('hand-rolling or reinventing something that likely already exists');
    // The worked HIGH example is the design-tokens hand-roll.
    expect(PROSPECTOR_SYSTEM).toContain('hand-code all our design tokens');
  });

  it('the PROSPECTOR still scores the JUSTIFIED hand-roll LOW (the suppressor a new clause would erode)', () => {
    // §5.5.4 PROSPECTOR-LOW: a named missing capability + a named check = sound engineering.
    expect(PROSPECTOR_SYSTEM).toContain('a concrete reason the existing thing does not fit');
    expect(PROSPECTOR_SYSTEM).toContain('hand-write a small debounce');
  });

  it('the §5.5.5c goal/scope skill-fit guard is intact (no how-to skill on an undefined task)', () => {
    // The OTHER suppressor a naive strengthening would collide with: when the task itself
    // is not defined (goal_clarity/scope_boundaries), skill_fit must NOT carry a how-to skill.
    expect(JUDGE_SYSTEM).toContain('do NOT set skill_fit or capability_fit to a how-to/solution skill');
  });
});
