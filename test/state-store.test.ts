import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeJsonAtomic,
  readJson,
  createStore,
  defaultState,
  capByValue,
  QUALITY_COOLDOWN_MS,
  HABIT_COOLDOWN_MS,
  MAILBOX_CAP,
  QUALITY_TIP_SESSIONS_CAP,
} from '../src/state/store.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-state-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes JSON that round-trips', () => {
    const p = join(baseDir, 'x.json');
    writeJsonAtomic(p, { a: 1, b: 'two' });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1, b: 'two' });
  });

  it('leaves no temp/partial sibling after a successful write', () => {
    const p = join(baseDir, 'x.json');
    writeJsonAtomic(p, { a: 1 });
    const files = readdirSync(baseDir);
    expect(files).toEqual(['x.json']);
  });

  it('never leaves a partial file: the previous content survives if a write of new content is interrupted mid-temp', () => {
    // Simulate a mid-write crash: a stray .tmp exists but the real file is untouched.
    const p = join(baseDir, 'state.json');
    writeJsonAtomic(p, { good: true });
    // A crashed prior attempt left a half-written temp sibling.
    writeFileSync(p + '.tmp.crash', '{ "half": ');
    // The real file is still fully valid (rename is atomic; temp never replaces on crash).
    expect(readJson(p, { good: false })).toEqual({ good: true });
  });

  it('creates parent directories as needed', () => {
    const p = join(baseDir, 'nested', 'deep', 'x.json');
    writeJsonAtomic(p, { ok: 1 });
    expect(existsSync(p)).toBe(true);
  });
});

describe('readJson', () => {
  it('returns the fallback for a missing file', () => {
    expect(readJson(join(baseDir, 'nope.json'), { fb: 1 })).toEqual({ fb: 1 });
  });

  it('returns the fallback for a corrupt file and never throws', () => {
    const p = join(baseDir, 'bad.json');
    writeFileSync(p, '{ not valid json ]]]');
    expect(readJson(p, { fb: 2 })).toEqual({ fb: 2 });
  });

  it('returns the fallback for an empty file', () => {
    const p = join(baseDir, 'empty.json');
    writeFileSync(p, '');
    expect(readJson(p, { fb: 3 })).toEqual({ fb: 3 });
  });
});

describe('getState / saveState', () => {
  it('returns the default state when no file exists', () => {
    const store = createStore(baseDir);
    expect(store.getState()).toEqual(defaultState());
  });

  it('default state matches the spec fields', () => {
    const s = defaultState();
    expect(s.enabled).toBe(true);
    expect(s.lastQualityTipAt).toBeNull();
    expect(s.lastHabitNudgeAt).toBeNull();
    expect(s.lastMinedAt).toBeNull();
    expect(s.lastMinedWatermark).toBe(0);
    expect(s.leversUsedBySession).toEqual({});
    expect(s.lastSurfacedPatternKey).toBeNull();
  });

  it('round-trips a saved state', () => {
    const store = createStore(baseDir);
    const next = { ...defaultState(), enabled: false, lastMinedWatermark: 42 };
    store.saveState(next);
    expect(createStore(baseDir).getState()).toEqual(next);
  });

  it('a corrupt state.json falls back to defaults rather than throwing', () => {
    writeFileSync(join(baseDir, 'state.json'), 'CORRUPT');
    expect(createStore(baseDir).getState()).toEqual(defaultState());
  });
});

describe('cooldown helpers (quality and habit are separate)', () => {
  it('quality cooldown is independent of the habit cooldown', () => {
    const store = createStore(baseDir);
    const now = 1_000_000;
    // Mark a quality tip only.
    store.markQualityTip(now);
    expect(store.qualityOnCooldown(now)).toBe(true);
    expect(store.qualityOnCooldown(now + QUALITY_COOLDOWN_MS)).toBe(false);
    // Habit cooldown is untouched by a quality tip.
    expect(store.habitOnCooldown(now)).toBe(false);
  });

  it('habit cooldown is independent of the quality cooldown', () => {
    const store = createStore(baseDir);
    const now = 2_000_000;
    store.markHabitNudge(now, 'context-handoff:next-session-prompt');
    expect(store.habitOnCooldown(now)).toBe(true);
    expect(store.habitOnCooldown(now + HABIT_COOLDOWN_MS - 1)).toBe(true);
    expect(store.habitOnCooldown(now + HABIT_COOLDOWN_MS)).toBe(false);
    // Quality cooldown untouched by a habit nudge.
    expect(store.qualityOnCooldown(now)).toBe(false);
  });

  it('default cooldowns are 10 minutes (quality) and 24 hours (habit)', () => {
    expect(QUALITY_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(HABIT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('markHabitNudge records lastSurfacedPatternKey in the same write', () => {
    const store = createStore(baseDir);
    store.markHabitNudge(5, 'k:1');
    const s = createStore(baseDir).getState();
    expect(s.lastHabitNudgeAt).toBe(5);
    expect(s.lastSurfacedPatternKey).toBe('k:1');
  });
});

describe('same-lever set per session', () => {
  it('records and reports a lever used in a session', () => {
    const store = createStore(baseDir);
    expect(store.leverUsedInSession('s1', 'scope_boundaries')).toBe(false);
    store.markQualityTip(100, 's1', 'scope_boundaries');
    expect(store.leverUsedInSession('s1', 'scope_boundaries')).toBe(true);
    // Different lever in the same session is not suppressed.
    expect(store.leverUsedInSession('s1', 'goal_clarity')).toBe(false);
    // Same lever in a different session is not suppressed.
    expect(store.leverUsedInSession('s2', 'scope_boundaries')).toBe(false);
  });

  it('marking a quality tip with a lever records cooldown AND lever in one atomic write', () => {
    const store = createStore(baseDir);
    store.markQualityTip(100, 's1', 'process_fit');
    const reloaded = createStore(baseDir).getState();
    expect(reloaded.lastQualityTipAt).toBe(100);
    expect(reloaded.leversUsedBySession['s1']).toEqual(['process_fit']);
  });

  it('does not duplicate a lever already present in the session set', () => {
    const store = createStore(baseDir);
    store.markQualityTip(100, 's1', 'process_fit');
    store.markQualityTip(200, 's1', 'process_fit');
    expect(createStore(baseDir).getState().leversUsedBySession['s1']).toEqual(['process_fit']);
  });
});

describe('mailbox', () => {
  it('round-trips a single tip', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'tip one' });
    const drained = store.readAndClearMailbox('s1');
    expect(drained).toEqual([{ kind: 'quality', message: 'tip one' }]);
  });

  it('drain clears the mailbox (second drain is empty)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'habit', message: 'h' });
    expect(store.readAndClearMailbox('s1')).toHaveLength(1);
    expect(store.readAndClearMailbox('s1')).toEqual([]);
  });

  it('an empty/absent mailbox drains to []', () => {
    const store = createStore(baseDir);
    expect(store.readAndClearMailbox('never')).toEqual([]);
  });

  it('caps at MAILBOX_CAP (3) tips per session, keeping the newest', () => {
    expect(MAILBOX_CAP).toBe(3);
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'q1' });
    store.writeMailbox('s1', { kind: 'quality', message: 'q2' });
    store.writeMailbox('s1', { kind: 'quality', message: 'q3' });
    store.writeMailbox('s1', { kind: 'quality', message: 'q4' });
    const drained = store.readAndClearMailbox('s1');
    expect(drained).toHaveLength(3);
    expect(drained.map((t) => t.message)).toEqual(['q2', 'q3', 'q4']);
  });

  it('drain returns quality tips before habit tips on a tie', () => {
    const store = createStore(baseDir);
    // Queue habit FIRST, then quality, to prove ordering is by kind, not insertion.
    store.writeMailbox('s1', { kind: 'habit', message: 'h1' });
    store.writeMailbox('s1', { kind: 'quality', message: 'q1' });
    const drained = store.readAndClearMailbox('s1');
    expect(drained.map((t) => t.kind)).toEqual(['quality', 'habit']);
  });

  it('different sessions have independent mailboxes', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'a' });
    store.writeMailbox('s2', { kind: 'quality', message: 'b' });
    expect(store.readAndClearMailbox('s1')).toEqual([{ kind: 'quality', message: 'a' }]);
    expect(store.readAndClearMailbox('s2')).toEqual([{ kind: 'quality', message: 'b' }]);
  });
});

describe('inbox (detached judge handoff)', () => {
  it('writeInbox returns a path and the file holds the payload', () => {
    const store = createStore(baseDir);
    const payload = { prompt: 'hi', transcript_path: '/t', session_id: 's1', cwd: '/c' };
    const p = store.writeInbox(payload);
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(payload);
  });

  it('the inbox file name includes the session id', () => {
    const store = createStore(baseDir);
    const p = store.writeInbox({ prompt: 'x', transcript_path: '', session_id: 'sess-abc', cwd: '' });
    expect(p).toContain('sess-abc');
  });

  it('the inbox file name includes process.pid so two distinct processes cannot collide', () => {
    // The in-process monotonic counter resets to 0 in every fresh `node dist/hook.js`
    // process and hrtime is process-relative, so two processes firing in the same ms
    // could otherwise mint an identical name and clobber each other (SPEC §8.4).
    // Guard: pid is baked into the FINAL inbox filename.
    const store = createStore(baseDir);
    const p = store.writeInbox({ prompt: 'x', transcript_path: '', session_id: 'sess-abc', cwd: '' });
    const name = p.split('/').pop()!;
    // Shape: <safeSession>-<pid>-<monotonic>.json — pid sits between session id and the
    // monotonic suffix, so a different-pid process produces a different name even when
    // its counter and Date.now() happen to coincide with ours.
    expect(name).toContain(`-${process.pid}-`);
    expect(name.startsWith(`sess-abc-${process.pid}-`)).toBe(true);
  });

  it('readAndUnlinkInbox reads then deletes the file', () => {
    const store = createStore(baseDir);
    const p = store.writeInbox({ prompt: 'y', transcript_path: '', session_id: 's1', cwd: '' });
    const got = store.readAndUnlinkInbox(p);
    expect(got?.prompt).toBe('y');
    expect(existsSync(p)).toBe(false);
  });

  it('readAndUnlinkInbox on a missing path returns null and never throws', () => {
    const store = createStore(baseDir);
    expect(store.readAndUnlinkInbox(join(baseDir, 'inbox', 'gone.json'))).toBeNull();
  });

  it('concurrent writes for the same session never collide on a file name', () => {
    const store = createStore(baseDir);
    const N = 200;
    const paths = new Set<string>();
    for (let i = 0; i < N; i++) {
      paths.add(store.writeInbox({ prompt: 'p' + i, transcript_path: '', session_id: 'same', cwd: '' }));
    }
    expect(paths.size).toBe(N);
    // All N files exist simultaneously (none clobbered another).
    const files = readdirSync(join(baseDir, 'inbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(N);
  });
});

describe('legacy state tolerance (retired L34b keys)', () => {
  it('an on-disk state.json still carrying the RETIRED L34b keys parses fine (extra fields tolerated)', () => {
    // The L34b prompt-path lever was demoted (M1 relevance overhaul); old installs still
    // have its keys on disk. The structural read merges over defaults and must not choke.
    writeJsonAtomic(join(baseDir, 'state.json'), {
      enabled: true,
      leversUsedBySession: { 'sess-1': ['process_fit'] },
      pendingDiffReview: { capturedForSession: 'sess-1', capturedAt: 1, insertions: 320, filesChanged: 6 },
      l34bLastNudgedInsertions: 320,
    });
    const s = createStore(baseDir).getState();
    expect(s.enabled).toBe(true);
    expect(s.leversUsedBySession['sess-1']).toContain('process_fit');
  });
});

describe('markGreetedIfFirst — one-time welcome, persisted (the every-prompt-ping bug fix)', () => {
  it('returns true the FIRST time, false thereafter (same store)', () => {
    const store = createStore(baseDir);
    expect(store.markGreetedIfFirst('sess-A')).toBe(true);
    expect(store.markGreetedIfFirst('sess-A')).toBe(false);
    expect(store.markGreetedIfFirst('sess-A')).toBe(false);
  });

  it('PERSISTS across a fresh store instance (the real repro: judge is a new process each prompt)', () => {
    createStore(baseDir).markGreetedIfFirst('sess-B'); // "process 1" greets.
    // "process 2/3/…": a brand-new store over the same dir must NOT re-greet.
    expect(createStore(baseDir).markGreetedIfFirst('sess-B')).toBe(false);
    expect(createStore(baseDir).markGreetedIfFirst('sess-B')).toBe(false);
  });

  it('different sessions each get greeted once', () => {
    const store = createStore(baseDir);
    expect(store.markGreetedIfFirst('s1')).toBe(true);
    expect(store.markGreetedIfFirst('s2')).toBe(true);
    expect(store.markGreetedIfFirst('s1')).toBe(false);
  });

  it('an empty session id never greets (no blank-key greet-loop)', () => {
    expect(createStore(baseDir).markGreetedIfFirst('')).toBe(false);
  });

  it('caps the greeted list so it cannot grow unbounded', () => {
    const store = createStore(baseDir);
    for (let i = 0; i < 600; i += 1) store.markGreetedIfFirst('s' + i);
    expect(store.getState().greetedSessions.length).toBeLessThanOrEqual(500);
  });
});

describe('markTourShownIfFirst — once-per-INSTALL first-run tour (item 3)', () => {
  it('returns true the FIRST time ever, false thereafter (persisted across processes)', () => {
    expect(createStore(baseDir).markTourShownIfFirst()).toBe(true);
    // A brand-new store over the same dir (fresh judge process) must NOT re-tour.
    expect(createStore(baseDir).markTourShownIfFirst()).toBe(false);
    expect(createStore(baseDir).markTourShownIfFirst()).toBe(false);
  });

  it('is INSTALL-wide, not per-session (no argument — one tour for the whole install)', () => {
    const store = createStore(baseDir);
    expect(store.markTourShownIfFirst()).toBe(true);
    expect(store.markTourShownIfFirst()).toBe(false);
  });

  it('an ENGAGED legacy install NEVER gets a surprise tour (mirror the M5 migration rule)', () => {
    // Seed a legacy state that predates the tour flag but shows engagement (a prior tip).
    const store = createStore(baseDir);
    const s = store.getState();
    // Remove the tour flag entirely (a genuine legacy state.json) and add an engagement marker.
    const legacy: Record<string, unknown> = { ...s, lastQualityTipAt: 123456 };
    delete legacy.tourShown;
    store.saveState(legacy as any);
    // Engaged + unflagged → treated as already toured → no surprise tour.
    expect(createStore(baseDir).markTourShownIfFirst()).toBe(false);
  });

  it('a FRESH install (no engagement, no flag) DOES get the tour once', () => {
    // Default state has no engagement markers.
    expect(createStore(baseDir).markTourShownIfFirst()).toBe(true);
  });
});

describe('markQualityTip — per-session cooldown (cross-session bleed fix)', () => {
  it('stamps the per-session map AND the global field on a fire', () => {
    const store = createStore(baseDir);
    store.markQualityTip(1000, 'sX', 'goal_clarity');
    const s = store.getState();
    expect(s.lastQualityTipBySession['sX']).toBe(1000);
    expect(s.lastQualityTipAt).toBe(1000); // global kept for /coach status display
  });

  it('advances sessions independently — one session does not touch another', () => {
    const store = createStore(baseDir);
    store.markQualityTip(1000, 'sA', 'goal_clarity');
    store.markQualityTip(2000, 'sB', 'risk_awareness');
    store.markQualityTip(5000, 'sA', 'scope_boundaries');
    const m = store.getState().lastQualityTipBySession;
    expect(m['sA']).toBe(5000);
    expect(m['sB']).toBe(2000); // B untouched by A's later tip
  });

  it('a sessionId-less call never writes a blank key', () => {
    const store = createStore(baseDir);
    store.markQualityTip(1000, undefined, undefined);
    expect(Object.keys(store.getState().lastQualityTipBySession)).toHaveLength(0);
  });

  it('caps the per-session map so it cannot grow unbounded', () => {
    const store = createStore(baseDir);
    for (let i = 0; i < QUALITY_TIP_SESSIONS_CAP + 100; i += 1) {
      store.markQualityTip(1000 + i, 'sess' + i, 'goal_clarity');
    }
    expect(Object.keys(store.getState().lastQualityTipBySession).length).toBeLessThanOrEqual(
      QUALITY_TIP_SESSIONS_CAP,
    );
  });
});

describe('capByValue — keeps the most-recent N entries by value', () => {
  it('returns the map unchanged when at or under the cap', () => {
    const m = { a: 3, b: 1, c: 2 };
    expect(capByValue(m, 3)).toBe(m);
    expect(capByValue(m, 5)).toBe(m);
  });

  it('keeps only the highest-valued entries when over the cap', () => {
    const m = { a: 10, b: 50, c: 30, d: 5 };
    const out = capByValue(m, 2);
    expect(Object.keys(out).sort()).toEqual(['b', 'c']); // 50 and 30 are most-recent
    expect(out).toEqual({ b: 50, c: 30 });
  });
});

// ── M2 same-turn coaching: atomic claim + tip attribution + turn markers ────────
// (PLAN §B Step 2 — claimMailbox is rename-based so a concurrent judge write can
// never be torn or lost; Tip carries the judged prompt + turnId for the labeled
// backstop; the judge-done marker [A2] lets the Stop poll exit fast on silent turns.)

describe('M2 — claimMailbox (atomic rename-based consume-once)', () => {
  it('claims the queued tips and a second claim is empty (consume-once)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'tip' });
    expect(store.claimMailbox('s1')).toEqual([{ kind: 'quality', message: 'tip' }]);
    expect(store.claimMailbox('s1')).toEqual([]);
  });

  it('missing mailbox → [] (never throws)', () => {
    const store = createStore(baseDir);
    expect(store.claimMailbox('never')).toEqual([]);
  });

  it('orders quality before habit (same contract as readAndClearMailbox)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'habit', message: 'h' });
    store.writeMailbox('s1', { kind: 'quality', message: 'q' });
    const claimed = store.claimMailbox('s1');
    expect(claimed.map((t) => t.kind)).toEqual(['quality', 'habit']);
  });

  it('leaves NO claim-file residue behind after a claim', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'tip' });
    store.claimMailbox('s1');
    expect(readdirSync(join(baseDir, 'mailbox'))).toEqual([]);
  });

  it('a judge write INTERLEAVED after the claim lands in a FRESH mailbox (no torn read, no lost tip)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'first' });
    const claimed = store.claimMailbox('s1');
    expect(claimed).toEqual([{ kind: 'quality', message: 'first' }]);
    // The judge's read-append-write lands AFTER the rename → a brand-new mailbox for
    // the NEXT drain; nothing is lost, nothing is torn.
    store.writeMailbox('s1', { kind: 'quality', message: 'second' });
    expect(store.claimMailbox('s1')).toEqual([{ kind: 'quality', message: 'second' }]);
  });

  it('readAndClearMailbox shares the same consume-once (a claim empties it and vice versa)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'tip' });
    expect(store.claimMailbox('s1')).toHaveLength(1);
    expect(store.readAndClearMailbox('s1')).toEqual([]);
  });
});

describe('M2 — Tip carries the judged prompt + turnId (round-trip)', () => {
  it('prompt + turnId survive the mailbox round-trip', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', {
      kind: 'quality',
      message: 'tip',
      prompt: 'make it better',
      turnId: 's1#42',
    });
    const [tip] = store.claimMailbox('s1');
    expect(tip.prompt).toBe('make it better');
    expect(tip.turnId).toBe('s1#42');
  });

  it('old-shape tips (no prompt/turnId) still round-trip (back-compat)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('s1', { kind: 'quality', message: 'bare' });
    const [tip] = store.claimMailbox('s1');
    expect(tip.message).toBe('bare');
    expect(tip.prompt).toBeUndefined();
    expect(tip.turnId).toBeUndefined();
  });
});

describe('M2 — turn markers (beginTurn / currentTurn)', () => {
  it('beginTurn records the turn id; currentTurn reads it back', () => {
    const store = createStore(baseDir);
    store.beginTurn('s1', 's1#a');
    expect(store.currentTurn('s1')).toBe('s1#a');
  });

  it('a later beginTurn overwrites (only the CURRENT turn is tracked)', () => {
    const store = createStore(baseDir);
    store.beginTurn('s1', 's1#a');
    store.beginTurn('s1', 's1#b');
    expect(store.currentTurn('s1')).toBe('s1#b');
  });

  it('no marker → null; per-session isolation', () => {
    const store = createStore(baseDir);
    expect(store.currentTurn('nope')).toBeNull();
    store.beginTurn('s1', 's1#a');
    expect(store.currentTurn('s2')).toBeNull();
  });
});

describe('M2 — judge-done marker [A2] (markTurnJudged / wasTurnJudged)', () => {
  it('set → read true; unset → false', () => {
    const store = createStore(baseDir);
    expect(store.wasTurnJudged('s1', 's1#a')).toBe(false);
    store.markTurnJudged('s1', 's1#a');
    expect(store.wasTurnJudged('s1', 's1#a')).toBe(true);
    expect(store.wasTurnJudged('s1', 's1#b')).toBe(false);
  });

  it('the judgedTurns ring is CAPPED (old entries roll off, state.json stays bounded)', () => {
    const store = createStore(baseDir);
    for (let i = 0; i < 250; i += 1) store.markTurnJudged('s1', `s1#${i}`);
    const ring = store.getState().judgedTurns;
    expect(ring.length).toBeLessThanOrEqual(200);
    expect(store.wasTurnJudged('s1', 's1#249')).toBe(true); // newest kept
    expect(store.wasTurnJudged('s1', 's1#0')).toBe(false); // oldest rolled off
  });

  it('an OLD on-disk state without judgedTurns is forward-compatible (never throws)', () => {
    writeFileSync(join(baseDir, 'state.json'), JSON.stringify({ enabled: true }), 'utf8');
    const store = createStore(baseDir);
    expect(store.wasTurnJudged('s1', 's1#a')).toBe(false);
    store.markTurnJudged('s1', 's1#a');
    expect(store.wasTurnJudged('s1', 's1#a')).toBe(true);
  });
});

describe('G-M4b — lastIndexRefreshAt state field (auto-refresh watermark)', () => {
  it('legacy state.json WITHOUT the key parses → lastIndexRefreshAt === null', () => {
    writeFileSync(join(baseDir, 'state.json'), JSON.stringify({ enabled: true }), 'utf8');
    const store = createStore(baseDir);
    expect(store.getState().lastIndexRefreshAt).toBeNull();
  });

  it('defaultState carries lastIndexRefreshAt: null', () => {
    expect(defaultState().lastIndexRefreshAt).toBeNull();
  });

  it('round-trips after saveState', () => {
    const store = createStore(baseDir);
    store.saveState({ ...store.getState(), lastIndexRefreshAt: 1_234_567 });
    expect(store.getState().lastIndexRefreshAt).toBe(1_234_567);
  });
});
