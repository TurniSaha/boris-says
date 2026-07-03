/**
 * F-L21 — Offload file-heavy investigation to a subagent. VERDICT: ⚠ BLOCKED
 * (architecture-limited). This test does NOT pin a NEW firing clause (none is precision-
 * safe to build) — it PINS the SHIPPED suppressor that the naive form of this lever would
 * ERODE, so the BLOCKED decision is grounded in real, tested behavior rather than asserted.
 *
 * WHY BLOCKED (the precision wall, the survival condition):
 *  1. The load-bearing signal is NOT in the typed prompt. Whether a broad "audit/scan all
 *     the files" ask actually NEEDS a subagent depends on (a) how large the codebase is
 *     (codebase introspection — the judge sees no file count / repo size) and (b) how full
 *     the live context window already is (runtime token-budget state — the judge sees only
 *     typed prompts + the prior typed transcript, never the live context fill). "scan the
 *     auth code" could be 3 files or 300; the lever's whole value ("this will blow the main
 *     context") is a judgment the per-prompt judge architecturally cannot make.
 *  2. There is NO prompt-quality GAP to fire on. All nine rubric dimensions score a WEAKNESS
 *     in the prompt; a broad audit prompt can be perfectly well-formed (clear goal, bounded
 *     scope, named verification). "delegate this to a subagent" is a tool/efficiency tip on
 *     a GOOD prompt — exactly the "this could be marginally better" case the firing bar
 *     explicitly forbids ("a senior PM would stop you", NOT "this could be marginally better").
 *  3. A firing clause would INVERT a deliberately-placed, precision-tested guard: JUDGE_SYSTEM
 *     already says "Never recommend an expensive multi-agent capability for an unbounded task —
 *     scope it before parallelizing", and judge-cascade SCOPE_FIRST_LEVERS DROPS an
 *     expensive_multiagent capability on a scope_boundaries / acceptance_criteria lever. A
 *     broad "audit everything" ask is frequently exactly an UNBOUNDED task, so the shipped
 *     policy is: scope it first, do NOT parallelize. The `ultracode` capability (the multi-
 *     agent fan-out affordance this lever maps to) is `expensive_multiagent`; recommending
 *     it on a broad/unbounded scan is what the shipped guard suppresses.
 *  4. A bare "audit/scan/check-all-files" keyword trigger is GRAMMAR, not PROCESS — precisely
 *     the anti-pattern the prospector was fixed against ("judge the PROCESS, not the grammar").
 *
 * So there is no cheap precision-safe clause to add and no probe/hook/miner signal that
 * recovers the missing repo-size / context-fill facts. REVISIT if a codebase-size or live
 * context-budget signal is ever added to the judge input.
 *
 * This is a DETERMINISTIC CONTRACT / PINNING test over the SHIPPING cascade
 * (runQualityCascade) — no live model. The judge tier is a stub returning the crafted
 * verdict; the prospector returns 0.9 to escalate.
 */
import { describe, it, expect } from 'vitest';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL, JUDGE_SYSTEM } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import { CAPABILITY_CATALOG, type Capability } from '../src/capability/catalog.js';

const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

/** The multi-agent fan-out affordance this lever would map to (expensive_multiagent). */
const ULTRACODE: Capability =
  CAPABILITY_CATALOG.find((c) => c.id === 'ultracode') ??
  (() => {
    throw new Error('ultracode capability missing from catalog');
  })();

/**
 * A verdict on a broad, UNBOUNDED "audit everything" ask, scored on scope_boundaries, that
 * (wrongly, for the naive lever) recommends the `ultracode` multi-agent capability. The
 * SHIPPED SCOPE_FIRST_LEVERS guard must DROP that capability — proving the lever's naive
 * form (recommend a subagent on a broad scan) is already suppressed by design.
 */
function broadScanVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { scope_boundaries: 0.1 },
    missing_piece: 'an unbounded audit of the whole codebase with no scoped target',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: 'ultracode', confidence: 0.85 },
    interrupt: true,
    confidence: 0.85,
    primary_lever: 'scope_boundaries',
    nudge: 'name the one subsystem and the single thing this audit is checking for first',
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
  return `fl21-${sid}`;
}

function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  const state: CoachState = defaultState();
  return {
    prompt: 'audit and scan all the files in the codebase for unhandled promise rejections',
    transcript: ['earlier prompt'],
    backend: backend(broadScanVerdict()),
    skill: PROMPT_COACH_SKILL,
    state,
    catalog: emptyCatalog,
    capabilities: [ULTRACODE],
    sessionId: nextSession(),
    now: () => 1_000_000,
    ...over,
  };
}

/** Consume the additive first-seen ping so later turns isolate the fire/silence decision. */
async function primed(sessionId: string): Promise<void> {
  await runQualityCascade(input({ prompt: 'prime', sessionId }));
}

describe('F-L21 — subagent-offload (BLOCKED: architecture-limited)', () => {
  // ── (1) The affordance EXISTS: the catalog already carries the multi-agent fan-out
  //    capability this lever would map to — so the BLOCK is about PRECISION, not a missing
  //    affordance. ───────────────────────────────────────────────────────────────────────
  it('the multi-agent fan-out affordance (ultracode) already exists in the catalog', () => {
    expect(ULTRACODE).toBeDefined();
    expect(ULTRACODE.costClass).toBe('expensive_multiagent');
    // Its `when` already names the broad-audit/sweep use-case — the knowledge is present.
    expect(`${ULTRACODE.what} ${ULTRACODE.when}`.toLowerCase()).toMatch(/audit|sweep|fan-out|multi-agent/);
  });

  // ── (2) THE SHIPPED GUARD THE NAIVE LEVER WOULD ERODE: on a broad/unbounded "audit
  //    everything" ask scored on scope_boundaries, the expensive multi-agent capability is
  //    DROPPED (SCOPE_FIRST_LEVERS) — the coach does NOT tell the dev to parallelize an
  //    unbounded scan. This is exactly the behavior an F-L21 "offload to a subagent" clause
  //    would invert, which is why building it is not precision-safe. ───────────────────────
  it('does NOT recommend a multi-agent subagent on a broad UNBOUNDED scan (scope-first guard)', async () => {
    const sessionId = nextSession();
    await primed(sessionId);
    const res = await runQualityCascade(input({ sessionId, transcript: ['prime'] }));
    // The scope_boundaries nudge may still fire (scope it!), but the ultracode capability
    // must NOT ride: no 'ultracode' token and no expensive-cost clause in the tip.
    if (res !== null) {
      expect(res.tip.toLowerCase()).not.toContain('ultracode');
      expect(res.tip.toLowerCase()).not.toContain('multi-agent');
      expect(res.lever).toBe('scope_boundaries');
    }
  });

  // ── (3) THE POLICY IS ENCODED: the frozen JUDGE_SYSTEM carries the scope-first-before-
  //    parallelize guard verbatim. A new "offload to a subagent" firing clause would
  //    contradict this line — the textual proof the lever is not precision-safe to add. ───
  it('JUDGE_SYSTEM encodes the scope-first-before-parallelize guard (the contradiction)', () => {
    expect(JUDGE_SYSTEM).toContain('Never recommend an expensive multi-agent capability for an unbounded task');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('scope it before parallelizing');
  });

  // ── (4) NO NEW FIRING CLAUSE WAS ADDED: the BLOCKED verdict means we did NOT fake a
  //    keyword-triggered subagent-offload clause into the shared judge prompt. ────────────
  it('JUDGE_SYSTEM does NOT contain a faked subagent-offload / file-heavy firing clause', () => {
    const lc = JUDGE_SYSTEM.toLowerCase();
    expect(lc).not.toContain('subagent-offload');
    expect(lc).not.toContain('offload file-heavy');
    expect(lc).not.toContain('file-heavy investigation');
  });
});
