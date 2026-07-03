/**
 * F-FEEDBACK — live self-tuning from owner 👍/👎 ratings on real fires.
 *
 * STORY: after a 🐾 tip, the owner rates it (/coach 👍 or 👎). Once a lever has ≥N ratings,
 * its firing-confidence floor adapts: 👎-heavy → fires LESS, 👍-loved → fires MORE (bounded).
 * Each rated fire is also appended to a local feedback-anchor corpus for the offline eval.
 * /coach undo reverts the last rating. A single rating never swings firing ("after N ratings").
 *
 * Pins: the pure adaptive-floor math, the store rate/undo, the cascade's adaptive gate, and
 * the coach-cmd 👍/👎/undo subcommands + corpus append. Deterministic, no live model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStore,
  defaultState,
  adaptiveFloorDelta,
  FEEDBACK_MIN_RATINGS,
  FEEDBACK_MAX_DELTA,
  type CoachState,
  type LastTip,
} from '../src/state/store.js';
import { runQualityCascade, type MergedSkillCatalog, type QualityCascadeInput } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL } from '../src/brain/prompt-coach-skill.js';
import { runCoachCmd, type FeedbackAnchor } from '../src/coach-cmd.js';
import { createPatternsStore } from '../src/habit/patterns-store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

let baseDir: string;
beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'coach-fb-')); });
afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

// ── the pure adaptive-floor math ────────────────────────────────────────────
describe('F-FEEDBACK — adaptiveFloorDelta (pure)', () => {
  it('returns 0 below the minimum rating count (no single-rating swing)', () => {
    expect(adaptiveFloorDelta(undefined)).toBe(0);
    expect(adaptiveFloorDelta({ good: 1, bad: 0 })).toBe(0); // 1 < N
    expect(adaptiveFloorDelta({ good: 0, bad: FEEDBACK_MIN_RATINGS - 1 })).toBe(0);
  });

  it('all-👎 at ≥N ratings raises the floor by +MAX (fires less)', () => {
    expect(adaptiveFloorDelta({ good: 0, bad: FEEDBACK_MIN_RATINGS })).toBeCloseTo(FEEDBACK_MAX_DELTA, 5);
  });

  it('all-👍 at ≥N ratings lowers the floor by -MAX (fires more)', () => {
    expect(adaptiveFloorDelta({ good: FEEDBACK_MIN_RATINGS, bad: 0 })).toBeCloseTo(-FEEDBACK_MAX_DELTA, 5);
  });

  it('mixed ratings scale between, and the delta is bounded to ±MAX', () => {
    const d = adaptiveFloorDelta({ good: 2, bad: 4 }); // net +1/3
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(FEEDBACK_MAX_DELTA);
    expect(adaptiveFloorDelta({ good: 0, bad: 100 })).toBeLessThanOrEqual(FEEDBACK_MAX_DELTA);
  });

  it('exactly-balanced ratings at ≥N (net 0) → delta exactly 0 (no spurious shift)', () => {
    // The net=0 edge: equal 👍/👎 above the threshold must leave the floor at the base.
    expect(adaptiveFloorDelta({ good: 3, bad: 3 })).toBe(0);
    expect(adaptiveFloorDelta({ good: 5, bad: 5 })).toBe(0);
  });
});

// ── the store rate / undo ───────────────────────────────────────────────────
describe('F-FEEDBACK — store rate/undo', () => {
  const tip: LastTip = { lever: 'process_fit', prompt: 'do the big thing', sessionId: 's1', at: 1000 };

  it('rateLastTip increments the lever tally, clears lastTip, returns the rated tip', () => {
    const store = createStore(baseDir);
    store.recordLastTip(tip);
    const r = store.rateLastTip('bad');
    expect(r).toEqual({ tip, rating: 'bad' });
    expect(store.getState().feedbackByLever['process_fit']).toEqual({ good: 0, bad: 1 });
    expect(store.getState().lastTip).toBeNull(); // one rating per tip.
  });

  it('rateLastTip returns null when there is no last tip', () => {
    expect(createStore(baseDir).rateLastTip('good')).toBeNull();
  });

  it('undoLastRating reverts the tally and restores lastTip for re-rating', () => {
    const store = createStore(baseDir);
    store.recordLastTip(tip);
    store.rateLastTip('bad');
    const u = store.undoLastRating();
    expect(u).toEqual({ lever: 'process_fit', rating: 'bad' });
    expect(store.getState().feedbackByLever['process_fit']).toEqual({ good: 0, bad: 0 });
    expect(store.getState().lastTip).toEqual(tip); // restored so it can be re-rated.
  });

  it('floorDeltaForLever reflects accumulated ratings (≥N 👎 → positive delta)', () => {
    const store = createStore(baseDir);
    for (let i = 0; i < FEEDBACK_MIN_RATINGS; i += 1) {
      store.recordLastTip(tip);
      store.rateLastTip('bad');
    }
    expect(store.floorDeltaForLever('process_fit')).toBeGreaterThan(0);
  });

  it('forward-compat: an OLD state file with no feedback fields merges to empty defaults', () => {
    const store = createStore(baseDir);
    expect(store.getState().feedbackByLever).toEqual({});
    expect(store.getState().lastTip).toBeNull();
  });
});

// ── the cascade adaptive gate ───────────────────────────────────────────────
const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };
function fireVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'new-task', dimension_scores: { process_fit: 0.2 }, missing_piece: 'no plan',
    risk_level: 'medium', skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 }, interrupt: true,
    confidence: 0.65, primary_lever: 'process_fit', nudge: 'sketch the plan first', ...over,
  });
}
function backend(judge: string): LlmBackend {
  return { configured: true, async complete(o: LlmCompleteOptions) { return o.model === 'haiku' ? '0.9' : judge; } };
}
let sid = 0;
function input(state: CoachState, over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
  sid += 1;
  return {
    prompt: 'refactor the whole module', transcript: ['prime'], backend: backend(fireVerdict()),
    skill: PROMPT_COACH_SKILL, state, catalog: emptyCatalog, capabilities: [],
    sessionId: `fb-${sid}`, now: () => 1_000_000, ...over,
  };
}
async function primed(state: CoachState, sessionId: string): Promise<void> {
  await runQualityCascade(input(state, { prompt: 'prime', sessionId }));
}

describe('F-FEEDBACK — cascade adaptive firing gate', () => {
  it('a verdict at confidence 0.85 FIRES at the BALANCED base floor 0.8 (no feedback)', async () => {
    const state = defaultState();
    const sessionId = 'fb-base';
    await primed(state, sessionId);
    const res = await runQualityCascade(
      input(state, { sessionId, transcript: ['prime'], backend: backend(fireVerdict({ confidence: 0.85 })) }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });

  it('the SAME 0.85 verdict is SUPPRESSED at the base floor when just below it (0.75)', async () => {
    // A verdict below the 0.8 base floor is suppressed with no feedback delta.
    const state = defaultState();
    const sessionId = 'fb-below';
    await primed(state, sessionId);
    const res = await runQualityCascade(
      input(state, { sessionId, transcript: ['prime'], backend: backend(fireVerdict({ confidence: 0.75 })) }),
    );
    expect(res).toBeNull();
  });

  it('after ≥N 👎 on process_fit, a 0.85 verdict is SUPPRESSED (floor raised past it)', async () => {
    // base 0.8 + MAX_DELTA(0.2) = 1.0 > 0.85 → suppressed.
    const state: CoachState = {
      ...defaultState(),
      feedbackByLever: { process_fit: { good: 0, bad: FEEDBACK_MIN_RATINGS } },
    };
    const sessionId = 'fb-down';
    await primed(state, sessionId);
    const res = await runQualityCascade(
      input(state, { sessionId, transcript: ['prime'], backend: backend(fireVerdict({ confidence: 0.85 })) }),
    );
    expect(res).toBeNull();
  });

  it('after ≥N 👍, a verdict just BELOW the base floor (0.65) now FIRES (floor lowered)', async () => {
    const state: CoachState = {
      ...defaultState(),
      feedbackByLever: { process_fit: { good: FEEDBACK_MIN_RATINGS, bad: 0 } },
    };
    // base 0.8 - MAX_DELTA(0.2) = 0.6 → a 0.65 verdict clears it.
    const sessionId = 'fb-up';
    await primed(state, sessionId);
    const res = await runQualityCascade(
      input(state, { sessionId, transcript: ['prime'], backend: backend(fireVerdict({ confidence: 0.65 })) }),
    );
    expect(res).not.toBeNull();
    expect(res!.lever).toBe('process_fit');
  });
});

// ── the coach-cmd 👍/👎/undo + corpus append ─────────────────────────────────
describe('F-FEEDBACK — /coach 👍/👎/undo command', () => {
  function deps(extra: Partial<Parameters<typeof runCoachCmd>[1]> = {}) {
    const out: string[] = [];
    const anchors: FeedbackAnchor[] = [];
    const store = createStore(baseDir);
    return {
      out, anchors, store,
      d: {
        store,
        patterns: createPatternsStore(baseDir),
        env: {},
        now: 2000,
        claudeOnPath: () => false,
        out: (l: string) => out.push(l),
        recordFeedbackAnchor: (a: FeedbackAnchor) => anchors.push(a),
        ...extra,
      },
    };
  }

  it('👎 records a bad rating + a SILENT-gold feedback anchor', () => {
    const { out, anchors, store, d } = deps();
    store.recordLastTip({ lever: 'risk_awareness', prompt: 'drop the table', sessionId: 's', at: 1 });
    runCoachCmd('👎', d);
    expect(store.getState().feedbackByLever['risk_awareness']).toEqual({ good: 0, bad: 1 });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ lever: 'risk_awareness', rating: 'bad', goldVerdict: 'SILENT' });
    expect(out.join(' ')).toContain('👎');
  });

  it('👍 (alias "good") records a good rating + a NUDGE-gold anchor', () => {
    const { anchors, store, d } = deps();
    store.recordLastTip({ lever: 'verification_path', prompt: 'ship it', sessionId: 's', at: 1 });
    runCoachCmd('good', d);
    expect(store.getState().feedbackByLever['verification_path']).toEqual({ good: 1, bad: 0 });
    expect(anchors[0]).toMatchObject({ rating: 'good', goldVerdict: 'NUDGE' });
  });

  it('👍/👎 with no recent tip prints a friendly no-op (does not crash)', () => {
    const { out, anchors, d } = deps();
    runCoachCmd('👍', d);
    expect(anchors).toHaveLength(0);
    expect(out.join(' ').toLowerCase()).toContain('no recent tip');
  });

  it('undo reverts the last rating', () => {
    const { store, d } = deps();
    store.recordLastTip({ lever: 'process_fit', prompt: 'p', sessionId: 's', at: 1 });
    runCoachCmd('👎', d);
    runCoachCmd('undo', d);
    expect(store.getState().feedbackByLever['process_fit']).toEqual({ good: 0, bad: 0 });
  });

  it('status reports per-lever feedback once ratings exist', () => {
    const { out, store, d } = deps();
    store.recordLastTip({ lever: 'process_fit', prompt: 'p', sessionId: 's', at: 1 });
    runCoachCmd('👎', d);
    runCoachCmd('status', d);
    expect(out.join('\n')).toContain('feedback (per lever');
    expect(out.join('\n')).toContain('process_fit');
  });

  it('unknown subcommand prints the updated usage (includes 👍/👎/undo)', () => {
    const { out, d } = deps();
    runCoachCmd('wat', d);
    expect(out.join(' ')).toContain('👍');
    expect(out.join(' ')).toContain('undo');
  });
});
