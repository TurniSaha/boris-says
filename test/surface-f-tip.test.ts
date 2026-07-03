/**
 * Row-level surface test for F-TIP (the in-terminal tip surface).
 *
 * STORY (CORRECTED 2026-06-25): the coaching tip must be SHOWN TO THE DEVELOPER and must
 * NOT steer the agent's task. For a UserPromptSubmit hook, Claude Code routes:
 *   - plain stdout / additionalContext → fed to the MODEL, NOT shown to the human ❌
 *   - { "systemMessage": ... }         → SHOWN TO THE HUMAN, NOT in the model context ✅
 * So the hook emits the 🐾 banner as `{"systemMessage": <banner>}` on stdout. (The original
 * build's "plain stdout = visible to human" assumption was BACKWARDS — it made the banner
 * invisible while still leaking the tip into the model; this is the fix.)
 *
 * GAP this file pins: a DIRECT assertion that the bytes runHook puts on stdout for a REAL
 * formatCoachBanner tip are a single `{"systemMessage": <banner-with-🐾>}` JSON object — the
 * human-visible, non-steering channel — and carry NONE of the model-steering keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, type HookDeps, type SpawnFn } from '../src/hook.js';
import { createStore } from '../src/state/store.js';
import { formatCoachBanner } from '../src/brain/mailbox-format.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-ftip-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** A no-op spawn seam so the detach half does not actually launch a process. */
const noopSpawn: SpawnFn = () => ({ unref() {} });

/** A fake stdout that records exactly what was written to it. */
function fakeStdout(): { out: NodeJS.WriteStream; written: string[] } {
  const written: string[] = [];
  const out = {
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, written };
}

function deps(out: NodeJS.WriteStream): HookDeps {
  return {
    stdin: JSON.stringify({
      session_id: 'sess-ftip',
      transcript_path: '/tmp/s.jsonl',
      cwd: '/work',
      prompt: 'build me a thing',
    }),
    env: { PROMPT_COACH_DIR: baseDir },
    hookDirname: '/plugins/x/dist',
    spawnFn: noopSpawn,
    out,
  };
}

describe('F-TIP — the tip surfaces via systemMessage (human-visible, non-steering)', () => {
  it('drains a REAL formatCoachBanner tip as {"systemMessage": <🐾 banner>}', () => {
    const store = createStore(baseDir);
    const banner = formatCoachBanner('sketch the data contract first');
    store.writeMailbox('sess-ftip', { kind: 'quality', message: banner });

    const { out, written } = fakeStdout();
    runHook(deps(out));

    const stdout = written.join('').trim();
    const parsed = JSON.parse(stdout); // it IS a single JSON object now.
    // The full 🐾 banner (with ANSI) rides inside systemMessage, byte-for-byte.
    expect(parsed.systemMessage).toBe(banner);
    expect(parsed.systemMessage).toContain("🤖  Boris says: I'm in your corner!");
    expect(parsed.systemMessage).toContain('sketch the data contract first');
  });

  it('uses ONLY systemMessage — NOT the model-steering channels', () => {
    const store = createStore(baseDir);
    store.writeMailbox('sess-ftip', {
      kind: 'quality',
      message: formatCoachBanner('front-load the context'),
    });

    const { out, written } = fakeStdout();
    runHook(deps(out));

    const parsed = JSON.parse(written.join('').trim());
    // systemMessage is the human-visible-only channel; the model never sees it.
    expect(Object.keys(parsed)).toEqual(['systemMessage']);
    expect(parsed).not.toHaveProperty('additionalContext');
    expect(parsed).not.toHaveProperty('hookSpecificOutput');
  });

  it('runHook returns nothing — the drained tip is a side-effect write, not a steerable return value', () => {
    const store = createStore(baseDir);
    store.writeMailbox('sess-ftip', { kind: 'quality', message: formatCoachBanner('plan first') });
    const { out } = fakeStdout();
    const result = runHook(deps(out)) as unknown;
    expect(result).toBeUndefined();
  });
});
