/**
 * F-L25 — Effort/thinking-fit nudge, MODEL-AWARE (the L25 lever; TUNING-SPEC §A0 ~855, §10).
 *
 * USER STORY: effort/thinking-fit coaxing is MODEL-AWARE. The model-scoped capability
 * `effort-xhigh` (CLI flag `--effort xhigh`, scoped to the opus/fable/sonnet5/mythos
 * families) is FILTERED OUT of the judge input when the active model family does NOT
 * support it — so the coach never offers `--effort xhigh` to a dev on an unsupported
 * family. It rides only when the active model supports it. (Fires rarely: the default
 * coding effort is already high.)
 *
 * This is a DETERMINISTIC CONTRACT / PINNING test over the SHIPPING cascade
 * (runQualityCascade) + the frozen rubric + the §5.5.5b model-gate. It does NOT call a
 * live model: the judge tier is a stub returning a crafted verdict; the prospector tier
 * returns 0.9. We CAPTURE the judge USER input (the second mockBackend arg's `judgeUser`)
 * to assert the model-scoped capability is/ isn't rendered into the judge's view, and we
 * pin the "never re-attached at deposit time" fail-closed behavior of composeTip.
 *
 * THE LAUNCH-ONLY INTERACTION (important): `effort-xhigh.appliesAt === 'launch'`, so the
 * §5.5.5a launch-only drop ALSO removes it mid-session (when a transcript is present) for
 * EVERY model. To ISOLATE the §5.5.5b MODEL gate we therefore use an EMPTY transcript
 * (not mid-session) on the assertion turn, and pin the launch-only interaction separately.
 */
import { describe, it, expect } from 'vitest';
import { runQualityCascade, type MergedSkillCatalog } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, RUBRIC_DIMENSIONS, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import type { QualityCascadeInput } from '../src/brain/judge-cascade.js';
import {
  CAPABILITY_CATALOG,
  type Capability,
  type CapabilityModelFamily,
} from '../src/capability/catalog.js';
import { reflex } from '../src/brain/judge-reflex.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** The model-scoped (opus/fable/sonnet5/mythos), launch-only capability under test (`--effort xhigh`). */
const EFFORT_XHIGH: Capability =
  CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh') ??
  (() => {
    throw new Error('effort-xhigh capability missing from catalog');
  })();

/** The judge-input line the cascade renders for effort-xhigh (trigger + kind + appliesAt). */
const EFFORT_XHIGH_LINE = '--effort xhigh (cli_flag, launch):';

/**
 * A FIRE verdict whose primary lever is effort_level_fit (what the judge emits here). It
 * recommends the effort-xhigh capability and names its exact trigger in the nudge — the
 * §5.5.5 shape (a capability rides with its trigger in backticks).
 */
function effortVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { effort_level_fit: 0.1 },
    missing_piece: 'a gnarly migration started at the default coding effort',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: 'effort-xhigh', confidence: 0.8 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'effort_level_fit',
    nudge: 'this migration is gnarly — relaunch with `--effort xhigh` for deeper reasoning',
    ...over,
  });
}

/** Capture box for the judge USER input (so we can assert what the judge actually saw). */
interface JudgeCapture {
  judgeUser: string | null;
}

/**
 * Backend stub: '0.9' for the haiku prospector, the crafted judge JSON for sonnet. The
 * second arg captures the judge USER prompt so the test can inspect the rendered
 * capability list (the §5.5.5b model-gate acts on THIS view).
 */
function backend(judge: string, capture?: JudgeCapture): LlmBackend {
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
  return `fl25-${sid}`;
}

function baseInput(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'do the big payments-schema migration across all services',
    transcript: ['earlier prompt'],
    backend: backend(effortVerdict()),
    skill: PROMPT_COACH_SKILL,
    state,
    catalog: emptyCatalog,
    capabilities: [EFFORT_XHIGH],
    sessionId: nextSession(),
    now: () => 1_000_000,
    ...over,
  };
}

/** Consume the additive first-seen ping so later turns isolate the fire/silence decision. */
async function primed(sessionId: string): Promise<void> {
  await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
}

describe('F-L25 — effort/thinking-fit nudge (model-aware)', () => {
  it('DROPS the model-scoped capability from the judge input when the active model does NOT support it', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: JudgeCapture = { judgeUser: null };
    // Empty transcript on the assertion turn ISOLATES the §5.5.5b model gate (the
    // launch-only drop only fires mid-session). activeModel='codex' is out of scope for
    // the opus-scoped effort-xhigh, so the cascade re-filters it out before the judge.
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: [],
        activeModel: 'codex' as CapabilityModelFamily,
        backend: backend(effortVerdict(), capture),
      }),
    );
    expect(capture.judgeUser).not.toBeNull();
    // The model-scoped capability is FILTERED OUT — the unsupported-family dev never sees --effort xhigh.
    expect(capture.judgeUser!).not.toContain(EFFORT_XHIGH_LINE);
    // The catalog still rendered SOMETHING (the no-capability fallback line proves the
    // filter dropped it rather than the list never being built).
    expect(capture.judgeUser!).toContain('(none available on this build)');
    // And because the verdict named an unavailable capability in its nudge, the §5.5.5f
    // backtick-token gate fails CLOSED → the coach stays SILENT (never re-attached).
    expect(res).toBeNull();
  });

  it('KEEPS the model-scoped capability in the judge input when the active model supports it', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: JudgeCapture = { judgeUser: null };
    // activeModel='opus' supports effort-xhigh; empty transcript so the launch-only drop
    // does not interfere with isolating the model gate.
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: [],
        activeModel: 'opus' as CapabilityModelFamily,
        backend: backend(effortVerdict(), capture),
      }),
    );
    expect(capture.judgeUser).not.toBeNull();
    // The opus-scoped capability SURVIVES — it rides only when the model supports it.
    expect(capture.judgeUser!).toContain(EFFORT_XHIGH_LINE);
    // The capability is available, so the nudge naming `--effort xhigh` is NOT fail-closed:
    // the coach fires the effort_level_fit nudge.
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('effort_level_fit');
    // BEHAVIOR-NOTE: the composed nudge survives the §5.5.5f backtick gate (proving the
    // capability is AVAILABLE — an unavailable one would fail-closed to null/silence). The
    // mailbox banner word-WRAPS the trigger across lines, so we assert on `--effort` (the
    // wrap-stable head of `--effort xhigh`) rather than the contiguous trigger string.
    expect(res!.tip).toContain('--effort');
    // The billed cost-disclosure clause rides too (effort-xhigh.costClass === 'billed').
    expect(res!.tip).toContain('uses extra usage');
  });

  it('also DROPS the launch-only capability MID-SESSION even for the supporting model (launch-only gate)', async () => {
    // BEHAVIOR-NOTE: effort-xhigh.appliesAt === 'launch', so the §5.5.5a launch-only drop
    // removes it mid-session (a transcript is present) for EVERY model — independent of the
    // §5.5.5b model gate. With activeModel='opus' (a SUPPORTING family) it STILL vanishes
    // from the judge input mid-session. This is why the model-gate isolation tests above
    // use an EMPTY transcript. The nudge then names an unavailable capability → SILENCE.
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: JudgeCapture = { judgeUser: null };
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: ['prime'], // mid-session → launch-only drop fires.
        activeModel: 'opus' as CapabilityModelFamily,
        backend: backend(effortVerdict(), capture),
      }),
    );
    expect(capture.judgeUser).not.toBeNull();
    expect(capture.judgeUser!).not.toContain(EFFORT_XHIGH_LINE);
    expect(res).toBeNull();
  });

  it('with no activeModel and no transcript the opus capability survives (version-only resolution)', async () => {
    // When activeModel is OMITTED the cascade applies no model gate (the resolver cannot
    // confirm the family). With an empty transcript the launch-only drop is also inert, so
    // effort-xhigh rides on its universal_version availability alone.
    const sessionId = nextSession();
    await primed(sessionId);
    const capture: JudgeCapture = { judgeUser: null };
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: [],
        // activeModel omitted on purpose.
        backend: backend(effortVerdict(), capture),
      }),
    );
    expect(capture.judgeUser).not.toBeNull();
    expect(capture.judgeUser!).toContain(EFFORT_XHIGH_LINE);
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('effort_level_fit');
  });

  it('NEVER re-attaches the dropped capability at deposit time even if the verdict names it (fail-closed)', async () => {
    // Pins the "never re-attached" invariant directly: activeModel='codex' (non-supporting),
    // empty transcript (model gate is the only filter), and a verdict that explicitly names
    // `--effort xhigh` in its nudge. composeTip's §5.5.5f backtick gate sees the named
    // capability is NOT in the (model-filtered) available list → returns null → SILENCE.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: [],
        activeModel: 'codex' as CapabilityModelFamily,
        backend: backend(effortVerdict()),
      }),
    );
    expect(res).toBeNull();
  });

  it('the rubric carries an effort_level_fit dimension that is model-aware (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'effort_level_fit');
    expect(dim).toBeDefined();
    expect(dim!.probe.toLowerCase()).toContain('effort');
    // §10 model-awareness is encoded in the probe: it cites the model-specific recommendation
    // (Opus xhigh vs GPT-5.5 Codex medium/high) so the judge scores effort per active model.
    expect(dim!.probe).toContain('Opus');
  });

  it('JUDGE_SYSTEM guards effort_level_fit against firing on trivial tasks (rare-by-design)', () => {
    // The lever fires rarely (default effort already high): the policy bans effort_level_fit
    // as the primary lever on a small/trivial task — only a genuinely large/gnarly task.
    expect(JUDGE_SYSTEM).toContain('effort_level_fit');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('trivial task');
  });

  it('F-SILENCE: the Tier-0 reflex suppresses approvals/continuations before any effort nudge', () => {
    // The effort lever can only fire if the prompt even reaches the judge. A bare approval
    // or continuation is swallowed at Tier 0 (no Haiku, no Sonnet) — so a terse "yes" never
    // becomes an effort_level_fit interrupt.
    expect(reflex('yes').suppress).toBe(true);
    expect(reflex('yes').reason).toBe('approval');
    expect(reflex('continue').suppress).toBe(true);
    expect(reflex('continue').reason).toBe('trivial-continuation');
    // A genuine large-effort ask is NOT swallowed at Tier 0 — it must escalate to the judge.
    expect(reflex('do the big payments-schema migration across all services').suppress).toBe(false);
  });
});
