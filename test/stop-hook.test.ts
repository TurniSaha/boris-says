/**
 * test/stop-hook.test.ts — M2 same-turn coaching: the `Stop` hook drain (PLAN §B Step 5).
 *
 * The Stop hook fires when Claude finishes a turn. It polls the session mailbox up to
 * STOP_DRAIN_POLL_MS (250ms ticks) so the concurrently-running judge's tip surfaces WITH
 * the turn it judged. The judge-done marker [A2] makes silent (well-formed) turns exit
 * near-instantly; a missing turn marker (no judge spawned) exits immediately; the poll
 * cap bounds a crashed/slow judge. All clock/sleep/store/stdout seams are injected —
 * NO real time passes in these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStopHook, type StopHookDeps } from '../src/stop-hook.js';
import { createStore, type Store } from '../src/state/store.js';
import { writeLastOutcome } from '../src/brain/outcome-store.js';
import { STOP_DRAIN_POLL_MS, STOP_DRAIN_INTERVAL_MS, projectKeyForCwd } from '../src/config.js';

let baseDir: string;
let store: Store;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-stop-'));
  store = createStore(baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const SID = 'stop-sess';
const TURN = `${SID}#t1`;

function stdinFor(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SID,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/work/dir',
    reason: 'end_turn',
    hook_event_name: 'Stop',
    ...over,
  });
}

/** A fake-clock harness: sleep advances virtual time, counts ticks, can run a side effect. */
function fakeClock(onTick?: (tick: number) => void): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ticks: () => number;
} {
  let t = 0;
  let n = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      n += 1;
      onTick?.(n);
    },
    ticks: () => n,
  };
}

function capture(): { out: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const out = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WriteStream;
  return { out, text: () => chunks.join('') };
}

function deps(over: Partial<StopHookDeps> = {}): StopHookDeps {
  const clock = fakeClock();
  return {
    stdin: stdinFor(),
    env: { PROMPT_COACH_DIR: baseDir },
    store,
    now: clock.now,
    sleep: clock.sleep,
    ...over,
  };
}

describe('runStopHook — same-turn tip delivery (the M2 headline)', () => {
  it('tip already waiting on tick 1 → emitted SAME-TURN, UNLABELED, zero sleeps', async () => {
    store.beginTurn(SID, TURN);
    store.writeMailbox(SID, { kind: 'quality', message: 'THE SAME-TURN TIP', prompt: 'thin prompt', turnId: TURN });
    const clock = fakeClock();
    const { out, text } = capture();

    await runStopHook(deps({ now: clock.now, sleep: clock.sleep, out }));

    expect(text()).toContain('THE SAME-TURN TIP');
    expect(text()).not.toContain('about your prompt'); // it's THIS turn — no label.
    expect(clock.ticks()).toBe(0);
    // Consume-once: the mailbox is now empty.
    expect(store.claimMailbox(SID)).toEqual([]);
  });

  it('tip lands on tick 3 (judge finishing mid-poll) → still emitted same-turn', async () => {
    store.beginTurn(SID, TURN);
    const clock = fakeClock((tick) => {
      if (tick === 3) {
        store.writeMailbox(SID, { kind: 'quality', message: 'LATE-COOKED TIP', prompt: 'p', turnId: TURN });
      }
    });
    const { out, text } = capture();

    await runStopHook(deps({ now: clock.now, sleep: clock.sleep, out }));

    expect(text()).toContain('LATE-COOKED TIP');
    expect(clock.ticks()).toBe(3);
  });

  it('emits via the systemMessage JSON channel (one JSON object on stdout)', async () => {
    store.beginTurn(SID, TURN);
    store.writeMailbox(SID, { kind: 'quality', message: 'CHANNEL CHECK', turnId: TURN });
    const { out, text } = capture();
    await runStopHook(deps({ out }));
    const parsed = JSON.parse(text().trim()) as { systemMessage?: string };
    expect(parsed.systemMessage).toContain('CHANNEL CHECK');
  });
});

describe('runStopHook — [A2] silent turns never stall (the judge-done marker)', () => {
  it('marker-set + no tip (judge chose silence) → exits FAST: zero sleeps, nothing emitted', async () => {
    store.beginTurn(SID, TURN);
    store.markTurnJudged(SID, TURN);
    const clock = fakeClock();
    const { out, text } = capture();

    await runStopHook(deps({ now: clock.now, sleep: clock.sleep, out }));

    expect(text()).toBe('');
    expect(clock.ticks()).toBe(0); // well under the cap — near-zero stall.
  });

  it('marker lands mid-poll (silent verdict finishing late) → exits on THAT tick, not the cap', async () => {
    store.beginTurn(SID, TURN);
    const clock = fakeClock((tick) => {
      if (tick === 2) store.markTurnJudged(SID, TURN);
    });
    const { out, text } = capture();

    await runStopHook(deps({ now: clock.now, sleep: clock.sleep, out }));

    expect(text()).toBe('');
    expect(clock.ticks()).toBe(2);
    expect(clock.ticks()).toBeLessThan(STOP_DRAIN_POLL_MS / STOP_DRAIN_INTERVAL_MS);
  });
});

describe('runStopHook — cap + guards (never hangs, never throws)', () => {
  it('judge crashed (no marker, no tip, marker for the turn exists) → polls to the cap then exits silent', async () => {
    store.beginTurn(SID, TURN); // judge WAS spawned…
    const clock = fakeClock(); // …but never writes tip nor marker (crash).
    const { out, text } = capture();

    await runStopHook(deps({ now: clock.now, sleep: clock.sleep, out }));

    expect(text()).toBe('');
    expect(clock.ticks()).toBe(STOP_DRAIN_POLL_MS / STOP_DRAIN_INTERVAL_MS); // exactly the cap.
  });

  it('NO turn marker (tool-only / aborted / coach-ignored turn) → immediate exit, zero sleeps', async () => {
    const clock = fakeClock();
    const { out, text } = capture();
    await runStopHook(deps({ now: clock.now, sleep: clock.sleep, out }));
    expect(text()).toBe('');
    expect(clock.ticks()).toBe(0);
  });

  it('unparseable stdin / missing session_id → silent no-op (never throws)', async () => {
    const { out, text } = capture();
    await expect(runStopHook(deps({ stdin: 'not json', out }))).resolves.toBeUndefined();
    await expect(runStopHook(deps({ stdin: JSON.stringify({ cwd: '/x' }), out }))).resolves.toBeUndefined();
    expect(text()).toBe('');
  });

  it('kill switch (state.enabled=false) → nothing, even with a tip waiting', async () => {
    store.saveState({ ...store.getState(), enabled: false });
    store.beginTurn(SID, TURN);
    store.writeMailbox(SID, { kind: 'quality', message: 'SUPPRESSED', turnId: TURN });
    const { out, text } = capture();
    await runStopHook(deps({ out }));
    expect(text()).toBe('');
  });

  it('recursion guard: PROMPT_COACH_JUDGING set → immediate no-op', async () => {
    store.beginTurn(SID, TURN);
    store.writeMailbox(SID, { kind: 'quality', message: 'GUARDED', turnId: TURN });
    const { out, text } = capture();
    await runStopHook(deps({ env: { PROMPT_COACH_DIR: baseDir, PROMPT_COACH_JUDGING: '1' }, out }));
    expect(text()).toBe('');
  });

  it('a second Stop fire after the tip was claimed → nothing (consume-once via the rename)', async () => {
    store.beginTurn(SID, TURN);
    store.markTurnJudged(SID, TURN);
    store.writeMailbox(SID, { kind: 'quality', message: 'ONCE ONLY', turnId: TURN });
    const first = capture();
    await runStopHook(deps({ out: first.out }));
    expect(first.text()).toContain('ONCE ONLY');
    const second = capture();
    await runStopHook(deps({ out: second.out }));
    expect(second.text()).toBe(''); // judged + empty → fast silent exit.
  });
});

describe('runStopHook — cross-turn claim gets the attribution label (defensive, rare)', () => {
  it('a claimed tip whose turnId ≠ the CURRENT turn is emitted WITH the "about your prompt" label', async () => {
    // Stop of turn 2 claims a tip the judge wrote about turn 1 (turn 1's Stop missed it).
    store.beginTurn(SID, `${SID}#t2`);
    store.writeMailbox(SID, { kind: 'quality', message: 'STALE-TURN TIP', prompt: 'the old prompt', turnId: `${SID}#t1` });
    const { out, text } = capture();

    await runStopHook(deps({ out }));

    expect(text()).toContain('STALE-TURN TIP');
    expect(text()).toContain('about your prompt');
    expect(text()).toContain('the old prompt');
  });

  it('a stale tip WITHOUT a prompt (bare ping) is emitted unlabeled (nothing to attribute)', async () => {
    store.beginTurn(SID, `${SID}#t2`);
    store.writeMailbox(SID, { kind: 'quality', message: 'BARE STALE PING', turnId: `${SID}#t1` });
    const { out, text } = capture();
    await runStopHook(deps({ out }));
    expect(text()).toContain('BARE STALE PING');
    expect(text()).not.toContain('about your prompt');
  });
});

describe('runStopHook — outcome recap rides the shared gated helper (PLAN Step 5/7)', () => {
  it('a same-project pending recap surfaces at Stop when this session never showed it (first attempt), once', async () => {
    const pk = projectKeyForCwd('/work/dir');
    store.markGreetedIfFirst('prior'); // engaged install → FIX-1 tour-defer does not skip the recap.
    writeLastOutcome(baseDir, { line: 'Last session: 9 tests passed.', endedSessionId: 'prev', projectKey: pk, consumed: false, at: 1 });
    const { out, text } = capture();

    await runStopHook(deps({ out }));
    expect(text()).toContain('9 tests passed');

    // Second Stop in the same session → the per-session first-attempt gate holds.
    const again = capture();
    await runStopHook(deps({ out: again.out }));
    expect(again.text()).not.toContain('9 tests passed');
  });

  it('a DIFFERENT-project recap never surfaces at Stop (cross-project guard)', async () => {
    writeLastOutcome(baseDir, { line: 'Last session: 9 tests passed.', endedSessionId: 'prev', projectKey: projectKeyForCwd('/other/proj'), consumed: false, at: 1 });
    const { out, text } = capture();
    await runStopHook(deps({ out }));
    expect(text()).not.toContain('9 tests passed');
  });
});
