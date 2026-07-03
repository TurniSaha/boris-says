/**
 * M5 "critiques only after watching" — Step 2: the watch gate at the judge's SURFACING
 * decision (deposit time). The cascade runs unchanged; the gate only decides whether a
 * fired CRITIQUE verdict deposits or is withheld to the observe-only log.
 *
 * Pins (through runJudge with a tmp-dir store + mocked backend, mirroring judge.test.ts):
 *   - critique verdict during the window → NO deposit, withheld entry, taste loop intact;
 *   - opportunity verdicts (skill_fit / primitive_fit) + habit deposit day one, unchanged;
 *   - fresh-install ordering: prompt 1 counts BEFORE the greet write (no self-engagement);
 *   - first-seen + withheld critique → the bare welcome ping still deposits, prefix-stripped
 *     from the log, no announce that turn;
 *   - window close → the announce deposits exactly ONCE, then critique behaves as today;
 *   - legacy engaged state → pre-closed, deposits immediately, no announce ever;
 *   - sentinel/reflex prompts still count as observations; a throwing watch store never
 *     aborts the habit/miner steps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJudge, type JudgeDeps } from '../src/judge.js';
import {
  createStore,
  defaultState,
  writeJsonAtomic,
  type Store,
  type InboxPayload,
} from '../src/state/store.js';
import { freshWatch, recordObservation, type WatchState } from '../src/state/watch.js';
import {
  createPatternsStore,
  type Pattern,
  type PatternsStore,
} from '../src/habit/patterns-store.js';
import { createMergedSkillCatalog } from '../src/capability/merged-skill-catalog.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-watch-judge-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const NOW = 5_000_000;

/** A judge verdict JSON that FIRES on the given primary lever. */
function firingVerdict(lever: string, nudge = 'sketch the data contract and key views first'): string {
  return JSON.stringify({
    phase: 'new-task',
    dimension_scores: { [lever]: 0.2 },
    missing_piece: 'a concrete definition of done',
    risk_level: 'low',
    skill_fit: { candidate_skill: null, confidence: 0 },
    capability_fit: { candidate_capability: null, confidence: 0 },
    interrupt: true,
    confidence: 0.9,
    primary_lever: lever,
    nudge,
  });
}

const SILENT_VERDICT = JSON.stringify({
  phase: 'new-task',
  dimension_scores: {},
  missing_piece: null,
  risk_level: 'low',
  skill_fit: { candidate_skill: null, confidence: 0 },
  capability_fit: { candidate_capability: null, confidence: 0 },
  interrupt: false,
  confidence: 0.1,
  primary_lever: 'goal_clarity',
  nudge: null,
});

function backend(sonnet: string, haiku = '0.9'): LlmBackend {
  return {
    configured: true,
    async complete(o: LlmCompleteOptions) {
      return o.model === 'haiku' ? haiku : sonnet;
    },
  };
}

function deps(
  store: Store,
  patterns: PatternsStore,
  inboxPath: string,
  overrides: Partial<JudgeDeps> = {},
): JudgeDeps {
  return {
    env: { PROMPT_COACH_DIR: baseDir },
    inboxPath,
    store,
    patternsStore: patterns,
    backend: backend(firingVerdict('process_fit')),
    readTranscript: () => [],
    catalog: createMergedSkillCatalog([]),
    capabilities: [],
    readCorpus: () => [],
    now: () => NOW,
    ...overrides,
  };
}

/** Run one judge turn; returns nothing (assert via the store). */
async function turn(
  store: Store,
  patterns: PatternsStore,
  session: string,
  prompt: string,
  overrides: Partial<JudgeDeps> = {},
  turnId?: string,
): Promise<void> {
  const payload: InboxPayload = {
    prompt,
    transcript_path: '',
    session_id: session,
    cwd: '',
    ...(turnId ? { turn_id: turnId } : {}),
  };
  const inboxPath = store.writeInbox(payload);
  await runJudge(deps(store, patterns, inboxPath, overrides));
}

/** An OPEN watch seeded with `prompts` observations across `sessions`. */
function openWatch(sessions: readonly string[], prompts: number): WatchState {
  let w = freshWatch();
  for (let i = 0; i < prompts; i += 1) w = recordObservation(w, sessions[i % sessions.length], 100 + i);
  if (w.closedAt !== null) throw new Error('seed error: watch closed');
  return w;
}

function openPattern(): Pattern {
  return {
    habit_key: 'context-handoff:next-session-prompt',
    trigger: 'prompt_recurring:context-handoff:next-session-prompt',
    match_phrases: ['give me the prompt for the next session'],
    anchorSignature: ['give', 'prompt', 'next', 'session'],
    habit: 'asked for a next-session handoff prompt',
    fix: 'bake a prompt-handoff into your /context-handoff',
    why_inefficient: 'retypes a handoff every session',
    occurrences: [
      { sessionId: 'a', ts: 1, evidence: 'x' },
      { sessionId: 'b', ts: 2, evidence: 'y' },
      { sessionId: 'c', ts: 3, evidence: 'z' },
    ],
    occurrenceCount: 3,
    confidence: 0.9,
    status: 'open',
    createdAt: 0,
    surfacedAt: null,
  };
}

describe('M5 — critique verdict during the window is WITHHELD (observe-only)', () => {
  it('no deposit, withheld entry logged, cooldown/lever/lastTip untouched, taste loop intact', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const sid = 'sWithhold';
    // Materialize an OPEN window + pre-greet the session via a priming silent turn.
    await turn(store, patterns, sid, 'a priming prompt', {
      backend: backend(SILENT_VERDICT, '0.0'),
    });
    store.claimMailbox(sid); // drain the welcome ping.
    // A prior OPPORTUNITY fire left a rateable lastTip — the withhold must NOT clobber it.
    store.recordLastTip({ lever: 'skill_fit', prompt: 'earlier', sessionId: sid, at: 1 });
    const feedbackBefore = store.getState().feedbackByLever;

    const longPrompt = 'refactor the retry logic across the services ' + 'y'.repeat(400);
    await turn(store, patterns, sid, longPrompt);

    // NO deposit of any kind.
    expect(store.claimMailbox(sid)).toEqual([]);

    const s = store.getState();
    // The withheld log has the verdict.
    expect(s.watch?.withheldCount).toBe(1);
    expect(s.watch?.withheld[0].lever).toBe('process_fit');
    expect(s.watch?.withheld[0].tip).toContain('sketch the data contract');
    expect(s.watch?.withheld[0].prompt.length).toBeLessThanOrEqual(300); // capped.
    // Nothing surfaced → nothing armed, marked, or rateable.
    expect(s.lastQualityTipAt).toBeNull();
    expect(s.leversUsedBySession[sid]).toBeUndefined();
    expect(s.lastTip).toEqual({ lever: 'skill_fit', prompt: 'earlier', sessionId: sid, at: 1 });
    expect(s.feedbackByLever).toEqual(feedbackBefore);
  });

  it('habit still delivers on a withheld turn (withholding is not a quality deposit)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([openPattern()]);
    const sid = 'sWithholdHabit';
    await turn(store, patterns, sid, 'a priming prompt that does not match the habit', {
      backend: backend(SILENT_VERDICT, '0.0'),
    });
    store.claimMailbox(sid);

    // Critique verdict fires AND the habit matches — quality is withheld, habit surfaces.
    await turn(store, patterns, sid, 'give me the prompt for the next session');
    const tips = store.claimMailbox(sid);
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('habit');
    expect(store.getState().watch?.withheldCount).toBe(1);
  });

  it('first-run tour + withheld critique: the bare tour deposits, the log entry is prefix-stripped, no announce', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const sid = 'sFirstSeen';
    await turn(store, patterns, sid, 'refactor the retry logic across the services');

    const tips = store.claimMailbox(sid);
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('quality');
    expect(tips[0].message).toContain('Watch-first'); // the bare once-per-install tour.
    expect(tips[0].message).not.toContain('sketch the data contract'); // tip withheld.
    expect(tips[0].message).not.toContain('observations'); // never an announce here.
    expect(tips[0].prompt).toBeUndefined(); // tour is not "about your prompt".

    const w = store.getState().watch;
    expect(w?.withheldCount).toBe(1);
    expect(w?.withheld[0].tip).toContain('sketch the data contract');
    expect(w?.withheld[0].tip).not.toContain('Watch-first'); // tour prefix stripped.
  });
});

describe('M5 — opportunity surfaces are untouched during the window (day one)', () => {
  it('a skill_fit verdict deposits + arms the cooldown + records lastTip on a fresh install', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    await turn(store, patterns, 'sOpp', 'extract the tables from this pdf report', {
      backend: backend(firingVerdict('skill_fit', 'use the pdf skill before hand-parsing')),
    });
    const tips = store.claimMailbox('sOpp');
    expect(tips).toHaveLength(1);
    expect(tips[0].message).toContain('use the pdf skill');
    const s = store.getState();
    expect(s.lastQualityTipAt).toBe(NOW);
    expect(s.leversUsedBySession['sOpp']).toContain('skill_fit');
    expect(s.lastTip?.lever).toBe('skill_fit');
    expect(s.watch?.closedAt).toBeNull(); // the window stays open — only critique waits.
  });

  it('a primitive_fit verdict deposits during the window too', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    await turn(store, patterns, 'sPrim', 'scaffold the model, then seed fixtures, then snapshot', {
      backend: backend(firingVerdict('primitive_fit', 'make this recipe a skill')),
    });
    const tips = store.claimMailbox('sPrim');
    expect(tips).toHaveLength(1);
    expect(tips[0].message).toContain('make this recipe a skill');
    expect(store.getState().leversUsedBySession['sPrim']).toContain('primitive_fit');
  });
});

describe('M5 — fresh-install ordering pin (observe BEFORE greet)', () => {
  it('the very first prompt ever leaves an OPEN window with promptsObserved=1', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    await turn(store, patterns, 'sFresh', 'first prompt of a brand-new install', {
      backend: backend(SILENT_VERDICT, '0.0'),
    });
    const w = store.getState().watch;
    // If markGreetedIfFirst ran FIRST, its own write would self-classify the install as
    // "engaged" and pre-close the window for the exact user it exists for.
    expect(w?.closedAt).toBeNull();
    expect(w?.announced).toBe(false);
    expect(w?.promptsObserved).toBe(1);
    expect(w?.sessionsObserved).toEqual(['sFresh']);
  });

  it('sentinel and reflex-suppressed prompts still count as observations', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const sid = 'sCount';
    await turn(store, patterns, sid, 'when life gives you lemons', {
      backend: backend(SILENT_VERDICT, '0.0'),
    });
    expect(store.getState().watch?.promptsObserved).toBe(1); // sentinel counted.
    await turn(store, patterns, sid, 'yes', {
      backend: backend(SILENT_VERDICT, '0.0'),
    });
    expect(store.getState().watch?.promptsObserved).toBe(2); // reflex-suppressed counted.
  });
});

describe('M5 — window close → announce ONCE, then critique behaves as today', () => {
  it('the closing silent turn announces; the next critique deposits; no second announce', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const sid = 'sClose';
    // 29 prompts over 3 sessions already observed; this session already greeted.
    store.saveState({
      ...defaultState(),
      greetedSessions: [sid],
      watch: openWatch(['s1', 's2', sid], 29),
    });

    // Prompt 30 (a silent cascade) closes the window → the announce deposits.
    await turn(store, patterns, sid, 'a perfectly fine prompt', {
      backend: backend(SILENT_VERDICT, '0.0'),
    }, `${sid}#t30`);
    const announce = store.claimMailbox(sid);
    expect(announce).toHaveLength(1);
    expect(announce[0].kind).toBe('quality');
    expect(announce[0].message).toContain('30 observations');
    expect(announce[0].message).toContain('/coach off');
    expect(announce[0].prompt).toBeUndefined(); // meta-message, not "about your prompt".
    expect(announce[0].turnId).toBe(`${sid}#t30`);
    const s1 = store.getState();
    expect(s1.lastQualityTipAt).toBeNull(); // announce arms NO cooldown.
    expect(s1.lastTip).toBeNull(); // and is not rateable.
    expect(s1.watch?.announced).toBe(true);

    // The next critique verdict deposits exactly as today.
    await turn(store, patterns, sid, 'refactor the retry logic across the services');
    const tips = store.claimMailbox(sid);
    expect(tips).toHaveLength(1);
    expect(tips[0].message).toContain('sketch the data contract');
    expect(store.getState().lastQualityTipAt).toBe(NOW);
    expect(store.getState().leversUsedBySession[sid]).toContain('process_fit');

    // Another silent turn → NO second announce.
    await turn(store, patterns, sid, 'another perfectly fine prompt', {
      backend: backend(SILENT_VERDICT, '0.0'),
    });
    expect(store.claimMailbox(sid)).toEqual([]);
  });

  it('closed-but-unannounced critique verdict: withheld one last time AND the announce shares the turn (one banner)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const sid = 'sCloseFire';
    let w = openWatch(['s1', 's2', sid], 29);
    w = recordObservation(w, sid, 4000); // 30th observation closes it (announced stays false).
    expect(w.closedAt).not.toBeNull();
    store.saveState({ ...defaultState(), greetedSessions: [sid], watch: w });

    await turn(store, patterns, sid, 'refactor the retry logic across the services');
    const tips = store.claimMailbox(sid);
    expect(tips).toHaveLength(1); // ONE banner: the announce, not the tip.
    expect(tips[0].message).toContain('observations');
    expect(tips[0].message).not.toContain('sketch the data contract');
    const s = store.getState();
    expect(s.watch?.withheldCount).toBe(1); // the verdict was withheld one last time.
    expect(s.watch?.announced).toBe(true);

    // The following critique deposits normally.
    await turn(store, patterns, sid, 'now refactor the export pipeline end to end');
    const next = store.claimMailbox(sid);
    expect(next).toHaveLength(1);
    expect(next[0].message).toContain('sketch the data contract');
  });
});

describe('M5 — legacy engaged install: pre-closed, zero behavior change, no announce ever', () => {
  it('a legacy state.json with ratings deposits the first critique immediately', async () => {
    const sid = 'sLegacy';
    writeJsonAtomic(join(baseDir, 'state.json'), {
      enabled: true,
      greetedSessions: [sid],
      feedbackByLever: { process_fit: { good: 3, bad: 1 } },
      lastQualityTipAt: 4_000_000,
    });
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);

    await turn(store, patterns, sid, 'refactor the retry logic across the services');
    const tips = store.claimMailbox(sid);
    expect(tips).toHaveLength(1);
    expect(tips[0].message).toContain('sketch the data contract');
    expect(tips[0].message).not.toContain('observations'); // no announce, ever.
    const s = store.getState();
    expect(s.watch?.closedAt).not.toBeNull();
    expect(s.watch?.announced).toBe(true);
    expect(s.watch?.withheldCount).toBe(0);
    expect(s.leversUsedBySession[sid]).toContain('process_fit');
  });
});

describe('M5 — the watch machinery never breaks the judge', () => {
  it('a throwing observeWatch aborts only the quality step; habit + miner still run', async () => {
    const real = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([openPattern()]);
    const store: Store = {
      ...real,
      observeWatch: () => {
        throw new Error('disk boom');
      },
    };
    const payload: InboxPayload = {
      prompt: 'give me the prompt for the next session',
      transcript_path: '',
      session_id: 'sBoom',
      cwd: '',
    };
    const inboxPath = real.writeInbox(payload);
    await expect(runJudge(deps(store, patterns, inboxPath))).resolves.toBeUndefined();
    // Step 2 (habit) still ran and surfaced the pattern.
    const tips = real.claimMailbox('sBoom');
    expect(tips.some((t) => t.kind === 'habit')).toBe(true);
  });
});
