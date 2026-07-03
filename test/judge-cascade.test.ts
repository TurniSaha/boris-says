import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  NO_SKILL_ACTION,
  type MergedSkillCatalog,
  type QualityCascadeInput,
  type SkillAction,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL } from '../src/brain/prompt-coach-skill.js';
import { COACH_SENTINEL_REPLY, COACH_FIRST_RUN_TOUR } from '../src/brain/coach-liveness.js';
import { CAPABILITY_CATALOG, type Capability } from '../src/capability/catalog.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * A backend mock keyed by which TIER is being called. The cascade calls the prospector
 * with model:'haiku' and the judge with model:'sonnet' — the cleanest discriminator.
 * We also assert the system prompt matches the skill, and capture the judge USER input
 * so launch-only-drop tests can inspect what the judge was shown.
 */
interface MockBackendResult {
  readonly prospector: string | null;
  readonly judge: string | null;
}

function mockBackend(
  results: MockBackendResult,
  capture?: { judgeUser?: string },
): LlmBackend {
  return {
    configured: true,
    async complete(opts: LlmCompleteOptions): Promise<string | null> {
      if (opts.model === 'haiku') {
        expect(opts.system).toBe(PROMPT_COACH_SKILL.prospectorSystem);
        return results.prospector;
      }
      // sonnet judge
      expect(opts.system).toBe(PROMPT_COACH_SKILL.judgeSystem);
      if (capture) capture.judgeUser = opts.user;
      return results.judge;
    },
  };
}

const emptyCatalog: MergedSkillCatalog = {
  all: [],
  resolveAction: () => NO_SKILL_ACTION,
};

function catalogWith(action: SkillAction): MergedSkillCatalog {
  return { all: ['optimize', 'database-migrations'], resolveAction: () => action };
}

/** A high-confidence, eligible, complete verdict (the canonical FIRE shape). */
function fireVerdict(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { process_fit: 0.2 },
    missing_piece: 'no plan for the refactor',
    risk_level: 'medium',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.8,
    primary_lever: 'process_fit',
    nudge: 'sketch the data contract and key views before diving in',
    ...over,
  });
}

let sid = 0;
function nextSession(): string {
  sid += 1;
  return `session-${sid}-${Math.random().toString(36).slice(2)}`;
}

function baseInput(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'refactor this whole module, it is a mess',
    transcript: ['earlier prompt one', 'earlier prompt two'],
    backend: mockBackend({ prospector: '0.9', judge: fireVerdict() }),
    skill: PROMPT_COACH_SKILL,
    state,
    catalog: emptyCatalog,
    capabilities: [],
    sessionId: nextSession(),
    now: () => 1_000_000,
    ...over,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runQualityCascade — liveness', () => {
  it('sentinel short-circuits with the canned reply (no LLM calls)', async () => {
    let called = false;
    const backend: LlmBackend = {
      configured: true,
      async complete() {
        called = true;
        return '0.9';
      },
    };
    const res = await runQualityCascade(
      baseInput({ prompt: 'when life gives you lemons', backend }),
    );
    expect(res).not.toBeNull();
    // The reply word-wraps in the banner, so assert a short UNBROKEN fragment (not the full
    // multi-word constant, which the panel splits across lines).
    expect(res!.tip).toContain('make lemonade!');
    expect(COACH_SENTINEL_REPLY).toContain('make lemonade!');
    expect(called).toBe(false); // short-circuit before any model call.
  });

  it('first-run TOUR is additive — appears even when the cascade stays silent', async () => {
    // A trivial prompt reflex-suppresses, but the once-per-install tour still surfaces when
    // the caller signals firstSeen (the install-wide tour trigger, passed as input).
    const res = await runQualityCascade(
      baseInput({ prompt: 'yes', transcript: [], firstSeen: true }),
    );
    expect(res).not.toBeNull();
    // Tour-specific, unbroken phrases (the banner soft-wraps, so assert short fragments).
    expect(res!.tip).toContain('Watch-first');
    expect(res!.tip).toContain('/coach find');
    expect(res!.tip).toContain('/coach status');
    expect(COACH_FIRST_RUN_TOUR).toContain('Watch-first');
  });
});

describe('runQualityCascade — early gates', () => {
  it('reflex suppression returns null for a trivial continuation (no ping after turn 1)', async () => {
    const sessionId = nextSession();
    // Prime turn 1 so the ping is consumed, then assert turn 2 trivial → null.
    await runQualityCascade(baseInput({ prompt: 'first real prompt here', sessionId }));
    const res = await runQualityCascade(
      baseInput({ prompt: 'yes', sessionId, transcript: ['first real prompt here'] }),
    );
    expect(res).toBeNull();
  });

  it('cooldown suppression returns null when within the quality cooldown (SAME session)', async () => {
    const sessionId = nextSession();
    // The cooldown is PER-SESSION: this session fired a tip 1 min ago → still suppressed.
    const state: CoachState = {
      ...defaultState(),
      lastQualityTipAt: 1_000_000,
      lastQualityTipBySession: { [sessionId]: 1_000_000 },
    };
    // Prime the ping on turn 1.
    await runQualityCascade(baseInput({ prompt: 'priming prompt', sessionId, state }));
    const res = await runQualityCascade(
      baseInput({
        sessionId,
        state,
        now: () => 1_000_000 + 60_000, // 1 min < 10 min cooldown.
        transcript: ['priming prompt'],
      }),
    );
    expect(res).toBeNull();
  });

  // The cooldown is PER-SESSION (judge-cascade.ts §3 comment: "the per-session quality
  // cooldown"). A REAL tip in session A must NOT suppress coaching in a DIFFERENT session B.
  // Before the fix, lastQualityTipAt was a single global value, so one session's tip silenced
  // coaching everywhere for 10 min — the cross-session "intro then nothing" bleed.
  it('a cooldown armed by session A does NOT suppress a DIFFERENT session B', async () => {
    const sessionA = nextSession();
    const sessionB = nextSession();
    // Session A fired a tip "just now"; the GLOBAL field is set, but only A is on cooldown.
    const state: CoachState = {
      ...defaultState(),
      lastQualityTipAt: 1_000_000,
      lastQualityTipBySession: { [sessionA]: 1_000_000 },
    };
    // Session B, well within A's 10-min window, with a coachable prompt → must NOT be gated.
    const res = await runQualityCascade(
      baseInput({
        prompt: 'refactor this whole module, it is a mess',
        sessionId: sessionB,
        state,
        now: () => 1_000_000 + 60_000, // 1 min after A's tip
        transcript: ['earlier prompt one', 'earlier prompt two'],
      }),
    );
    expect(res).not.toBeNull(); // B fires — A's cooldown does not bleed into B.
  });
});

describe('runQualityCascade — prospector tier', () => {
  it('prospector below the escalate band → silence (judge never called)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    let judgeCalled = false;
    const backend: LlmBackend = {
      configured: true,
      async complete(opts) {
        if (opts.model === 'sonnet') judgeCalled = true;
        return opts.model === 'haiku' ? '0.1' : fireVerdict();
      },
    };
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
    expect(judgeCalled).toBe(false);
  });

  it('prospector unparseable → fail-OPEN escalates to the judge (which fires)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: 'not a number', judge: fireVerdict() });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).not.toBeNull();
  });

  it('null prospector (backend unavailable) → silence', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: null, judge: fireVerdict() });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });
});

describe('runQualityCascade — judge tier', () => {
  it('judge malformed → silence (fail-CLOSED)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: 'this is not json at all' });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });

  it('null judge (backend unavailable) → silence', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: null });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });
});

describe('runQualityCascade — firing gate', () => {
  it('all conditions met → fires with the nudge text', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const res = await runQualityCascade(baseInput({ sessionId, transcript: ['prime'] }));
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('sketch the data contract');
  });

  it('same lever already used this session → suppressed', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const state: CoachState = {
      ...defaultState(),
      leversUsedBySession: { [sessionId]: ['process_fit'] },
    };
    const res = await runQualityCascade(
      baseInput({ sessionId, state, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });

  it('ineligible phase (correction) → suppressed even with high confidence', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({ phase: 'correction' }),
    });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });

  it('confidence below preRunConfidence → suppressed', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: fireVerdict({ confidence: 0.4 }) });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });

  it('empty missing_piece → suppressed (precision lever)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: fireVerdict({ missing_piece: null }) });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'] }),
    );
    expect(res).toBeNull();
  });
});

describe('runQualityCascade — §5.5.5 code gates', () => {
  it('5.5.5a launch-only drop: mid-session, a launch capability is never in the judge input', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const capture: { judgeUser?: string } = {};
    const backend = mockBackend({ prospector: '0.9', judge: fireVerdict() }, capture);
    const effortXhigh = CAPABILITY_CATALOG.find((c) => c.id === 'effort-xhigh')!;
    const planMode = CAPABILITY_CATALOG.find((c) => c.id === 'plan-mode')!;
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'], // mid-session
        capabilities: [effortXhigh, planMode],
      }),
    );
    expect(res).not.toBeNull();
    // The launch-only flag must not appear in what the judge was shown.
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).not.toContain('--effort xhigh');
    // The in-turn capability survives.
    expect(capture.judgeUser).toContain('Shift+Tab');
  });

  it('5.5.5a launch-only retained when NO transcript (fresh launch context)', async () => {
    const sessionId = nextSession();
    const capture: { judgeUser?: string } = {};
    const backend = mockBackend({ prospector: '0.9', judge: fireVerdict() }, capture);
    const worktree = CAPABILITY_CATALOG.find((c) => c.id === 'worktree')!;
    await runQualityCascade(
      baseInput({ backend, sessionId, transcript: [], capabilities: [worktree] }),
    );
    expect(capture.judgeUser).toContain('--worktree');
  });

  it('5.5.5c goal_clarity → no skill/capability attached (task not yet defined)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    // The judge recommends a how-to skill AND a capability, but goal_clarity forces both off.
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({
        primary_lever: 'goal_clarity',
        skill_fit: { candidate_skill: 'optimize', confidence: 0.9 },
        capability_fit: { candidate_capability: 'plan-mode', confidence: 0.9 },
        nudge: 'pin one concrete outcome and a definition of done first',
      }),
    });
    const planMode = CAPABILITY_CATALOG.find((c) => c.id === 'plan-mode')!;
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: catalogWith({ kind: 'run', skillId: 'optimize' }),
        capabilities: [planMode],
      }),
    );
    expect(res).not.toBeNull();
    // No cost clause, no skill/capability tail — just the pure nudge in the banner.
    expect(res!.tip).toContain('pin one concrete outcome');
    expect(res!.tip).not.toContain('uses extra usage');
  });

  it('5.5.5c expensive_multiagent dropped on a scope-first lever (acceptance_criteria)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    // scope_boundaries is ALSO an undefined-task lever (which nulls ALL capabilities), so
    // to ISOLATE the expensive-multiagent drop we use acceptance_criteria — a SCOPE_FIRST
    // lever that is NOT an undefined-task lever, so the capability path is reached and
    // only the expensive-drop applies.
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({
        primary_lever: 'acceptance_criteria',
        capability_fit: { candidate_capability: 'ultracode', confidence: 0.9 },
        nudge: 'name the definition of done for this sweep first',
      }),
    });
    const ultracode = CAPABILITY_CATALOG.find((c) => c.id === 'ultracode')!;
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        capabilities: [ultracode],
      }),
    );
    expect(res).not.toBeNull();
    // The expensive multi-agent capability was dropped → no expensive cost clause.
    expect(res!.tip).not.toContain('multi-agent cloud job');
  });

  it('5.5.5f nudge naming an UNAVAILABLE backticked capability → SILENCE', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    // The judge names `/design-sync` (a real capability) in backticks, but it is NOT in
    // the available list → fail-closed silence.
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({
        nudge: 'try `/design-sync` to push your design system',
      }),
    });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        capabilities: [], // /design-sync NOT available.
      }),
    );
    expect(res).toBeNull();
  });

  it('5.5.5f a backticked NON-capability token (a var/path) does NOT trip the gate', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({
        nudge: 'name what `userId` should resolve to before refactoring',
      }),
    });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'], capabilities: [] }),
    );
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('userId');
  });

  it('available backticked capability that IS in the list → fires with cost clause', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const ultrathink = CAPABILITY_CATALOG.find((c) => c.id === 'ultrathink')!; // billed
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({
        primary_lever: 'process_fit',
        capability_fit: { candidate_capability: 'ultrathink', confidence: 0.9 },
        nudge: 'add `ultrathink` to your prompt for this hard design problem',
      }),
    });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        capabilities: [ultrathink],
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('uses extra usage'); // billed cost clause appended.
  });
});

describe('runQualityCascade — local-context suppression gate (Part B)', () => {
  // A primed session (the first-prompt ping consumed) so the assertions isolate the
  // quality-fire vs suppression decision, never the additive liveness ping.
  async function primed(): Promise<string> {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    return sessionId;
  }

  // SUP-1 — plan-mode-on → process_fit (L01) silent.
  describe('SUP-1 process_fit + plan mode', () => {
    it('mode plan → SILENT', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({ sessionId, transcript: ['prime'], localContext: { mode: 'plan' } }),
      );
      expect(res).toBeNull();
    });

    it('planModeMandated true → SILENT (project enforces plan mode)', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          sessionId,
          transcript: ['prime'],
          localContext: { project: { planModeMandated: true } },
        }),
      );
      expect(res).toBeNull();
    });

    it('mode normal → FIRES', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({ sessionId, transcript: ['prime'], localContext: { mode: 'normal' } }),
      );
      expect(res).not.toBeNull();
      expect(res!.tip).toContain('sketch the data contract');
    });

    it('NO localContext → FIRES (today’s behavior)', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(baseInput({ sessionId, transcript: ['prime'] }));
      expect(res).not.toBeNull();
    });

    it('UNKNOWN control: localContext present but mode undefined → FIRES', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({ sessionId, transcript: ['prime'], localContext: {} }),
      );
      expect(res).not.toBeNull();
    });
  });

  // SUP-2 — testCmdDocumented → verification_path (V01) / acceptance_criteria (L05) silent.
  describe('SUP-2 verification/acceptance + testCmdDocumented', () => {
    it('verification_path + testCmdDocumented true → SILENT', async () => {
      const sessionId = await primed();
      const backend = mockBackend({
        prospector: '0.9',
        judge: fireVerdict({ primary_lever: 'verification_path', nudge: 'name a verification step' }),
      });
      const res = await runQualityCascade(
        baseInput({
          backend,
          sessionId,
          transcript: ['prime'],
          localContext: { project: { testCmdDocumented: true } },
        }),
      );
      expect(res).toBeNull();
    });

    it('acceptance_criteria + testCmdDocumented true → SILENT', async () => {
      const sessionId = await primed();
      const backend = mockBackend({
        prospector: '0.9',
        judge: fireVerdict({ primary_lever: 'acceptance_criteria', nudge: 'name the definition of done' }),
      });
      const res = await runQualityCascade(
        baseInput({
          backend,
          sessionId,
          transcript: ['prime'],
          localContext: { project: { testCmdDocumented: true } },
        }),
      );
      expect(res).toBeNull();
    });

    it('verification_path + testCmdDocumented null → FIRES (UNKNOWN never suppresses)', async () => {
      const sessionId = await primed();
      const backend = mockBackend({
        prospector: '0.9',
        judge: fireVerdict({ primary_lever: 'verification_path', nudge: 'name a verification step' }),
      });
      const res = await runQualityCascade(
        baseInput({
          backend,
          sessionId,
          transcript: ['prime'],
          localContext: { project: { testCmdDocumented: null } },
        }),
      );
      expect(res).not.toBeNull();
    });

    it('verification_path + absent project → FIRES', async () => {
      const sessionId = await primed();
      const backend = mockBackend({
        prospector: '0.9',
        judge: fireVerdict({ primary_lever: 'verification_path', nudge: 'name a verification step' }),
      });
      const res = await runQualityCascade(
        baseInput({ backend, sessionId, transcript: ['prime'], localContext: {} }),
      );
      expect(res).not.toBeNull();
    });
  });

  // SUP-3 — clean-branch → risk_awareness (L26) silent.
  describe('SUP-3 risk_awareness + git state', () => {
    function riskBackend(): LlmBackend {
      return mockBackend({
        prospector: '0.9',
        judge: fireVerdict({
          primary_lever: 'risk_awareness',
          risk_level: 'high',
          nudge: 'this is an irreversible op — make it reversible first',
        }),
      });
    }

    it('clean branch (onBranch true, dirty false) → SILENT', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          backend: riskBackend(),
          sessionId,
          transcript: ['prime'],
          localContext: { git: { onBranch: true, dirty: false, branch: 'feature/x' } },
        }),
      );
      expect(res).toBeNull();
    });

    it('dirty branch (onBranch true, dirty true) → FIRES', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          backend: riskBackend(),
          sessionId,
          transcript: ['prime'],
          localContext: { git: { onBranch: true, dirty: true, branch: 'main' } },
        }),
      );
      expect(res).not.toBeNull();
    });

    it('git null (UNKNOWN) → FIRES', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          backend: riskBackend(),
          sessionId,
          transcript: ['prime'],
          localContext: { git: null },
        }),
      );
      expect(res).not.toBeNull();
    });

    it('git onBranch null (UNKNOWN) → FIRES', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          backend: riskBackend(),
          sessionId,
          transcript: ['prime'],
          localContext: { git: { onBranch: null, dirty: false } },
        }),
      );
      expect(res).not.toBeNull();
    });

    it('no localContext → FIRES', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({ backend: riskBackend(), sessionId, transcript: ['prime'] }),
      );
      expect(res).not.toBeNull();
    });

    // item 7 CARVE-OUT: a clean branch does NOT undo a data-destructive op.
    it('clean branch + a DATA-DESTRUCTIVE prompt → still FIRES (branch is no undo for a DROP)', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          backend: riskBackend(),
          sessionId,
          prompt: 'DROP the users table in prod and re-run the migration',
          transcript: ['prime'],
          localContext: { git: { onBranch: true, dirty: false, branch: 'feature/x' } },
        }),
      );
      expect(res).not.toBeNull();
    });

    it('clean branch + innocent CODE-risk prompt → still SILENT (SUP-3 kept for code risk)', async () => {
      const sessionId = await primed();
      const res = await runQualityCascade(
        baseInput({
          backend: riskBackend(),
          sessionId,
          prompt: 'add a dropdown menu and drop me a note when it is done',
          transcript: ['prime'],
          localContext: { git: { onBranch: true, dirty: false, branch: 'feature/x' } },
        }),
      );
      expect(res).toBeNull();
    });
  });

  // A non-targeted lever is unaffected by any localContext.
  describe('non-targeted lever is unaffected', () => {
    it('goal_clarity + a clean branch + plan mode + testCmdDocumented → still FIRES', async () => {
      const sessionId = await primed();
      const backend = mockBackend({
        prospector: '0.9',
        judge: fireVerdict({
          primary_lever: 'goal_clarity',
          nudge: 'pin one concrete outcome and a definition of done first',
        }),
      });
      const res = await runQualityCascade(
        baseInput({
          backend,
          sessionId,
          transcript: ['prime'],
          localContext: {
            mode: 'plan',
            git: { onBranch: true, dirty: false },
            project: { testCmdDocumented: true, planModeMandated: true },
          },
        }),
      );
      expect(res).not.toBeNull();
      expect(res!.tip).toContain('pin one concrete outcome');
    });
  });

  // The additive first-run TOUR still surfaces even when the gate suppresses the tip.
  it('suppression preserves an additive first-run tour (tour-only, no coaching tip)', async () => {
    const sessionId = nextSession();
    const res = await runQualityCascade(
      baseInput({ sessionId, transcript: [], firstSeen: true, localContext: { mode: 'plan' } }),
    );
    expect(res).not.toBeNull();
    expect(res!.tip).toContain('Watch-first'); // the tour surfaces.
    expect(res!.tip).not.toContain('sketch the data contract'); // tip suppressed.
    expect(res!.lever).toBeUndefined(); // tour carries no lever.
  });
});

describe('runQualityCascade — M4 external-skill resolution (composeTip fallback)', () => {
  // The banner word-wraps + colors the tip, so assertions run on the PLAIN text:
  // ANSI stripped and all whitespace collapsed (the same reason the sentinel test
  // asserts an unbroken fragment).
  const plain = (s: string): string =>
    // eslint-disable-next-line no-control-regex
    s.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ');

  const PPTX_CANDIDATE = {
    name: 'pptx',
    description: 'Create and edit PowerPoint decks',
    install: '/plugin install pptx@anthropic-agent-skills',
    sourceUrl: 'https://github.com/anthropics/skills',
    trust: 'official',
    repoStars: 157657,
  } as const;

  function pptxVerdict(over: Partial<Record<string, unknown>> = {}): string {
    return fireVerdict({
      missing_piece: 'no deck-producing affordance named',
      skill_fit: { candidate_skill: 'pptx', confidence: 0.9 },
      nudge: 'the pptx skill would turn this quarterly report into the deck directly',
      ...over,
    });
  }

  it('names THIS task: fires with nudge + install command + sourceUrl + stars, no auto-exec', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: pptxVerdict() });
    const res = await runQualityCascade(
      baseInput({
        prompt: 'convert this quarterly report to a pptx deck',
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog, // resolves 'none' → external fallback engages.
        externalCandidates: [PPTX_CANDIDATE],
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).toContain('quarterly report');
    expect(plain(res!.tip)).toContain('/plugin install pptx@anthropic-agent-skills');
    expect(plain(res!.tip)).toContain('https://github.com/anthropics/skills');
    expect(plain(res!.tip)).toContain('★ 157657');
    // NEVER auto-installs / claims execution.
    expect(plain(res!.tip)).not.toContain('installing');
    expect(plain(res!.tip)).not.toContain('installed for you');
  });

  it('cap discipline: the external append is SKIPPED when it would bust NUDGE_CAP (tip still fires)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    // A nudge at exactly the 500-char cap: ANY appended review/install lines would
    // exceed it, so composeTip must skip the append rather than bust the cap.
    const longNudge = ('the pptx skill would turn this into the deck directly ' + 'pad '.repeat(200)).slice(0, 500);
    const backend = mockBackend({ prospector: '0.9', judge: pptxVerdict({ nudge: longNudge }) });
    const res = await runQualityCascade(
      baseInput({
        prompt: 'convert this quarterly report to a pptx deck',
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog, // resolves 'none' → external fallback engages...
        externalCandidates: [PPTX_CANDIDATE], // ...but the append would exceed the cap.
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).toContain('deck directly'); // the nudge itself still rides.
    expect(plain(res!.tip)).not.toContain('/plugin install'); // append skipped, not truncated.
    expect(plain(res!.tip)).not.toContain('review:');
  });

  it('installed-resolution precedence: resolveAction run → NO install/review lines', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: pptxVerdict() });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: catalogWith({ kind: 'run', skillId: 'pptx' }), // installed wins.
        externalCandidates: [PPTX_CANDIDATE],
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).not.toContain('install:');
    expect(plain(res!.tip)).not.toContain('review:');
    expect(plain(res!.tip)).not.toContain('/plugin install');
  });

  it('externalCandidates omitted → byte-identical to today (unresolved id stays a silent no-op)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: pptxVerdict() });
    const res = await runQualityCascade(
      baseInput({ backend, sessionId, transcript: ['prime'], catalog: emptyCatalog }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).not.toContain('/plugin install');
    expect(plain(res!.tip)).not.toContain('review:');
  });

  it('external fires ⇒ NO capability payload rides (no cost clause even with capability_fit)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const ultrathink = CAPABILITY_CATALOG.find((c) => c.id === 'ultrathink')!; // billed
    const backend = mockBackend({
      prospector: '0.9',
      judge: pptxVerdict({
        capability_fit: { candidate_capability: 'ultrathink', confidence: 0.9 },
      }),
    });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog,
        capabilities: [ultrathink],
        externalCandidates: [PPTX_CANDIDATE],
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).toContain('/plugin install pptx@anthropic-agent-skills');
    expect(plain(res!.tip)).not.toContain('uses extra usage'); // external occupies the skill slot.
  });

  it('UNDEFINED_TASK_LEVERS (goal_clarity) + external candidate → no external lines', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({
      prospector: '0.9',
      judge: pptxVerdict({
        primary_lever: 'goal_clarity',
        nudge: 'pin one concrete outcome and a definition of done first',
      }),
    });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog,
        externalCandidates: [PPTX_CANDIDATE],
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).toContain('pin one concrete outcome');
    expect(plain(res!.tip)).not.toContain('/plugin install');
  });

  it('judge hallucinating an id NOT in the candidate list → no external lines (fail-closed)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({
      prospector: '0.9',
      judge: pptxVerdict({ skill_fit: { candidate_skill: 'made-up-skill', confidence: 0.9 } }),
    });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog,
        externalCandidates: [PPTX_CANDIDATE],
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).not.toContain('/plugin install');
    expect(plain(res!.tip)).not.toContain('review:');
  });

  it('the external section rides the judge user-prompt when candidates are present', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const capture: { judgeUser?: string } = {};
    const backend = mockBackend({ prospector: '0.9', judge: fireVerdict() }, capture);
    await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        externalCandidates: [PPTX_CANDIDATE],
      }),
    );
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser).toContain('External skills (NOT installed');
    expect(capture.judgeUser).toContain('- pptx: Create and edit PowerPoint decks');
  });
});

describe('runQualityCascade — skill wins over capability', () => {
  it('skill action present → capability suppressed (skill wins)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const ultrathink = CAPABILITY_CATALOG.find((c) => c.id === 'ultrathink')!;
    const backend = mockBackend({
      prospector: '0.9',
      judge: fireVerdict({
        primary_lever: 'process_fit',
        skill_fit: { candidate_skill: 'optimize', confidence: 0.9 },
        capability_fit: { candidate_capability: 'ultrathink', confidence: 0.9 },
        nudge: 'run the optimize skill on this hot path',
      }),
    });
    const res = await runQualityCascade(
      baseInput({
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: catalogWith({ kind: 'run', skillId: 'optimize' }),
        capabilities: [ultrathink],
      }),
    );
    expect(res).not.toBeNull();
    // Skill won → no capability cost clause.
    expect(res!.tip).not.toContain('uses extra usage');
  });
});


describe('runQualityCascade — G-M4b community trust labeling in the tip appendix', () => {
  const ESC = String.fromCharCode(27);
  const plain = (s: string): string =>
    s.split(ESC).map((seg, i) => (i === 0 ? seg : seg.replace(/^\[[0-9;]*m/, ''))).join('').replace(/\s+/g, ' ');

  function pptxVerdictB(): string {
    return fireVerdict({
      missing_piece: 'no deck-producing affordance named',
      skill_fit: { candidate_skill: 'pptx', confidence: 0.9 },
      nudge: 'the pptx skill would turn this quarterly report into the deck directly',
    });
  }

  it('a COMMUNITY hit renders the labeled review line: (community · ★ N)', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: pptxVerdictB() });
    const res = await runQualityCascade(
      baseInput({
        prompt: 'convert this quarterly report to a pptx deck',
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog,
        externalCandidates: [
          {
            name: 'pptx',
            description: 'Community deck builder for PowerPoint files',
            install: '/plugin install pptx@claude-code-plugins-plus',
            sourceUrl: 'https://github.com/jeremylongshore/claude-code-plugins-plus-skills',
            trust: 'community',
            repoStars: 2467,
          },
        ],
      }),
    );
    expect(res).not.toBeNull();
    // The panel clips un-splittable tokens > 50 chars (pinned mailbox-format design),
    // so assert the label + URL prefix + the INTACT install command (space-wrapped).
    expect(plain(res!.tip)).toContain('review: https://github.com/jeremylongshore/');
    expect(plain(res!.tip)).toContain('(community · ★ 2467)');
    expect(plain(res!.tip)).toContain('install: /plugin install pptx@claude-code-plugins-plus');
  });

  it('an OFFICIAL hit renders byte-identical to pre-G-M4b: (★ N), no trust label', async () => {
    const sessionId = nextSession();
    await runQualityCascade(baseInput({ prompt: 'prime', sessionId }));
    const backend = mockBackend({ prospector: '0.9', judge: pptxVerdictB() });
    const res = await runQualityCascade(
      baseInput({
        prompt: 'convert this quarterly report to a pptx deck',
        backend,
        sessionId,
        transcript: ['prime'],
        catalog: emptyCatalog,
        externalCandidates: [
          {
            name: 'pptx',
            description: 'Create and edit PowerPoint decks',
            install: '/plugin install pptx@anthropic-agent-skills',
            sourceUrl: 'https://github.com/anthropics/skills',
            trust: 'official',
            repoStars: 157657,
          },
        ],
      }),
    );
    expect(res).not.toBeNull();
    expect(plain(res!.tip)).toContain('review: https://github.com/anthropics/skills (★ 157657)');
    expect(plain(res!.tip)).not.toContain('community');
  });
});
