import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, type SpawnFn, type HookDeps } from '../src/hook.js';
import { createStore, type Store } from '../src/state/store.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-hook-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean };
  unrefed: boolean;
}

/** A recording spawn seam. */
function recordingSpawn(): { fn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: SpawnFn = (command, args, options) => {
    const call: SpawnCall = { command, args, options, unrefed: false };
    calls.push(call);
    return {
      unref() {
        call.unrefed = true;
      },
    };
  };
  return { fn, calls };
}

const HOOK_DIRNAME = '/plugins/cache/mkt/boris-says/1.0.0/dist';

function stdinFor(prompt: string, sessionId = 'sess-1'): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: '/tmp/some-session.jsonl',
    cwd: '/work/dir',
    prompt,
    hook_event_name: 'UserPromptSubmit',
  });
}

function baseDeps(overrides: Partial<HookDeps> = {}): HookDeps {
  const spawn = recordingSpawn();
  return {
    stdin: stdinFor('build me a thing'),
    env: { PROMPT_COACH_DIR: baseDir },
    hookDirname: HOOK_DIRNAME,
    spawnFn: spawn.fn,
    ...overrides,
  };
}

describe('runHook — recursion guard (§8.1 top guard)', () => {
  it('PROMPT_COACH_JUDGING set -> exit 0, NO spawn, NO inbox', () => {
    const { fn, calls } = recordingSpawn();
    runHook(
      baseDeps({
        env: { PROMPT_COACH_DIR: baseDir, PROMPT_COACH_JUDGING: '1' },
        spawnFn: fn,
      }),
    );
    expect(calls).toHaveLength(0);
    // No inbox dir was created.
    expect(readdirSync(baseDir)).not.toContain('inbox');
  });
});

describe('runHook — disabled state (§8.1 kill switch)', () => {
  it('state.enabled === false -> no spawn', () => {
    const store = createStore(baseDir);
    store.saveState({ ...store.getState(), enabled: false });
    const { fn, calls } = recordingSpawn();
    runHook(baseDeps({ spawnFn: fn }));
    expect(calls).toHaveLength(0);
  });
});

describe('runHook — (1) drain (§8.1, §8.2, §7.4 quality-before-habit)', () => {
  it('prints a waiting tip to stdout and clears the mailbox', () => {
    const store = createStore(baseDir);
    store.writeMailbox('sess-1', { kind: 'quality', message: 'WAITING QUALITY TIP' });
    const written: string[] = [];
    const out = {
      write(c: string): boolean {
        written.push(c);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    runHook(baseDeps({ out, spawnFn: recordingSpawn().fn }));

    expect(written.join('')).toContain('WAITING QUALITY TIP');
    // Mailbox cleared.
    expect(store.readAndClearMailbox('sess-1')).toHaveLength(0);
  });

  it('prints the QUALITY tip before a HABIT tip when both are queued', () => {
    const store = createStore(baseDir);
    // Insert habit FIRST, then quality, to prove ordering is by kind not insertion.
    store.writeMailbox('sess-1', { kind: 'habit', message: 'HABIT NUDGE' });
    store.writeMailbox('sess-1', { kind: 'quality', message: 'QUALITY TIP' });
    const written: string[] = [];
    const out = {
      write(c: string): boolean {
        written.push(c);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    runHook(baseDeps({ out, spawnFn: recordingSpawn().fn }));

    expect(written.join('')).toContain('QUALITY TIP');
    expect(written.join('')).not.toContain('HABIT NUDGE');
  });

  it('re-queues the un-surfaced tail instead of silently dropping it (single banner/turn, no loss)', () => {
    const store = createStore(baseDir);
    // Two tips queued; the drain surfaces only the highest-priority one this turn.
    store.writeMailbox('sess-1', { kind: 'quality', message: 'QUALITY TIP' });
    store.writeMailbox('sess-1', { kind: 'habit', message: 'HABIT NUDGE' });
    const written: string[] = [];
    const out = { write(c: string): boolean { written.push(c); return true; } } as unknown as NodeJS.WriteStream;

    runHook(baseDeps({ out, spawnFn: recordingSpawn().fn }));

    // One banner this turn (the quality tip); the habit tip was NOT lost — it is back in
    // the mailbox for the next drain rather than garbage-collected.
    expect(written.join('')).toContain('QUALITY TIP');
    expect(written.join('')).not.toContain('HABIT NUDGE');
    const remaining = store.claimMailbox('sess-1');
    expect(remaining.map((t) => t.message)).toEqual(['HABIT NUDGE']);
  });
});

describe('runHook — (0) synchronous sentinel (the true hello-world health check)', () => {
  it('prints `make lemonade!` SAME-TURN when the sentinel phrase is typed (no judge spawn)', () => {
    const written: string[] = [];
    const out = {
      write(c: string): boolean { written.push(c); return true; },
    } as unknown as NodeJS.WriteStream;
    const spawn = recordingSpawn();

    runHook(baseDeps({ stdin: stdinFor('when life gives you lemons'), out, spawnFn: spawn.fn }));

    // The banner prints immediately, this turn — not via the mailbox/next-turn path.
    expect(written.join('')).toContain('make lemonade!');
    expect(written.join('')).toContain('Boris says');
    // And NO background judge was spawned (pure synchronous — works even if claude -p is down).
    expect(spawn.calls).toHaveLength(0);
  });

  it('is case/whitespace tolerant ("  When Life Gives You Lemons  ")', () => {
    const written: string[] = [];
    const out = { write(c: string): boolean { written.push(c); return true; } } as unknown as NodeJS.WriteStream;
    runHook(baseDeps({ stdin: stdinFor('  When Life Gives You Lemons  '), out, spawnFn: recordingSpawn().fn }));
    expect(written.join('')).toContain('make lemonade!');
  });

  it('a NON-sentinel prompt does NOT short-circuit (it detaches the judge as usual)', () => {
    const spawn = recordingSpawn();
    runHook(baseDeps({ stdin: stdinFor('build me a thing'), spawnFn: spawn.fn }));
    expect(spawn.calls).toHaveLength(1); // normal path: judge spawned.
  });
});

describe('runHook — (2) detach (§8.1, §8.4)', () => {
  it('writes an inbox file with the full payload and spawns node detached+unref', () => {
    const { fn, calls } = recordingSpawn();
    runHook(baseDeps({ stdin: stdinFor('detach me', 'sess-2'), spawnFn: fn }));

    // Inbox file written under <base>/inbox.
    const inboxDir = join(baseDir, 'inbox');
    const files = readdirSync(inboxDir);
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf8'));
    expect(payload).toMatchObject({
      prompt: 'detach me',
      transcript_path: '/tmp/some-session.jsonl',
      session_id: 'sess-2',
      cwd: '/work/dir',
    });
    // M2: the hook also mints + rides the per-turn id (see the turn-minting suite below).
    expect(typeof payload.turn_id).toBe('string');

    // One spawn, node, detached, unref'd.
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('node');
    expect(calls[0].options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(calls[0].unrefed).toBe(true);
  });

  it('spawns [judgePath, inboxPath] where judgePath is ANCHORED (not cwd-relative)', () => {
    const { fn, calls } = recordingSpawn();
    runHook(baseDeps({ spawnFn: fn }));
    const [judgePath, inboxPath] = calls[0].args;
    // Anchored to the hook's own dist dir when CLAUDE_PLUGIN_ROOT is unset.
    expect(judgePath).toBe(join(HOOK_DIRNAME, 'judge.js'));
    expect(judgePath.startsWith('/')).toBe(true);
    expect(judgePath).not.toBe('dist/judge.js');
    // inboxPath points at the written inbox file.
    expect(inboxPath).toContain(join(baseDir, 'inbox'));
  });

  it('anchors judgePath to CLAUDE_PLUGIN_ROOT/dist/judge.js when set', () => {
    const { fn, calls } = recordingSpawn();
    runHook(
      baseDeps({
        env: { PROMPT_COACH_DIR: baseDir, CLAUDE_PLUGIN_ROOT: '/opt/plugin-root' },
        spawnFn: fn,
      }),
    );
    expect(calls[0].args[0]).toBe(join('/opt/plugin-root', 'dist', 'judge.js'));
  });

  it('does NOT set PROMPT_COACH_JUDGING on the spawned child (the judge needs the LLM)', () => {
    // The spawn seam is called with NO env option at all (the judge inherits the parent
    // env minus any explicit override). We assert the options object carries no env.
    const { fn, calls } = recordingSpawn();
    runHook(baseDeps({ spawnFn: fn }));
    expect((calls[0].options as Record<string, unknown>).env).toBeUndefined();
  });
});

describe('runHook — hard rule: never throws (§8.1)', () => {
  it('an internal error (spawn throws) -> still no throw, still exit-0 path', () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error('spawn boom');
    };
    expect(() => runHook(baseDeps({ spawnFn: throwingSpawn }))).not.toThrow();
  });

  it('malformed stdin -> no throw, no spawn', () => {
    const { fn, calls } = recordingSpawn();
    expect(() => runHook(baseDeps({ stdin: 'not json at all', spawnFn: fn }))).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('missing prompt -> no spawn', () => {
    const { fn, calls } = recordingSpawn();
    runHook(baseDeps({ stdin: JSON.stringify({ session_id: 'x' }), spawnFn: fn }));
    expect(calls).toHaveLength(0);
  });
});

describe('runHook — does NOT run the cascade itself', () => {
  it('never calls the LLM/store cascade methods — only drain + beginTurn + writeInbox + spawn', () => {
    // A spy store proving the hook touches ONLY claimMailbox + beginTurn + writeInbox +
    // getState (+ the outcome-recap first-attempt flag). M2 moved the drain to the atomic
    // claimMailbox and added the per-turn marker; judging stays the judge's job.
    const real = createStore(baseDir);
    const touched: string[] = [];
    const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
      (...a: A): R => {
        touched.push(name);
        return fn(...a);
      };
    const spyStore: Store = {
      getState: track('getState', real.getState),
      saveState: track('saveState', real.saveState),
      markQualityTip: track('markQualityTip', real.markQualityTip),
      markHabitNudge: track('markHabitNudge', real.markHabitNudge),
      qualityOnCooldown: real.qualityOnCooldown,
      habitOnCooldown: real.habitOnCooldown,
      leverUsedInSession: real.leverUsedInSession,
      writeMailbox: track('writeMailbox', real.writeMailbox),
      readAndClearMailbox: track('readAndClearMailbox', real.readAndClearMailbox),
      claimMailbox: track('claimMailbox', real.claimMailbox),
      beginTurn: track('beginTurn', real.beginTurn),
      currentTurn: track('currentTurn', real.currentTurn),
      markTurnJudged: track('markTurnJudged', real.markTurnJudged),
      wasTurnJudged: track('wasTurnJudged', real.wasTurnJudged),
      writeInbox: track('writeInbox', real.writeInbox),
      readAndUnlinkInbox: track('readAndUnlinkInbox', real.readAndUnlinkInbox),
      recordLastTip: track('recordLastTip', real.recordLastTip),
      rateLastTip: track('rateLastTip', real.rateLastTip),
      undoLastRating: track('undoLastRating', real.undoLastRating),
      markGreetedIfFirst: track('markGreetedIfFirst', real.markGreetedIfFirst),
      markOutcomeRecapShownIfFirst: track('markOutcomeRecapShownIfFirst', real.markOutcomeRecapShownIfFirst),
      floorDeltaForLever: real.floorDeltaForLever,
    };
    runHook(baseDeps({ store: spyStore, spawnFn: recordingSpawn().fn }));
    // The hook deposits NO tip and records NO cooldown/lever/judged-marker — the judge's job.
    expect(touched).not.toContain('markQualityTip');
    expect(touched).not.toContain('markHabitNudge');
    expect(touched).not.toContain('writeMailbox');
    expect(touched).not.toContain('readAndUnlinkInbox');
    expect(touched).not.toContain('markTurnJudged');
    expect(touched).not.toContain('markGreetedIfFirst'); // the welcome flag belongs to the judge.
    // It DOES drain (atomic claim), mint the turn, and detach (writeInbox).
    expect(touched).toContain('claimMailbox');
    expect(touched).toContain('beginTurn');
    expect(touched).toContain('writeInbox');
  });
});

// ── M2 same-turn coaching: UPS is now the LABELED backstop + mints the turn id ──
// (PLAN §B Step 6 — the Stop hook is the primary surface; anything still in the
// mailbox at the NEXT UserPromptSubmit is by definition about a PRIOR prompt, so it
// drains with the `about your prompt: "…"` attribution label. The hook also mints a
// per-turn id, records it via beginTurn, and rides it to the judge in the inbox.)

describe('runHook — M2 labeled backstop drain (PLAN Step 6)', () => {
  function captured(): { out: NodeJS.WriteStream; text: () => string } {
    const chunks: string[] = [];
    const out = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WriteStream;
    return { out, text: () => chunks.join('') };
  }

  it('a stale tip carrying its judged prompt drains WITH the attribution label', () => {
    const store = createStore(baseDir);
    store.writeMailbox('sess-1', {
      kind: 'quality',
      message: 'STALE COACHING TIP',
      prompt: 'the prompt it judged',
      turnId: 'sess-1#old',
    });
    const { out, text } = captured();
    runHook(baseDeps({ out, spawnFn: recordingSpawn().fn }));
    expect(text()).toContain('STALE COACHING TIP');
    expect(text()).toContain('about your prompt');
    expect(text()).toContain('the prompt it judged');
  });

  it('a tip WITHOUT a judged prompt (bare ping) drains UNLABELED', () => {
    const store = createStore(baseDir);
    store.writeMailbox('sess-1', { kind: 'quality', message: 'BARE PING', turnId: 'sess-1#old' });
    const { out, text } = captured();
    runHook(baseDeps({ out, spawnFn: recordingSpawn().fn }));
    expect(text()).toContain('BARE PING');
    expect(text()).not.toContain('about your prompt');
  });

  it('the drain is the ATOMIC claim (consume-once shared with the Stop hook)', () => {
    const store = createStore(baseDir);
    store.writeMailbox('sess-1', { kind: 'quality', message: 'CLAIM ME', turnId: 'sess-1#old' });
    const { out } = captured();
    runHook(baseDeps({ out, spawnFn: recordingSpawn().fn }));
    expect(store.claimMailbox('sess-1')).toEqual([]); // gone — one surface only.
  });
});

describe('runHook — M2 turn minting (beginTurn + inbox turn_id)', () => {
  it('mints a unique per-turn id, records it via beginTurn, and writes it into the inbox payload', () => {
    const store = createStore(baseDir);
    const { fn } = recordingSpawn();
    runHook(baseDeps({ stdin: stdinFor('judge me', 'sess-t'), store, spawnFn: fn }));

    const files = readdirSync(join(baseDir, 'inbox'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(join(baseDir, 'inbox', files[0]), 'utf8'));
    expect(typeof payload.turn_id).toBe('string');
    expect(payload.turn_id.startsWith('sess-t#')).toBe(true);
    // The Stop hook finds the SAME id via the turn marker.
    expect(store.currentTurn('sess-t')).toBe(payload.turn_id);
  });

  it('two prompts mint DIFFERENT turn ids (the marker always tracks the current turn)', () => {
    const store = createStore(baseDir);
    runHook(baseDeps({ stdin: stdinFor('one', 'sess-t'), store, spawnFn: recordingSpawn().fn }));
    const first = store.currentTurn('sess-t');
    runHook(baseDeps({ stdin: stdinFor('two', 'sess-t'), store, spawnFn: recordingSpawn().fn }));
    const second = store.currentTurn('sess-t');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('the sentinel path mints NO turn (no judge spawned → the Stop hook must not poll)', () => {
    const store = createStore(baseDir);
    const { out } = captured();
    runHook(baseDeps({ stdin: stdinFor('when life gives you lemons', 'sess-t'), store, out, spawnFn: recordingSpawn().fn }));
    expect(store.currentTurn('sess-t')).toBeNull();
  });

  function captured(): { out: NodeJS.WriteStream; text: () => string } {
    const chunks: string[] = [];
    const out = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WriteStream;
    return { out, text: () => chunks.join('') };
  }
});
