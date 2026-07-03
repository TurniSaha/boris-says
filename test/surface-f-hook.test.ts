/**
 * test/surface-f-hook.test.ts — ROW F-HOOK row-level pin.
 *
 * The F-HOOK story has a "runs <100ms, non-blocking" LATENCY INTENT clause. The existing
 * suites prove non-blocking behaviorally (detach-survival.test.ts asserts the judge's
 * sentinel is ABSENT the instant runHook returns) and prove drain/detach/recursion-guard
 * structurally (hook.test.ts), but NO existing test directly MEASURES that runHook itself
 * returns fast. This file pins that gap with a wall-clock measurement over the REAL
 * shipping path: the default node:child_process spawn (no spawnFn injected), with the
 * anchored judge pointed at a throwaway script via CLAUDE_PLUGIN_ROOT — the exact code
 * path src/hook.ts ships.
 *
 * The throwaway judge sleeps so that, were runHook to (wrongly) block on it, the measured
 * latency would blow past the budget; instead we assert runHook returns far under it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, type HookDeps } from '../src/hook.js';

// The detach-survival guarantee (and thus this latency proof) is Unix-only in v1 (§8.5).
const describeUnixOnly = process.platform === 'win32' ? describe.skip : describe;

// The story's intent is "<100ms". A real spawn + JSON + file write is single-digit ms
// locally, but under a PARALLEL test run the OS spawn can be CPU-contended for tens of ms
// without runHook ever BLOCKING on the child — so a hard 100ms wall-clock assertion is
// flaky under contention (it measures scheduler jitter, not blocking). The MEANINGFUL,
// non-flaky proof of "non-blocking" is twofold and NOT timing-based: (1) the inbox file is
// written (detach ran) and (2) the sleeping child's sentinel is ABSENT on return (we did
// not await it). The wall-clock budget is therefore set to a contention-safe value STILL
// strictly below JUDGE_SLEEP_MS: a genuine BLOCKING regression (awaiting the child) would
// take >= JUDGE_SLEEP_MS and blow past it, while parallel-spawn jitter stays under it.
const JUDGE_SLEEP_MS = 300; // if runHook blocked on the child, elapsed would be >= this.
const LATENCY_BUDGET_MS = 200; // contention-safe yet < JUDGE_SLEEP_MS → a block still fails.

let workDir: string;
let pluginRoot: string;
let coachDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'coach-f-hook-'));

  pluginRoot = join(workDir, 'plugin');
  const distDir = join(pluginRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  // A real ESM judge that sleeps well past the budget, then writes a sentinel. If runHook
  // ever awaited the child, the wall-clock measurement below would exceed the budget.
  writeFileSync(
    join(distDir, 'judge.js'),
    `import { writeFileSync as w } from 'node:fs';\n` +
      `const inbox = process.argv[2];\n` +
      `setTimeout(() => { w(inbox + '.sentinel', String(Date.now())); }, ${JUDGE_SLEEP_MS});\n`,
  );

  coachDir = join(workDir, 'coach');
  mkdirSync(coachDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function depsWithRealSpawn(prompt = 'pin the latency intent'): HookDeps {
  return {
    stdin: JSON.stringify({
      session_id: 'f-hook-sess',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/work',
      prompt,
      hook_event_name: 'UserPromptSubmit',
    }),
    env: { PROMPT_COACH_DIR: coachDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
    hookDirname: join(pluginRoot, 'dist'),
    // NO spawnFn -> the REAL default node:child_process spawn (detached+unref) runs.
  };
}

describeUnixOnly('ROW F-HOOK — runHook latency intent (<100ms, non-blocking)', () => {
  it('returns far under the latency budget over the REAL spawn path (does not block on the judge)', () => {
    const deps = depsWithRealSpawn();

    const start = process.hrtime.bigint();
    runHook(deps);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // The hook must return well under the budget even though the spawned judge sleeps
    // JUDGE_SLEEP_MS (> budget). Blocking on the child would push elapsedMs past the cap.
    expect(elapsedMs).toBeLessThan(LATENCY_BUDGET_MS);

    // And it actually took the real detach path: the inbox file was written for the child.
    const inboxFiles = readdirSync(join(coachDir, 'inbox'));
    expect(inboxFiles).toHaveLength(1);

    // Non-blocking proof: the sleeping child's sentinel is ABSENT the instant we return.
    const sentinel = `${join(coachDir, 'inbox', inboxFiles[0])}.sentinel`;
    expect(existsSync(sentinel)).toBe(false);
  });

  it('the recursion-guarded path (PROMPT_COACH_JUDGING set) returns near-instantly with no spawn', () => {
    const deps: HookDeps = {
      ...depsWithRealSpawn(),
      env: { PROMPT_COACH_DIR: coachDir, CLAUDE_PLUGIN_ROOT: pluginRoot, PROMPT_COACH_JUDGING: '1' },
    };

    const start = process.hrtime.bigint();
    runHook(deps);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(elapsedMs).toBeLessThan(LATENCY_BUDGET_MS);
    // Guarded -> no inbox dir/file created at all (it returned before drain/detach).
    expect(existsSync(join(coachDir, 'inbox'))).toBe(false);
  });
});
