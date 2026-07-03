import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCorpusTypedPrompts } from '../src/jsonl/corpus-reader.js';

let root: string;
let projectsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coach-corpus-'));
  projectsDir = join(root, 'projects');
  mkdirSync(projectsDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function typed(text: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    promptSource: 'typed',
    timestamp: ts,
    message: { role: 'user', content: text },
  });
}
function system(text: string): string {
  return JSON.stringify({ type: 'user', promptSource: 'system', message: { role: 'user', content: text } });
}

/** Create projectsDir/<project>/<file>.jsonl with the given lines. */
function writeSession(project: string, file: string, lines: string[]): void {
  const pdir = join(projectsDir, project);
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, file), lines.join('\n'));
}

describe('readCorpusTypedPrompts', () => {
  it('globs all project dirs and tags each prompt with sessionId from the filename basename (minus .jsonl) + project', () => {
    writeSession('-Users-me-proj-a', 'session-aaa.jsonl', [typed('a-one', '2026-06-22T00:00:01.000Z')]);
    writeSession('-Users-me-proj-b', 'session-bbb.jsonl', [
      system('<command-message>/x</command-message>'),
      typed('b-one', '2026-06-22T00:00:02.000Z'),
    ]);

    const out = readCorpusTypedPrompts({ projectsDir });
    const byText = new Map(out.map((e) => [e.text, e]));

    expect(out).toHaveLength(2);
    expect(byText.get('a-one')!.sessionId).toBe('session-aaa');
    expect(byText.get('a-one')!.project).toBe('-Users-me-proj-a');
    expect(byText.get('b-one')!.sessionId).toBe('session-bbb');
    expect(byText.get('b-one')!.project).toBe('-Users-me-proj-b');
    expect(typeof byText.get('a-one')!.ts).toBe('number');
  });

  it('excludes non-typed prompts across the whole corpus', () => {
    writeSession('p1', 's1.jsonl', [system('a'), system('b')]);
    writeSession('p2', 's2.jsonl', [typed('keep me', '2026-06-22T00:00:01.000Z')]);
    const out = readCorpusTypedPrompts({ projectsDir });
    expect(out.map((e) => e.text)).toEqual(['keep me']);
  });

  it('bounds the number of files read via maxFiles, keeping the SPECIFIC most-recent-mtime files', () => {
    // 5 sessions, each one typed prompt. Stamp distinct, controlled mtimes so the
    // most-recent-wins sort (corpus-reader.ts ~line 73) is deterministic: s5 newest,
    // s1 oldest. Cap at 2 => only s5 and s4 may survive; s1/s2/s3 MUST be dropped.
    for (let i = 1; i <= 5; i++) {
      writeSession(`p${i}`, `s${i}.jsonl`, [typed(`prompt-${i}`, '2026-06-22T00:00:01.000Z')]);
      // mtime in seconds: i=1 -> 1000s ... i=5 -> 5000s (strictly increasing).
      const whenSec = i * 1000;
      utimesSync(join(projectsDir, `p${i}`, `s${i}.jsonl`), whenSec, whenSec);
    }
    const out = readCorpusTypedPrompts({ projectsDir, maxFiles: 2 });
    const texts = new Set(out.map((e) => e.text));
    // Exactly the two newest survive (not merely "some 2 files").
    expect(out).toHaveLength(2);
    expect(texts).toEqual(new Set(['prompt-5', 'prompt-4']));
    // And the older three are provably gone.
    expect(texts.has('prompt-3')).toBe(false);
    expect(texts.has('prompt-2')).toBe(false);
    expect(texts.has('prompt-1')).toBe(false);
  });

  describe('sinceWatermark filter (the miner throttle depends on it)', () => {
    // A typed line whose timestamp is absent (so event.ts is undefined → coerced to 0).
    function typedNoTs(text: string): string {
      return JSON.stringify({
        type: 'user',
        promptSource: 'typed',
        message: { role: 'user', content: text },
      });
    }

    it('returns only prompts STRICTLY newer than an intermediate watermark', () => {
      const tsOld = '2026-06-22T00:00:01.000Z';
      const tsMid = '2026-06-22T00:00:02.000Z';
      const tsNew = '2026-06-22T00:00:03.000Z';
      writeSession('p1', 's1.jsonl', [
        typed('old', tsOld),
        typed('mid', tsMid),
        typed('new', tsNew),
      ]);
      // Watermark exactly at the mid ts: mid is NOT strictly newer, so it is excluded.
      const out = readCorpusTypedPrompts({ projectsDir, sinceWatermark: Date.parse(tsMid) });
      expect(new Set(out.map((e) => e.text))).toEqual(new Set(['new']));
    });

    it('default / no watermark returns everything INCLUDING ts=0 prompts', () => {
      // 'epoch' has a valid timestamp that parses to exactly 0.
      writeSession('p1', 's1.jsonl', [
        typed('epoch', '1970-01-01T00:00:00.000Z'),
        typed('later', '2026-06-22T00:00:01.000Z'),
      ]);
      const out = readCorpusTypedPrompts({ projectsDir }); // watermark defaults to 0
      const byText = new Map(out.map((e) => [e.text, e]));
      expect(new Set(out.map((e) => e.text))).toEqual(new Set(['epoch', 'later']));
      expect(byText.get('epoch')!.ts).toBe(0);
    });

    it('a prompt with absent/unparseable timestamp (ts→0) is DROPPED when watermark>0 but KEPT when watermark=0', () => {
      writeSession('p1', 's1.jsonl', [typedNoTs('no-timestamp')]);

      // watermark=0 (default): the ts→0 prompt is kept (the `&& watermark>0` guard).
      const keep = readCorpusTypedPrompts({ projectsDir, sinceWatermark: 0 });
      expect(keep.map((e) => e.text)).toEqual(['no-timestamp']);
      expect(keep[0]!.ts).toBe(0);

      // watermark>0: ts(=0) <= watermark, so it is dropped.
      const drop = readCorpusTypedPrompts({ projectsDir, sinceWatermark: 1 });
      expect(drop).toEqual([]);
    });
  });

  it('skips unreadable files without throwing', () => {
    writeSession('p1', 'good.jsonl', [typed('readable', '2026-06-22T00:00:01.000Z')]);
    // Create a directory named like a jsonl entry to force a read error path is awkward;
    // instead, write a file then chmod it unreadable.
    const pdir = join(projectsDir, 'p2');
    mkdirSync(pdir, { recursive: true });
    const bad = join(pdir, 'bad.jsonl');
    writeFileSync(bad, typed('secret', '2026-06-22T00:00:02.000Z'));
    try {
      chmodSync(bad, 0o000);
    } catch {
      // chmod may not restrict root; tolerate.
    }
    const out = readCorpusTypedPrompts({ projectsDir });
    // 'readable' must always be present; 'secret' may or may not be depending on perms.
    expect(out.map((e) => e.text)).toContain('readable');
    // restore for cleanup
    try {
      chmodSync(bad, 0o644);
    } catch {
      /* ignore */
    }
  });

  it('returns empty array when the projects dir does not exist (never throws)', () => {
    const out = readCorpusTypedPrompts({ projectsDir: join(root, 'nonexistent') });
    expect(out).toEqual([]);
  });

  it('returns empty array when there are no .jsonl files', () => {
    mkdirSync(join(projectsDir, 'empty-proj'), { recursive: true });
    const out = readCorpusTypedPrompts({ projectsDir });
    expect(out).toEqual([]);
  });
});
