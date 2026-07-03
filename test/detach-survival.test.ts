/**
 * test/detach-survival.test.ts — the §8.5 detach-survival property, proven with a
 * REAL node:child_process spawn (NOT the recording seam used by hook.test.ts).
 *
 * The single most failure-prone runtime property of the coach is that the detached,
 * unref'd judge child OUTLIVES the hook process. A mock spawn can never prove this — it
 * returns a fake handle and runs nothing. So this file drives runHook with its REAL
 * default spawnFn (we inject NO spawnFn) and points the anchored judge path at a
 * throwaway script via CLAUDE_PLUGIN_ROOT: resolveJudgePath() resolves the judge to
 * `${CLAUDE_PLUGIN_ROOT}/dist/judge.js`, so we plant our sentinel-writer there and let
 * the real spawn launch it — the exact code path src/hook.ts ships.
 *
 * The throwaway judge sleeps ~150ms then writes a sentinel file next to the inbox path
 * it is given as argv[2]. We assert:
 *   (1) the sentinel does NOT exist the instant runHook returns (parent did not block);
 *   (2) the sentinel DOES appear within ~2s of polling — the unref'd detached child ran
 *       to completion AFTER the parent's spawn call returned, i.e. child outlives parent.
 *
 * v1 platform scope (§8.5): macOS + Linux only. Windows is best-effort, out of v1
 * acceptance (a child can be tied to the parent's job object), so the suite is skipped
 * there rather than asserting a property the platform does not guarantee.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, type HookDeps } from '../src/hook.js';

// §8.5: Windows is out of v1 acceptance for the detach-survival guarantee.
const describeUnixOnly = process.platform === 'win32' ? describe.skip : describe;

const SLEEP_MS = 150;

let workDir: string;
let pluginRoot: string;
let coachDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'coach-detach-'));

  // resolveJudgePath() -> `${CLAUDE_PLUGIN_ROOT}/dist/judge.js`, so plant the throwaway
  // judge at exactly that anchored location. The package is ESM, so judge.js is ESM too.
  pluginRoot = join(workDir, 'plugin');
  const distDir = join(pluginRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'judge.js'),
    // argv[2] = the inbox file the hook wrote; sleep, then write a sibling sentinel.
    `import { writeFileSync as w } from 'node:fs';\n` +
      `const inbox = process.argv[2];\n` +
      `setTimeout(() => { w(inbox + '.sentinel', String(Date.now())); }, ${SLEEP_MS});\n`,
  );

  coachDir = join(workDir, 'coach');
  mkdirSync(coachDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describeUnixOnly('detach-survival (§8.5) — real spawn, child outlives parent', () => {
  it("the unref'd detached judge completes AFTER runHook returns", async () => {
    const deps: HookDeps = {
      stdin: JSON.stringify({
        session_id: 'detach-sess',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/work',
        prompt: 'prove the detach survives',
        hook_event_name: 'UserPromptSubmit',
      }),
      env: { PROMPT_COACH_DIR: coachDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
      hookDirname: join(pluginRoot, 'dist'),
      // NO spawnFn -> the REAL default node:child_process spawn (detached+unref) runs.
    };

    runHook(deps);

    // The hook wrote the inbox file synchronously; the (throwaway) judge does not unlink
    // it, so it persists. Discover it to know where the judge will drop its sentinel.
    const inboxDir = join(coachDir, 'inbox');
    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles).toHaveLength(1);
    const inboxPath = join(inboxDir, inboxFiles[0]);
    const sentinel = `${inboxPath}.sentinel`;

    // (1) Immediately after runHook returns, the sentinel must NOT exist: the parent did
    // not block on the ~150ms child.
    expect(existsSync(sentinel)).toBe(false);

    // (2) Poll up to ~2s for the sentinel to appear — proving the unref'd detached child
    // ran to completion AFTER the parent's spawn call already returned.
    const appeared = await pollUntil(() => existsSync(sentinel), 2000, 20);
    expect(appeared).toBe(true);
  });
});

/** Poll `cond` every `stepMs` until true or `timeoutMs` elapses. Returns the final result. */
async function pollUntil(
  cond: () => boolean,
  timeoutMs: number,
  stepMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}
