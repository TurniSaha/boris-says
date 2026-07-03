import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSessionTypedPrompts,
  recentTranscriptWindow,
  SESSION_PROMPT_CAP,
} from '../src/jsonl/session-reader.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-session-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function typed(text: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    promptSource: 'typed',
    sessionId: 'sess-x',
    timestamp: ts,
    message: { role: 'user', content: text },
  });
}
function system(text: string): string {
  return JSON.stringify({ type: 'user', promptSource: 'system', message: { role: 'user', content: text } });
}
function assistant(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: text } });
}

function writeJsonl(name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n'));
  return p;
}

describe('readSessionTypedPrompts', () => {
  it('returns only typed prompts, in file order (oldest-first as they appear)', () => {
    const p = writeJsonl('s.jsonl', [
      typed('first prompt', '2026-06-22T00:00:01.000Z'),
      system('<command-message>/x</command-message>'),
      assistant('some output'),
      typed('second prompt', '2026-06-22T00:00:02.000Z'),
      typed('third prompt', '2026-06-22T00:00:03.000Z'),
    ]);
    const out = readSessionTypedPrompts(p);
    expect(out.map((e) => e.text)).toEqual(['first prompt', 'second prompt', 'third prompt']);
  });

  it('gracefully skips an unparseable / half-written final line (does not throw)', () => {
    const p = writeJsonl('s.jsonl', [
      typed('good one', '2026-06-22T00:00:01.000Z'),
      '{"type":"user","promptSource":"typed","message":{"role":"user","conte', // truncated
    ]);
    const out = readSessionTypedPrompts(p);
    expect(out.map((e) => e.text)).toEqual(['good one']);
  });

  it('bounds a giant session to the most-recent SESSION_PROMPT_CAP (20) prompts, oldest-first', () => {
    expect(SESSION_PROMPT_CAP).toBe(20);
    // 25 typed prompts > the cap of 20, so the bound at session-reader.ts ~line 57 fires.
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      lines.push(typed(`p${i}`, `2026-06-22T00:00:${String(i).padStart(2, '0')}.000Z`));
    }
    const p = writeJsonl('big.jsonl', lines);
    const out = readSessionTypedPrompts(p);
    // Exactly the most-recent 20 (prompts 6..25), still oldest-first.
    expect(out).toHaveLength(20);
    expect(out.map((e) => e.text)).toEqual(
      Array.from({ length: 20 }, (_, k) => `p${k + 6}`),
    );
  });

  it('returns empty array for a missing file (never throws)', () => {
    const out = readSessionTypedPrompts(join(dir, 'does-not-exist.jsonl'));
    expect(out).toEqual([]);
  });

  it('returns empty array for an empty file', () => {
    const p = writeJsonl('empty.jsonl', []);
    expect(readSessionTypedPrompts(p)).toEqual([]);
  });
});

describe('recentTranscriptWindow', () => {
  function manyTyped(n: number): string[] {
    const out: string[] = [];
    for (let i = 1; i <= n; i++) {
      out.push(typed(`prompt ${i}`, `2026-06-22T00:00:${String(i).padStart(2, '0')}.000Z`));
    }
    return out;
  }

  it('returns the last 8 typed prompt texts oldest-first by default', () => {
    const p = writeJsonl('s.jsonl', manyTyped(12));
    const win = recentTranscriptWindow(p);
    expect(win).toHaveLength(8);
    // last 8 of 1..12 => 5..12, oldest-first
    expect(win).toEqual([
      'prompt 5', 'prompt 6', 'prompt 7', 'prompt 8',
      'prompt 9', 'prompt 10', 'prompt 11', 'prompt 12',
    ]);
  });

  it('returns all when fewer than max, still oldest-first', () => {
    const p = writeJsonl('s.jsonl', manyTyped(3));
    expect(recentTranscriptWindow(p)).toEqual(['prompt 1', 'prompt 2', 'prompt 3']);
  });

  it('honors a custom max', () => {
    const p = writeJsonl('s.jsonl', manyTyped(10));
    const win = recentTranscriptWindow(p, 3);
    expect(win).toEqual(['prompt 8', 'prompt 9', 'prompt 10']);
  });

  it('first-prompt-of-session: empty/absent file yields an empty window (judge still scores stdin prompt)', () => {
    expect(recentTranscriptWindow(join(dir, 'nope.jsonl'))).toEqual([]);
    const p = writeJsonl('empty.jsonl', []);
    expect(recentTranscriptWindow(p)).toEqual([]);
  });
});
