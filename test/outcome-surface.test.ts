/**
 * outcome-surface.test.ts — W2-OUTCOME (Phase 1): the SessionEnd → global file → next
 * SessionStart surfacing, plus the consume-once + idempotency contract of outcome-store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_JSONL_BYTES } from '../src/jsonl/read-capped.js';
import {
  writeLastOutcome,
  readPendingOutcome,
  markOutcomeConsumed,
  type OutcomeFile,
} from '../src/brain/outcome-store.js';
import { runSessionOutcome } from '../src/session-outcome.js';
import { runHook } from '../src/hook.js';
import { createStore } from '../src/state/store.js';
import type { LlmBackend } from '../src/llm/backend.js';
import { projectKeyForCwd } from '../src/config.js';

/** A stub backend that returns a canned summary (or null / throws) with ZERO spawn. */
function stubBackend(result: string | null | (() => never)): LlmBackend {
  return {
    configured: true,
    async complete() {
      if (typeof result === 'function') return result();
      return result;
    },
  };
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-outcome-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const PK = '/users/x/proja'; // a project key (normalized cwd form).
const PK_B = '/users/x/projb';

function rec(over: Partial<OutcomeFile> = {}): OutcomeFile {
  return {
    line: 'Last session: 53 tests passed.',
    endedSessionId: 'sess-A',
    projectKey: PK,
    consumed: false,
    at: 1000,
    ...over,
  };
}

// ── outcome-store contract ────────────────────────────────────────────────────

describe('W2-OUTCOME — outcome-store (consume-once + idempotency + project scoping)', () => {
  it('write → a DIFFERENT session in the SAME project reads it pending', () => {
    writeLastOutcome(baseDir, rec());
    const pending = readPendingOutcome(baseDir, 'sess-B', PK);
    expect(pending).not.toBeNull();
    expect(pending?.line).toContain('53 tests passed');
  });

  it('CROSS-PROJECT LEAK FIX: a record from project A is NOT surfaced to a session in project B', () => {
    writeLastOutcome(baseDir, rec({ projectKey: PK }));
    expect(readPendingOutcome(baseDir, 'sess-B', PK_B)).toBeNull(); // different project → never.
  });

  it('an unscoped record (no/empty projectKey) is never surfaced (fail-safe)', () => {
    writeLastOutcome(baseDir, rec({ projectKey: '' }));
    expect(readPendingOutcome(baseDir, 'sess-B', PK)).toBeNull();
    // and a current key of '' never matches anything either:
    writeLastOutcome(baseDir, rec({ endedSessionId: 'sess-C', projectKey: PK }));
    expect(readPendingOutcome(baseDir, 'sess-B', '')).toBeNull();
  });

  it('the SAME (ended) session never reads its own record', () => {
    writeLastOutcome(baseDir, rec({ endedSessionId: 'sess-A' }));
    expect(readPendingOutcome(baseDir, 'sess-A', PK)).toBeNull();
  });

  it('consume-once: after markOutcomeConsumed, the next read is null', () => {
    writeLastOutcome(baseDir, rec());
    expect(readPendingOutcome(baseDir, 'sess-B', PK)).not.toBeNull();
    markOutcomeConsumed(baseDir);
    expect(readPendingOutcome(baseDir, 'sess-B', PK)).toBeNull();
  });

  it('idempotent on the ended session id: a re-write for the SAME ended id does not clobber/reset', () => {
    writeLastOutcome(baseDir, rec({ line: 'first', endedSessionId: 'sess-A' }));
    markOutcomeConsumed(baseDir); // simulate it was already surfaced.
    // A compact-then-exit re-fire for the SAME ended session must NOT resurrect it.
    writeLastOutcome(baseDir, rec({ line: 'second-different', endedSessionId: 'sess-A' }));
    expect(readPendingOutcome(baseDir, 'sess-B', PK)).toBeNull(); // stays consumed.
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toBe('first'); // first write wins (idempotent).
  });

  it('an empty-line record is never surfaced', () => {
    writeLastOutcome(baseDir, rec({ line: '' }));
    expect(readPendingOutcome(baseDir, 'sess-B', PK)).toBeNull();
  });

  it('missing file → readPendingOutcome null (never throws)', () => {
    expect(readPendingOutcome(baseDir, 'sess-B', PK)).toBeNull();
  });
});

// ── SessionEnd entrypoint ──────────────────────────────────────────────────────

describe('W2-OUTCOME — runSessionOutcome (SessionEnd)', () => {
  const jsonlWithTests = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  53 passed (53)', stderr: '', interrupted: false } }),
  ].join('\n');

  it('computes + writes the global outcome file (with projectKey from cwd) from the ended JSONL', async () => {
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'sess-A', transcript_path: '/fake.jsonl', cwd: '/Users/x/ProjA/' }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 5000,
    });
    expect(existsSync(join(baseDir, 'last-outcome.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('53 tests passed');
    expect(onDisk.endedSessionId).toBe('sess-A');
    expect(onDisk.consumed).toBe(false);
    // The projectKey is the normalized cwd (trailing slash stripped; case-folded on darwin/win).
    expect(typeof onDisk.projectKey).toBe('string');
    expect(onDisk.projectKey.length).toBeGreaterThan(0);
    expect(onDisk.projectKey.endsWith('/')).toBe(false);
  });

  it('the DEFAULT transcript reader is byte-capped: a >32MiB session .jsonl is skipped (no OOM), writes nothing', async () => {
    // Finish the 32MiB-read-cap hardening: the SessionEnd default reader must go through
    // readFileCapped like every other transcript/corpus read, so a pathologically huge
    // session file is skipped rather than read whole into the detached process.
    const huge = join(baseDir, 'huge-transcript.jsonl');
    // A genuine test-pass signal at the TOP (paired tool_use + tool_result). If the reader
    // were UNCAPPED it would read the whole file, find this, and WRITE a "53 tests passed"
    // line; the cap must skip the oversized file so NOTHING is written.
    const head =
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  53 passed (53)', stderr: '', interrupted: false } }) + '\n';
    // Pad with blank lines (skipped by the scanner) until the file exceeds the cap.
    const filler = '\n'.repeat(MAX_JSONL_BYTES + 1 - head.length);
    writeFileSync(huge, head + filler);
    // No injected readTranscript → exercises the real defaultReadTranscript.
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'sess-A', transcript_path: huge, cwd: '/Users/x/ProjA/' }),
      env: { PROMPT_COACH_DIR: baseDir },
      now: () => 5000,
    });
    expect(existsSync(join(baseDir, 'last-outcome.json'))).toBe(false);
  });

  it('writes NOTHING when there is no measured signal (honesty: no fabricated line)', async () => {
    const noSignal = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: 'file', stderr: '', interrupted: false } }),
    ].join('\n');
    await runSessionOutcome({ stdin: JSON.stringify({ session_id: 'sess-A', transcript_path: '/f' }), env: { PROMPT_COACH_DIR: baseDir }, readTranscript: () => noSignal });
    expect(existsSync(join(baseDir, 'last-outcome.json'))).toBe(false);
  });

  it('unparseable / no-transcript stdin → no-op (never throws)', () => {
    expect(() => runSessionOutcome({ stdin: 'not json', env: { PROMPT_COACH_DIR: baseDir } })).not.toThrow();
    expect(() => runSessionOutcome({ stdin: JSON.stringify({ session_id: 's' }), env: { PROMPT_COACH_DIR: baseDir } })).not.toThrow();
    expect(existsSync(join(baseDir, 'last-outcome.json'))).toBe(false);
  });
});

// ── End-to-end: SessionEnd writes, next session's hook surfaces it once ────────

describe('W2-OUTCOME — end-to-end SessionEnd → next-session hook surfaces once', () => {
  const jsonlWithTests = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  7 passed (7)', stderr: '', interrupted: false } }),
  ].join('\n');

  const CWD = '/Users/x/ProjA';

  it('the line surfaces on the NEXT SAME-PROJECT session\'s first prompt, exactly once', () => {
    // Session A ends in project CWD → write (projectKey from cwd).
    runSessionOutcome({ stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }), env: { PROMPT_COACH_DIR: baseDir }, readTranscript: () => jsonlWithTests, now: () => 1 });

    // Session B's first prompt IN THE SAME PROJECT → the hook surfaces it. An ENGAGED store
    // (a returning user, by definition — mirrors makeEngagedStore) so the FIX-1 tour-defer
    // guard does not skip the recap this turn.
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const store = createStore(baseDir);
    store.markGreetedIfFirst('prior'); // engagement marker → not a fresh pre-tour install.
    const hookStdin = JSON.stringify({ session_id: 'B', transcript_path: '/b.jsonl', cwd: CWD, prompt: 'hello' });

    runHook({ stdin: hookStdin, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    expect(captured.join('')).toContain('7 tests passed');

    // Second prompt in session B → first-prompt gate + consumed → not shown again.
    captured.length = 0;
    runHook({ stdin: hookStdin, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    expect(captured.join('')).not.toContain('7 tests passed');
  });

  it('CROSS-PROJECT: a recap written by project A does NOT surface in a project B session (the bug fix)', () => {
    // Project A (the CWD above) ends → writes its recap.
    runSessionOutcome({ stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }), env: { PROMPT_COACH_DIR: baseDir }, readTranscript: () => jsonlWithTests, now: () => 1 });

    // A session in a DIFFERENT project prompts → the A recap must NOT appear.
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const store = createStore(baseDir);
    const otherProject = JSON.stringify({ session_id: 'B', transcript_path: '/b.jsonl', cwd: '/Users/x/OtherProject', prompt: 'hello' });

    runHook({ stdin: otherProject, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    expect(captured.join('')).not.toContain('7 tests passed'); // the leak is closed.
  });

  it('a session with NO cwd never surfaces a recap (fail-safe)', () => {
    runSessionOutcome({ stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }), env: { PROMPT_COACH_DIR: baseDir }, readTranscript: () => jsonlWithTests, now: () => 1 });
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const store = createStore(baseDir);
    const noCwd = JSON.stringify({ session_id: 'B', transcript_path: '/b.jsonl', prompt: 'hello' }); // no cwd
    runHook({ stdin: noCwd, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    expect(captured.join('')).not.toContain('7 tests passed');
  });
});

// ── The DEMOTED L34b: the retrospective prune clause rides the recap end-to-end ─

describe('W2-OUTCOME — demoted L34b prune clause (SessionEnd → next same-project session, once)', () => {
  /** An Edit tool_use + result pair with `addedLines` '+' lines in its structuredPatch. */
  function bigEditPair(n: number, filePath: string, addedLines: number): string {
    const tuid = `edit_${n}`;
    const lines = Array.from({ length: addedLines }, (_, i) => `+line ${i}`);
    return [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Edit', input: { file_path: filePath } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid }] }, toolUseResult: { filePath, structuredPatch: [{ lines }] } }),
    ].join('\n');
  }

  // A bloated, UNCOMMITTED session: 4 files × 40 added lines = 160 added across 4 files
  // (over the 120-added / 3-files floor), and no commit event anywhere.
  const bloatedJsonl = [1, 2, 3, 4].map((n) => bigEditPair(n, `/proj/f${n}.ts`, 40)).join('\n');

  const CWD = '/Users/x/ProjA';

  function promptOnce(sessionId: string, cwd: string): string {
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const store = createStore(baseDir);
    store.markGreetedIfFirst('prior'); // engaged install → FIX-1 tour-defer does not skip the recap.
    const stdin = JSON.stringify({ session_id: sessionId, transcript_path: '/b.jsonl', cwd, prompt: 'hello' });
    runHook({ stdin, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    return captured.join('');
  }

  it('a bloated uncommitted session writes recap+clause; the next same-project first prompt shows it EXACTLY once; other projects never', () => {
    // SessionEnd: the ended session's OWN agent edits are the change-size source (honest
    // attribution by construction — never the pre-existing dirty tree).
    runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => bloatedJsonl,
      now: () => 1,
    });
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('worth a skim');
    expect(onDisk.line).toContain('4 files changed');

    // A DIFFERENT-project session never sees it (project scoping).
    expect(promptOnce('C', '/Users/x/OtherProject')).not.toContain('worth a skim');

    // The next SAME-project session's FIRST prompt surfaces it…
    const first = promptOnce('B', CWD);
    expect(first).toContain('worth a skim');
    // …and the SECOND prompt (same session) shows nothing (consume-once).
    expect(promptOnce('B', CWD)).not.toContain('worth a skim');
    // A later same-project session sees nothing either (consumed for good — one bloat
    // episode = one session = exactly one line).
    expect(promptOnce('D', CWD)).not.toContain('worth a skim');
  });

  it('a bloated but COMMITTED session writes a recap WITHOUT the prune clause', () => {
    const committedJsonl = [
      bloatedJsonl,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'git commit -m x' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1' }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abc1234', kind: 'committed' } } } }),
    ].join('\n');
    runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => committedJsonl,
      now: () => 1,
    });
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('committed');
    expect(onDisk.line).not.toContain('worth a skim');
  });
});

// ── M2: the STRICT first-attempt gate (shared helper, PLAN Step 7) ──────────────
// The gate flag is consumed on a session's FIRST surfacing attempt regardless of
// whether a record was pending — so a recap that lands MID-SESSION can never pop
// mid-session; it waits for the NEXT session's first prompt. Both UPS and Stop go
// through the ONE shared helper (surfaceOutcomeRecap), so the gates cannot diverge.

// ── FIX 1: the first-run TOUR wins a new user's first message ───────────────────
// On a genuinely fresh, un-toured install the recap must DEFER to the tour: it is
// skipped this turn (a pure read of !tourShown && !engaged) but NOT consumed — it
// still surfaces on the NEXT project-return. An ENGAGED install (owner's shape) never
// sees the tour, so its recap behavior is UNCHANGED (regression pin).

describe('FIX 1 — first-run tour wins the first message (recap defers on a pre-tour install)', () => {
  const jsonlWithTests = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  7 passed (7)', stderr: '', interrupted: false } }),
  ].join('\n');
  const CWD = '/Users/x/ProjA';

  function writeRecap(): void {
    runSessionOutcome({ stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }), env: { PROMPT_COACH_DIR: baseDir }, readTranscript: () => jsonlWithTests, now: () => 1 });
  }

  function promptOnce(store: ReturnType<typeof createStore>, sessionId: string): string {
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const stdin = JSON.stringify({ session_id: sessionId, transcript_path: '/b.jsonl', cwd: CWD, prompt: 'hello' });
    runHook({ stdin, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    return captured.join('');
  }

  /** Simulate an engaged install (owner's shape: greeted a prior session + toured + a rating). */
  function makeEngagedStore(): ReturnType<typeof createStore> {
    const store = createStore(baseDir);
    store.markGreetedIfFirst('prior-session'); // engagement marker
    store.markTourShownIfFirst();              // tour already shown (tourShown=true)
    return store;
  }

  it('a FRESH pre-tour install returning to a project SKIPS the recap this turn (tour wins) — record stays pending for the next return', () => {
    writeRecap();
    // Fresh install: no engagement, tourShown=false → the tour will show, so the recap defers.
    const store = createStore(baseDir);
    expect(promptOnce(store, 'B')).not.toContain('7 tests passed'); // recap SKIPPED this turn.
    // NOT consumed: a later project-return on a now-engaged/toured install surfaces it once.
    // (The tour runs in the detached judge, faked here — so materialize the post-tour engaged
    // shape explicitly, mirroring makeEngagedStore.)
    const engaged = makeEngagedStore(); // post-tour / engaged install
    expect(promptOnce(engaged, 'C')).toContain('7 tests passed');
  });

  it('the deferred recap is still on disk & unconsumed after the tour turn', () => {
    writeRecap();
    const store = createStore(baseDir);
    promptOnce(store, 'B'); // tour turn — recap deferred, not consumed
    const pending = readPendingOutcome(baseDir, 'later-session', PK); // PK unused here; read raw
    // The record is still present & unconsumed (a different-project read is null, but the file exists).
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.consumed).toBe(false);
    void pending;
  });

  it('REGRESSION: an ENGAGED install (owner shape: greeted/toured/rated) STILL fires the recap on its first prompt', () => {
    writeRecap();
    const store = makeEngagedStore();
    expect(promptOnce(store, 'B')).toContain('7 tests passed'); // engaged never tours → recap unchanged.
  });
});

describe('M2 — strict first-prompt-only recap gate (mid-session records never pop)', () => {
  const jsonlWithTests = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  7 passed (7)', stderr: '', interrupted: false } }),
  ].join('\n');
  const CWD = '/Users/x/ProjA';

  function promptOnce(store: ReturnType<typeof createStore>, sessionId: string): string {
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const stdin = JSON.stringify({ session_id: sessionId, transcript_path: '/b.jsonl', cwd: CWD, prompt: 'hello' });
    runHook({ stdin, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    return captured.join('');
  }

  it('a record landing AFTER a session\'s first prompt does NOT pop mid-session — it waits for the NEXT session', () => {
    const store = createStore(baseDir);
    store.markGreetedIfFirst('prior'); // engaged install → FIX-1 tour-defer does not skip the recap.
    // Session B's FIRST prompt: no record pending yet → nothing shown, gate consumed.
    expect(promptOnce(store, 'B')).not.toContain('7 tests passed');
    // NOW a same-project session ends and writes its recap.
    runSessionOutcome({ stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }), env: { PROMPT_COACH_DIR: baseDir }, readTranscript: () => jsonlWithTests, now: () => 1 });
    // Session B's SECOND prompt: mid-session → must NOT pop (the shipped hotfix would have).
    expect(promptOnce(store, 'B')).not.toContain('7 tests passed');
    // A NEW session's first prompt: surfaces it exactly once.
    expect(promptOnce(store, 'C')).toContain('7 tests passed');
    expect(promptOnce(store, 'C')).not.toContain('7 tests passed');
  });
});

// ── TIER 3: "what it was about" summary (generated at SessionEnd, rendered at recall) ─
//
// A ≤2-line plain-English recap of the last session, generated by ONE bounded claude -p
// call at SessionEnd (backend injected so tests never spawn), stored on the outcome
// record, and rendered as a 3rd banner line under the facts on same-project return.
// Degrades to facts-only on: no backend / null / throw / empty / >200 chars.

describe('TIER 3 — SessionEnd generates + stores the "what it was about" summary', () => {
  const jsonlWithTests = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  12 passed (12)', stderr: '', interrupted: false } }),
  ].join('\n');
  const CWD = '/Users/x/ProjA';

  function endSession(backend: LlmBackend | undefined): Promise<void> {
    return runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 1,
      backend,
    });
  }

  it('an injected backend returning a summary stores it on the record (with the facts)', async () => {
    await endSession(stubBackend('You were adding OAuth to the login flow and left token-refresh untested.'));
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('12 tests passed'); // facts still computed.
    expect(onDisk.summary).toContain('adding OAuth');
  });

  it('backend returning null → no summary field (facts still written), still exits cleanly', async () => {
    await endSession(stubBackend(null));
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('12 tests passed');
    expect(onDisk.summary ?? '').toBe('');
  });

  it('backend that THROWS → no summary field, record still written, never throws', async () => {
    await expect(endSession(stubBackend(() => { throw new Error('boom'); }))).resolves.toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('12 tests passed');
    expect(onDisk.summary ?? '').toBe('');
  });

  it('backend returning empty / whitespace → no summary field', async () => {
    await endSession(stubBackend('   \n  '));
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.summary ?? '').toBe('');
  });

  it('backend returning >200 chars → dropped (no summary field)', async () => {
    await endSession(stubBackend('x'.repeat(201)));
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.summary ?? '').toBe('');
  });

  it('FACTS-FIRST (user-safety): a HUNG backend never delays or loses the facts', async () => {
    // The core of the adversarial HIGH: a never-resolving summary call must NOT block the facts.
    // With facts-first ordering the record exists the instant the write completes; the bounded
    // summary patch resolves via the timeout and the facts are intact either way.
    const hung: LlmBackend = {
      configured: true,
      complete: () => new Promise(() => {}), // never resolves — mimics a hung claude -p child.
    };
    const t0 = Date.now();
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 1,
      backend: hung,
      summaryTimeoutMs: 20, // tight bound so the test is fast; proves the race resolves.
    });
    expect(Date.now() - t0).toBeLessThan(500); // resolved via the bound, not hung.
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('12 tests passed'); // FACTS SURVIVE the hung summary.
    expect(onDisk.summary ?? '').toBe(''); // no summary — but never at the cost of the facts.
  });

  it('NO backend at all → no summary field, facts still written (graceful degrade)', async () => {
    await endSession(undefined);
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('12 tests passed');
    expect(onDisk.summary ?? '').toBe('');
  });

  it('the summary call is bounded: a backend that never resolves does NOT hang SessionEnd', async () => {
    const hanging: LlmBackend = { configured: true, complete: () => new Promise<string | null>(() => {}) };
    // With a tiny injected timeout budget the call must resolve (facts written, no summary).
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 1,
      backend: hanging,
      summaryTimeoutMs: 20,
    });
    const onDisk = JSON.parse(readFileSync(join(baseDir, 'last-outcome.json'), 'utf8'));
    expect(onDisk.line).toContain('12 tests passed');
    expect(onDisk.summary ?? '').toBe('');
  });
});

describe('TIER 3 — recall renders the summary as a 3rd line under the facts, same-project only', () => {
  const jsonlWithTests = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { stdout: '      Tests  12 passed (12)', stderr: '', interrupted: false } }),
  ].join('\n');
  const CWD = '/Users/x/ProjA';

  function promptOnce(store: ReturnType<typeof createStore>, sessionId: string, cwd = CWD): string {
    store.markGreetedIfFirst('prior'); // engaged install → FIX-1 tour-defer does not skip the recap.
    const captured: string[] = [];
    const fakeOut = { write: (s: string) => { captured.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const stdin = JSON.stringify({ session_id: sessionId, transcript_path: '/b.jsonl', cwd, prompt: 'hello' });
    runHook({ stdin, env: { PROMPT_COACH_DIR: baseDir }, hookDirname: baseDir, store, spawnFn: () => ({ unref() {} }), out: fakeOut });
    return captured.join('');
  }

  it('surfaces the facts AND the summary line on same-project return', async () => {
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 1,
      backend: stubBackend('You were adding OAuth to the login flow.'),
    });
    const out = promptOnce(createStore(baseDir), 'B');
    expect(out).toContain('12 tests passed');
    expect(out).toContain('adding OAuth to the login flow');
  });

  it('a DIFFERENT project first prompt does NOT show this project summary (scoping pin)', async () => {
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 1,
      backend: stubBackend('You were adding OAuth to the login flow.'),
    });
    const out = promptOnce(createStore(baseDir), 'B', '/Users/x/OtherProject');
    expect(out).not.toContain('adding OAuth');
  });

  it('a legacy outcome record WITHOUT the summary field loads + surfaces facts only', () => {
    // Hand-write a legacy record (no `summary` key at all).
    writeLastOutcome(baseDir, { line: 'Last time here: 5 tests passed.', endedSessionId: 'old', projectKey: projectKeyForCwd(CWD), consumed: false, at: 1 });
    const out = promptOnce(createStore(baseDir), 'B');
    expect(out).toContain('5 tests passed'); // facts render; no crash on the missing field.
  });

  it('REGRESSION: a project-return renders EXACTLY ONE Boris title line (recap subsumes liveness, not two)', async () => {
    await runSessionOutcome({
      stdin: JSON.stringify({ session_id: 'A', transcript_path: '/f', cwd: CWD }),
      env: { PROMPT_COACH_DIR: baseDir },
      readTranscript: () => jsonlWithTests,
      now: () => 1,
      backend: stubBackend('You were adding OAuth to the login flow.'),
    });
    const out = promptOnce(createStore(baseDir), 'B');
    const titleCount = out.split("Boris says: I'm in your corner!").length - 1;
    expect(titleCount).toBe(1); // one banner carries title + facts + summary — never a doubled title.
  });
});
