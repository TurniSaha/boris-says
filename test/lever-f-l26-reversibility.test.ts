/**
 * F-L26 — Reversibility / data-safety nudge (risk_awareness on a destructive op).
 *
 * USER STORY: I open a destructive/stateful op against prod — a DROP/DELETE/TRUNCATE or a
 * destructive migration run directly against the database. The coach fires a risk_awareness
 * nudge that names a CONCRETE reversibility step (take a snapshot/backup, or run it through
 * the reversible migration pipeline WITH a rollback) BEFORE the destructive run.
 *
 * ITEM 7 CARVE-OUT: because the base prompt here is a DATA-destructive op
 * (`DROP the legacy_orders table on prod`), a clean branch is NOT an undo (a git branch does
 * not roll back a dropped table), so SUP-3 does NOT suppress risk_awareness even on a clean
 * branch — it still FIRES. SUP-3's clean-branch suppression remains in force for ordinary
 * CODE-risk (a non-data-destructive prompt); that path is covered by the destructive-op +
 * judge-cascade SUP-3 tests. A dirty branch and UNKNOWN git signals always FIRE regardless.
 *
 * This is a DETERMINISTIC CONTRACT (PINNING) test over the SHIPPING cascade
 * (runQualityCascade) + the SUP-3 suppression rule (judge-cascade.ts:404-408) + the frozen
 * JUDGE_SYSTEM policy (the §5.5.3 RISK-SURFACE OVERRIDE + the §5.5.5d data-destruction
 * clause). It does NOT call a live model: the judge tier is a stub returning the crafted
 * risk_awareness verdict the real Sonnet judge emits for this case. It pins the
 * firing/silence routing + the policy encoding — the parts we own — while the live-matrix
 * eval scores the judge's real verdict quality.
 *
 * NOTE on substring assertions: formatCoachBanner (mailbox-format.ts) word-wraps the nudge
 * to a 50-char panel width, so every asserted nudge substring is kept short enough to
 * survive on a single wrapped line.
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
import { reflex } from '../src/brain/judge-reflex.js';
import {
  CAPABILITY_CATALOG,
  type Capability,
  type CapabilityModelFamily,
} from '../src/capability/catalog.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/**
 * The risk_awareness FIRE verdict the judge emits for a destructive-prod op: risk_level
 * high, primary_lever risk_awareness, and a nudge naming a CONCRETE reversibility step
 * (snapshot/backup) BEFORE the DROP. The nudge is kept short so it survives the 50-char
 * panel word-wrap for substring assertions.
 */
function reversibilityVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'escalation',
    dimension_scores: { risk_awareness: 0.1 },
    missing_piece: 'no snapshot/backup before the destructive DROP on prod',
    risk_level: 'high',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'risk_awareness',
    nudge: 'snapshot it before you DROP it on prod',
    ...over,
  });
}

/**
 * A backend stub: '0.9' for the haiku prospector (escalate), the crafted judge JSON for
 * the sonnet judge. The optional `capture` records the judge USER input so the F-L25
 * model-gate test can inspect the capability list the judge was actually shown.
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
  return `fl26-${sid}`;
}

function baseInput(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'DROP the legacy_orders table on prod',
    transcript: ['earlier prompt'],
    backend: backend(reversibilityVerdict()),
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
  await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
}

describe('F-L26 — reversibility / data-safety nudge (risk_awareness)', () => {
  it('FIRES naming a concrete reversibility step before a destructive prod op', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(baseInput({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
    // The composed nudge names a concrete reversibility step (snapshot) BEFORE the DROP.
    expect(res!.tip).toContain('snapshot');
    expect(res!.tip).toContain('DROP');
  });

  it('STILL FIRES on a clean branch when the prompt names a DATA-destructive op (item 7 carve-out)', async () => {
    // SUP-3 normally silences risk_awareness on a clean branch (an undo exists). But the
    // baseInput prompt here is `DROP the legacy_orders table on prod` — a git branch does NOT
    // roll back a dropped table, so the item 7 carve-out keeps risk_awareness firing even on a
    // clean branch. (SUP-3 is still kept for ordinary CODE-risk — see the destructive-op tests.)
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: ['prime'],
        localContext: { git: { onBranch: true, dirty: false, branch: 'feature/x' } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
  });

  it('FIRES on a DIRTY branch (onBranch true, dirty true) — uncommitted work, no clean undo', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: ['prime'],
        localContext: { git: { onBranch: true, dirty: true, branch: 'feature/x' } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
  });

  it('FIRES when git is UNKNOWN (git === null never suppresses — fail-safe absolute)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: ['prime'],
        localContext: { git: null },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
  });

  it('FIRES when onBranch/dirty are UNKNOWN (null signals never suppress)', async () => {
    // onBranch null OR dirty null is UNKNOWN; SUP-3 requires BOTH a positive onBranch AND a
    // positive dirty:false. A null on either side → fire.
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        transcript: ['prime'],
        localContext: { git: { onBranch: true, dirty: null, branch: null } },
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
  });

  it('FIRES when localContext is ABSENT (today\'s behavior — no suppression)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    // baseInput passes no localContext → the suppression gate is never entered.
    const res = await runQualityCascade(baseInput({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('risk_awareness');
  });

  it('the rubric carries a risk_awareness dimension (the lever exists in the skill)', () => {
    const dim = RUBRIC_DIMENSIONS.find((d) => d.id === 'risk_awareness');
    expect(dim).toBeDefined();
    // The probe names the risky surfaces (migrations, auth, data).
    expect(dim!.probe.toLowerCase()).toContain('migrations');
    expect(dim!.probe.toLowerCase()).toContain('data');
  });

  it('JUDGE_SYSTEM encodes the §5.5.5d data-destruction reversibility clause', () => {
    // The data-destruction clause (prompt-coach-skill.ts:173) forces risk_awareness/
    // verification_path and a concrete reversibility step (snapshot/backup; reversible
    // migration pipeline with a rollback) before any destructive run, and BANS substituting
    // a code-review capability for a data-safety gap.
    const lower = JUDGE_SYSTEM.toLowerCase();
    expect(lower).toContain('drop/delete/truncate');
    expect(lower).toContain('reversibility step');
    expect(lower).toContain('snapshot');
    expect(lower).toContain('rollback');
    // NEVER substitute a code-review capability for a data-safety gap.
    expect(JUDGE_SYSTEM).toContain('/code-review');
    expect(JUDGE_SYSTEM).toContain('/security-review');
  });

  it('JUDGE_SYSTEM encodes the §5.5.3 RISK-SURFACE OVERRIDE (risk_awareness on an unaddressed surface)', () => {
    expect(JUDGE_SYSTEM).toContain('RISK-SURFACE OVERRIDE');
    expect(JUDGE_SYSTEM).toContain('risk_awareness');
  });
});

describe('F-L26 / F-SILENCE — the destructive op is NOT swallowed by the Tier-0 reflex', () => {
  it('reflex does NOT suppress a destructive prod prompt (a risk token escalates it to the judge)', () => {
    // judge-reflex.ts RISK_TOKENS includes drop/delete/truncate/prod, so a destructive op
    // is NEVER a trivial-fix at Tier 0 — it escalates to the model cascade.
    expect(reflex('DROP the legacy_orders table on prod').suppress).toBe(false);
    expect(reflex('truncate the events table in production').suppress).toBe(false);
  });

  it('reflex DOES suppress a bare approval (F-SILENCE control: yes/stop are swallowed locally)', () => {
    expect(reflex('yes').suppress).toBe(true);
    expect(reflex('yes').reason).toBe('approval');
    expect(reflex('stop').suppress).toBe(true);
    expect(reflex('continue').suppress).toBe(true);
    expect(reflex('continue').reason).toBe('trivial-continuation');
  });
});

describe('F-L26 / F-L25 — capability model-gate: a model-scoped capability the dev cannot use is hidden from the judge', () => {
  // The only model-scoped capability in the catalog is `effort-xhigh` (modelFamilies:
  // opus/fable/sonnet5/mythos, appliesAt 'launch'). To isolate the §5.5.5b MODEL gate from
  // the §5.5.5a launch-only-drop
  // we use an EMPTY transcript (not mid-session, so the launch-drop does not fire) and vary
  // only `activeModel`. We capture the judge USER input via the second backend arg.
  const effortXhigh: Capability = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;

  it('HIDES the opus-scoped capability when activeModel is a non-opus family (codex)', async () => {
    const capture: { judgeUser?: string } = {};
    const activeModel: CapabilityModelFamily = 'codex';
    const res = await runQualityCascade(
      baseInput({
        transcript: [],
        backend: backend(reversibilityVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel,
      }),
    );
    expect(res).not.toBeNull();
    expect(capture.judgeUser).toBeDefined();
    // The model-scoped capability is filtered out before the judge input is built.
    expect(capture.judgeUser).not.toContain('--effort xhigh');
    expect(capture.judgeUser).toContain('(none available on this build)');
  });

  it('SHOWS the opus-scoped capability when activeModel matches (opus) and no launch-drop applies', async () => {
    const capture: { judgeUser?: string } = {};
    const activeModel: CapabilityModelFamily = 'opus';
    const res = await runQualityCascade(
      baseInput({
        transcript: [], // empty → not mid-session → launch-only-drop does NOT fire.
        backend: backend(reversibilityVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel,
      }),
    );
    expect(res).not.toBeNull();
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).toContain('--effort xhigh');
  });

  it('DROPS the launch-only capability mid-session (transcript present) regardless of model match', async () => {
    // §5.5.5a launch-only-drop: even with the model matching (opus), a launch-only
    // capability is dropped when a transcript exists (relaunching would discard context).
    const capture: { judgeUser?: string } = {};
    const activeModel: CapabilityModelFamily = 'opus';
    const res = await runQualityCascade(
      baseInput({
        transcript: ['earlier prompt'], // present → mid-session → launch-drop fires.
        backend: backend(reversibilityVerdict(), capture),
        capabilities: [effortXhigh],
        activeModel,
      }),
    );
    expect(res).not.toBeNull();
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).not.toContain('--effort xhigh');
  });
});
