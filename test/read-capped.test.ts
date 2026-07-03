import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileCapped } from '../src/jsonl/read-capped.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-capped-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readFileCapped', () => {
  it('returns the content of a normal-sized file', () => {
    const p = join(dir, 'ok.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\n');
    expect(readFileCapped(p)).toBe('{"a":1}\n{"b":2}\n');
  });

  it('returns null for a missing file (never throws)', () => {
    expect(readFileCapped(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('SKIPS a file larger than the cap (returns null, does not read it)', () => {
    const p = join(dir, 'huge.jsonl');
    // Write just over a tiny cap; assert it is skipped without loading.
    writeFileSync(p, 'x'.repeat(2048));
    expect(readFileCapped(p, 1024)).toBeNull();
  });

  it('reads a file exactly at the cap boundary', () => {
    const p = join(dir, 'edge.jsonl');
    writeFileSync(p, 'x'.repeat(1024));
    expect(readFileCapped(p, 1024)).toHaveLength(1024);
  });
});
