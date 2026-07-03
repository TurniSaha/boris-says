/**
 * M5 "critiques only after watching" — Step 1: the PURE watch-window state machine
 * (src/state/watch.ts) + the three store methods that persist it.
 *
 * The window rule (GOAL.md feature #4): critique levers are OBSERVE-ONLY until the dev
 * has been watched for >= 3 sessions AND >= 30 typed prompts (whichever comes SECOND).
 * Withheld verdicts are logged (capped) for /coach status. An install whose state
 * already shows engagement (ratings / greeted sessions / prior tips) is migrated to
 * "window already closed + announced" so the owner's machine sees ZERO behavior change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WATCH_MIN_SESSIONS,
  WATCH_MIN_PROMPTS,
  WATCH_SESSIONS_CAP,
  WITHHELD_LOG_CAP,
  WITHHELD_TEXT_CAP,
  OPPORTUNITY_LEVERS,
  freshWatch,
  preClosedWatch,
  stateShowsEngagement,
  resolveWatch,
  recordObservation,
  windowClosed,
  appendWithheld,
  isCritiqueLever,
  announceMessage,
  type WatchState,
} from '../src/state/watch.js';
import {
  createStore,
  defaultState,
  writeJsonAtomic,
  type CoachState,
} from '../src/state/store.js';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-watch-'));
});
afterEach(() => {
  // Restore write perms in case a test flipped them (see the save-failure test).
  try {
    chmodSync(baseDir, 0o755);
  } catch {
    /* already writable */
  }
  rmSync(baseDir, { recursive: true, force: true });
});

/** Observe `prompts` typed prompts spread round-robin across `sessions` session ids. */
function observeMany(watch: WatchState, sessions: readonly string[], prompts: number, t = 1000): WatchState {
  let w = watch;
  for (let i = 0; i < prompts; i += 1) {
    w = recordObservation(w, sessions[i % sessions.length], t + i);
  }
  return w;
}

describe('watch window rule — closed iff >=3 sessions AND >=30 prompts (whichever comes second)', () => {
  it('constants match the spec', () => {
    expect(WATCH_MIN_SESSIONS).toBe(3);
    expect(WATCH_MIN_PROMPTS).toBe(30);
  });

  it('30 prompts in ONE marathon session → still OPEN (no cross-session baseline yet)', () => {
    const w = observeMany(freshWatch(), ['s1'], 30);
    expect(windowClosed(w)).toBe(false);
    expect(w.promptsObserved).toBe(30);
    expect(w.sessionsObserved).toEqual(['s1']);
  });

  it('3 sessions x 2 prompts → still OPEN (too few observations)', () => {
    const w = observeMany(freshWatch(), ['s1', 's2', 's3'], 6);
    expect(windowClosed(w)).toBe(false);
    expect(w.closedAt).toBeNull();
  });

  it('3 sessions AND 30 prompts → CLOSED with closedAt set to the closing observation', () => {
    const w = observeMany(freshWatch(), ['s1', 's2', 's3'], 30, 1000);
    expect(windowClosed(w)).toBe(true);
    expect(w.closedAt).toBe(1000 + 29); // the 30th observation's clock closed it.
    expect(w.announced).toBe(false); // announce is a SEPARATE step.
  });

  it('counters FREEZE once closed (a later observation changes nothing)', () => {
    const closed = observeMany(freshWatch(), ['s1', 's2', 's3'], 30);
    const after = recordObservation(recordObservation(closed, 's9', 99_999), 's10', 99_999);
    expect(after).toEqual(closed);
    expect(after.promptsObserved).toBe(30);
  });

  it('sessionsObserved dedupes repeat session ids', () => {
    const w = observeMany(freshWatch(), ['s1'], 5);
    expect(w.sessionsObserved).toEqual(['s1']);
  });

  it('sessionsObserved caps at WATCH_SESSIONS_CAP', () => {
    let w = freshWatch();
    for (let i = 0; i < WATCH_SESSIONS_CAP + 5; i += 1) {
      w = recordObservation(w, `sess-${i}`, 1000 + i);
    }
    expect(w.sessionsObserved.length).toBeLessThanOrEqual(WATCH_SESSIONS_CAP);
  });

  it('a blank session id never lands in sessionsObserved', () => {
    const w = recordObservation(freshWatch(), '', 1000);
    expect(w.sessionsObserved).toEqual([]);
    expect(w.promptsObserved).toBe(1); // the prompt still counts as an observation.
  });
});

describe('withheld log — capped ring with a running total', () => {
  function entry(i: number, tip = `tip-${i}`, prompt = `prompt-${i}`) {
    return { lever: `lever-${i}`, tip, prompt, at: 1000 + i };
  }

  it('12 appends → last 10 kept (newest), withheldCount runs to 12', () => {
    let w = freshWatch();
    for (let i = 0; i < 12; i += 1) w = appendWithheld(w, entry(i));
    expect(w.withheld).toHaveLength(WITHHELD_LOG_CAP);
    expect(w.withheldCount).toBe(12);
    expect(w.withheld[0].lever).toBe('lever-2'); // oldest two rolled off.
    expect(w.withheld[WITHHELD_LOG_CAP - 1].lever).toBe('lever-11'); // newest kept.
  });

  it('tip + prompt text fields are sliced to WITHHELD_TEXT_CAP', () => {
    const long = 'x'.repeat(WITHHELD_TEXT_CAP * 3);
    const w = appendWithheld(freshWatch(), { lever: 'process_fit', tip: long, prompt: long, at: 1 });
    expect(w.withheld[0].tip.length).toBeLessThanOrEqual(WITHHELD_TEXT_CAP);
    expect(w.withheld[0].prompt.length).toBeLessThanOrEqual(WITHHELD_TEXT_CAP);
  });

  it('ANSI banner escapes are stripped so the /coach status peek is readable', () => {
    const banner = '\x1b[1;38;5;231;48;5;33m  a coaching tip  \x1b[0m';
    const w = appendWithheld(freshWatch(), { lever: 'process_fit', tip: banner, prompt: 'p', at: 1 });
    expect(w.withheld[0].tip).not.toContain('\x1b');
    expect(w.withheld[0].tip).toContain('a coaching tip');
  });
});

describe('lever classification — opportunity fires day one, everything else observes (fail-closed)', () => {
  const CRITIQUE_LEVERS = [
    'goal_clarity',
    'scope_boundaries',
    'context_sufficiency',
    'process_fit',
    'acceptance_criteria',
    'risk_awareness',
    'verification_path',
    'effort_level_fit',
  ];

  it('all 8 prompt-quality levers are critique', () => {
    for (const lever of CRITIQUE_LEVERS) expect(isCritiqueLever(lever), lever).toBe(true);
  });

  it('skill_fit and primitive_fit are opportunity (day-one)', () => {
    expect(OPPORTUNITY_LEVERS.has('skill_fit')).toBe(true);
    expect(OPPORTUNITY_LEVERS.has('primitive_fit')).toBe(true);
    expect(isCritiqueLever('skill_fit')).toBe(false);
    expect(isCritiqueLever('primitive_fit')).toBe(false);
  });

  it('an unknown/future lever id is critique (fail-closed: precision over recall)', () => {
    expect(isCritiqueLever('future_lever')).toBe(true);
  });
});

describe('migration — a null watch resolves from the engagement markers', () => {
  it('fresh defaultState() → OPEN window (the full watch-first experience)', () => {
    const w = resolveWatch(defaultState(), 5000);
    expect(windowClosed(w)).toBe(false);
    expect(w.promptsObserved).toBe(0);
    expect(w.announced).toBe(false);
  });

  it('a REAL legacy state.json (ratings + greeted sessions, NO watch key) parses and pre-closes', () => {
    // The owner's install shape: months of ratings and greeted sessions on disk.
    writeJsonAtomic(join(baseDir, 'state.json'), {
      enabled: true,
      lastQualityTipAt: 1_700_000_000_000,
      lastQualityTipBySession: { 'sess-old': 1_700_000_000_000 },
      leversUsedBySession: { 'sess-old': ['process_fit'] },
      feedbackByLever: { process_fit: { good: 4, bad: 2 } },
      greetedSessions: ['sess-old', 'sess-older'],
      // legacy retired keys ride along untouched:
      l34bLastNudgedInsertions: 320,
    });
    const s = createStore(baseDir).getState();
    expect(s.watch).toBeNull(); // the legacy file has no watch — default null.
    const w = resolveWatch(s, 9000);
    expect(windowClosed(w)).toBe(true);
    expect(w.announced).toBe(true); // the owner NEVER sees the announce.
  });

  it('EACH engagement marker alone pre-closes the window', () => {
    const base = defaultState();
    const engaged: Array<Partial<CoachState>> = [
      { feedbackByLever: { process_fit: { good: 1, bad: 0 } } },
      { lastTip: { lever: 'process_fit', prompt: 'p', sessionId: 's', at: 1 } },
      {
        lastRating: {
          lever: 'process_fit',
          rating: 'good',
          tip: { lever: 'process_fit', prompt: 'p', sessionId: 's', at: 1 },
        },
      },
      { lastQualityTipAt: 123 },
      { greetedSessions: ['s1'] },
      { lastQualityTipBySession: { s1: 123 } },
      { leversUsedBySession: { s1: ['goal_clarity'] } },
    ];
    for (const marker of engaged) {
      const state: CoachState = { ...base, ...marker };
      expect(stateShowsEngagement(state), JSON.stringify(marker)).toBe(true);
      expect(windowClosed(resolveWatch(state, 1)), JSON.stringify(marker)).toBe(true);
    }
    expect(stateShowsEngagement(base)).toBe(false);
  });

  it('an EXPLICIT persisted watch always wins over the engagement heuristic', () => {
    // Once the fresh install materializes its open window, later engagement (greets,
    // opportunity-tip ratings) must NOT retro-close it.
    const open = observeMany(freshWatch(), ['s1'], 5);
    const state: CoachState = { ...defaultState(), greetedSessions: ['s1'], watch: open };
    expect(windowClosed(resolveWatch(state, 1))).toBe(false);
  });

  it('preClosedWatch is closed + announced with zero counters', () => {
    const w = preClosedWatch(777);
    expect(w.closedAt).toBe(777);
    expect(w.announced).toBe(true);
    expect(w.promptsObserved).toBe(0);
    expect(w.withheldCount).toBe(0);
  });
});

describe('state back-compat pin — legacy state.json round-trips unchanged apart from watch', () => {
  it('a legacy partial merges over defaults, saves, and re-reads with every field intact', () => {
    const legacyPartial = {
      enabled: false,
      lastMinedWatermark: 42,
      greetedSessions: ['a', 'b'],
      feedbackByLever: { goal_clarity: { good: 1, bad: 2 } },
    };
    writeJsonAtomic(join(baseDir, 'state.json'), legacyPartial);
    const store = createStore(baseDir);
    const first = store.getState();
    expect(first.enabled).toBe(false);
    expect(first.lastMinedWatermark).toBe(42);
    expect(first.greetedSessions).toEqual(['a', 'b']);
    expect(first.feedbackByLever).toEqual({ goal_clarity: { good: 1, bad: 2 } });
    expect(first.watch).toBeNull(); // the only new field, defaulted.
    store.saveState(first);
    expect(createStore(baseDir).getState()).toEqual(first);
  });
});

describe('store.observeWatch — migration-aware counting, persisted, never throws', () => {
  it('a fresh install counts prompt 1 into an OPEN window and PERSISTS it', () => {
    const store = createStore(baseDir);
    const w = store.observeWatch('sess-1', 1000);
    expect(windowClosed(w)).toBe(false);
    expect(w.promptsObserved).toBe(1);
    expect(w.sessionsObserved).toEqual(['sess-1']);
    // Persisted: a brand-new store instance over the same dir sees it.
    expect(createStore(baseDir).getState().watch).toEqual(w);
  });

  it('an engaged legacy install (null watch) materializes as pre-closed — no counting', () => {
    const store = createStore(baseDir);
    store.saveState({ ...defaultState(), greetedSessions: ['old-sess'] });
    const w = store.observeWatch('sess-new', 2000);
    expect(windowClosed(w)).toBe(true);
    expect(w.announced).toBe(true);
    expect(w.promptsObserved).toBe(0); // frozen — never counted.
  });

  it('closes the window on the observation that satisfies BOTH thresholds', () => {
    const store = createStore(baseDir);
    store.saveState({
      ...defaultState(),
      watch: { ...observeMany(freshWatch(), ['s1', 's2', 's3'], 29), closedAt: null },
    });
    const w = store.observeWatch('s3', 7777);
    expect(w.promptsObserved).toBe(30);
    expect(windowClosed(w)).toBe(true);
    expect(w.closedAt).toBe(7777);
    expect(w.announced).toBe(false); // announce is the judge's job, later.
  });

  it('NEVER throws when the underlying save fails (returns the computed value unpersisted)', () => {
    const store = createStore(baseDir);
    store.observeWatch('s1', 1000); // materialize state.json while writable.
    chmodSync(baseDir, 0o555); // now make every write fail.
    let w: WatchState | undefined;
    expect(() => {
      w = store.observeWatch('s1', 2000);
    }).not.toThrow();
    expect(w?.promptsObserved).toBe(2); // computed, just not persisted.
    chmodSync(baseDir, 0o755);
    expect(store.getState().watch?.promptsObserved).toBe(1); // the failed write never landed.
  });
});

describe('store.recordWithheldTip — capped log persisted', () => {
  it('appends, counts, and caps across store instances', () => {
    const store = createStore(baseDir);
    for (let i = 0; i < WITHHELD_LOG_CAP + 2; i += 1) {
      store.recordWithheldTip({ lever: 'process_fit', tip: `tip-${i}`, prompt: `p-${i}`, at: 100 + i });
    }
    const w = createStore(baseDir).getState().watch;
    expect(w?.withheldCount).toBe(WITHHELD_LOG_CAP + 2);
    expect(w?.withheld).toHaveLength(WITHHELD_LOG_CAP);
    expect(w?.withheld[WITHHELD_LOG_CAP - 1].tip).toContain(`tip-${WITHHELD_LOG_CAP + 1}`);
  });

  it('never throws when the save fails', () => {
    const store = createStore(baseDir);
    store.observeWatch('s1', 1000);
    chmodSync(baseDir, 0o555);
    expect(() =>
      store.recordWithheldTip({ lever: 'l', tip: 't', prompt: 'p', at: 1 }),
    ).not.toThrow();
    chmodSync(baseDir, 0o755);
  });
});

describe('store.markAnnouncedIfFirst — true exactly once, only after close', () => {
  it('false while the window is still open', () => {
    const store = createStore(baseDir);
    store.observeWatch('s1', 1000); // open window materialized.
    expect(store.markAnnouncedIfFirst(2000)).toBe(false);
    expect(store.getState().watch?.announced).toBe(false);
  });

  it('true exactly once after close; false forever after', () => {
    const store = createStore(baseDir);
    store.saveState({
      ...defaultState(),
      watch: observeMany(freshWatch(), ['s1', 's2', 's3'], 30),
    });
    expect(store.markAnnouncedIfFirst(5000)).toBe(true);
    expect(store.markAnnouncedIfFirst(5001)).toBe(false);
    expect(createStore(baseDir).markAnnouncedIfFirst(5002)).toBe(false); // persisted.
  });

  it('false (not true-and-unpersisted) when the save fails — the announce must never repeat', () => {
    const store = createStore(baseDir);
    store.saveState({
      ...defaultState(),
      watch: observeMany(freshWatch(), ['s1', 's2', 's3'], 30),
    });
    chmodSync(baseDir, 0o555);
    expect(store.markAnnouncedIfFirst(5000)).toBe(false);
    chmodSync(baseDir, 0o755);
  });
});

describe('announceMessage', () => {
  it('carries the observation count and the /coach off escape hatch', () => {
    const msg = announceMessage(30);
    expect(msg).toContain('30 observations');
    expect(msg).toContain('/coach off');
    expect(msg).toMatch(/watching how you work/i);
  });
});
