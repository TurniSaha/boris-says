/**
 * claude-version.ts — the `claude --version` probe (ported §0.1 row 11).
 * spawnSync is DI'd; no real process is launched.
 */
import { describe, expect, it } from 'vitest';
import { claudeCliVersion } from '../src/capability/claude-version.js';

type SpawnResult = { status: number | null; stdout?: string | Buffer; error?: Error };

/** A spawnSync that always returns the given canned result. */
const spawnReturning = (result: SpawnResult) => () => result;

describe('claudeCliVersion — parses the leading semver', () => {
  it('parses "2.1.186 (Claude Code)" -> "2.1.186"', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 0, stdout: '2.1.186 (Claude Code)\n' }) });
    expect(v).toBe('2.1.186');
  });

  it('parses a bare "2.1.185\\n"', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 0, stdout: '2.1.185\n' }) });
    expect(v).toBe('2.1.185');
  });

  it('tolerates leading whitespace', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 0, stdout: '  3.0.0 (Claude Code)' }) });
    expect(v).toBe('3.0.0');
  });

  it('handles a Buffer stdout', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 0, stdout: Buffer.from('2.1.10\n') }) });
    expect(v).toBe('2.1.10');
  });

  it('does NOT leak a 4-segment version (1.2.3.4 -> null, not 1.2.3)', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 0, stdout: '1.2.3.4\n' }) });
    expect(v).toBeNull();
  });
});

describe('claudeCliVersion — fail modes all return null (never throws)', () => {
  it('spawn error (ENOENT — claude not on PATH) -> null', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: null, error: new Error('spawn claude ENOENT') }) });
    expect(v).toBeNull();
  });

  it('non-zero exit -> null', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 1, stdout: '2.1.185\n' }) });
    expect(v).toBeNull();
  });

  it('timeout (killed: status null, no error) -> null', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: null }) });
    expect(v).toBeNull();
  });

  it('zero exit but unparseable stdout -> null', () => {
    const v = claudeCliVersion({ spawnSync: spawnReturning({ status: 0, stdout: 'no version here\n' }) });
    expect(v).toBeNull();
  });

  it('a throwing spawnSync is caught -> null', () => {
    const v = claudeCliVersion({
      spawnSync: () => {
        throw new Error('boom');
      },
    });
    expect(v).toBeNull();
  });

  it('passes a 5s timeout + utf8 encoding to spawnSync', () => {
    let captured: { encoding: string; timeout: number } | null = null;
    claudeCliVersion({
      spawnSync: (_c, _a, opts) => {
        captured = opts;
        return { status: 0, stdout: '2.1.185\n' };
      },
    });
    expect(captured).toEqual({ encoding: 'utf8', timeout: 5000 });
  });
});
