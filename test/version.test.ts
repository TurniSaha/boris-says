/**
 * version.ts — the zero-dependency strict semver gate (capability-awareness).
 * Ported from the upstream coach service pm-service/test/version.test.ts (§0.1 row 6 / §16).
 *
 * Contract (§4c, fail-CLOSED):
 *  - minVersion === null              -> always true (long-stable, no lower gate).
 *  - minVersion set, cli null/garbage -> false (cannot confirm the dev's build).
 *  - both parse                       -> numeric major/minor/patch compare, cli >= min.
 */
import { describe, expect, it } from 'vitest';
import { satisfiesMinVersion } from '../src/capability/version.js';

describe('satisfiesMinVersion — no lower gate', () => {
  it('minVersion null -> always true, regardless of cliVersion', () => {
    expect(satisfiesMinVersion('2.1.185', null)).toBe(true);
    expect(satisfiesMinVersion(null, null)).toBe(true);
    expect(satisfiesMinVersion('garbage', null)).toBe(true);
    expect(satisfiesMinVersion('', null)).toBe(true);
  });
});

describe('satisfiesMinVersion — fail-closed on unconfirmable cliVersion', () => {
  it('null cliVersion with a set minVersion -> false', () => {
    expect(satisfiesMinVersion(null, '2.1.150')).toBe(false);
  });
  it('unparseable cliVersion (garbage) -> false', () => {
    expect(satisfiesMinVersion('not-a-version', '2.1.150')).toBe(false);
    expect(satisfiesMinVersion('2.1', '2.1.150')).toBe(false); // two-segment, no patch.
    expect(satisfiesMinVersion('', '2.1.150')).toBe(false);
  });
  it('unparseable minVersion (catalog data error) -> false (never ungate)', () => {
    expect(satisfiesMinVersion('2.1.185', '2.1')).toBe(false);
    expect(satisfiesMinVersion('2.1.185', 'bad')).toBe(false);
  });
});

describe('satisfiesMinVersion — numeric compare', () => {
  it('equal -> true (>=)', () => {
    expect(satisfiesMinVersion('2.1.150', '2.1.150')).toBe(true);
  });
  it('above on patch / minor / major -> true', () => {
    expect(satisfiesMinVersion('2.1.151', '2.1.150')).toBe(true);
    expect(satisfiesMinVersion('2.2.0', '2.1.150')).toBe(true);
    expect(satisfiesMinVersion('3.0.0', '2.1.150')).toBe(true);
  });
  it('below on patch / minor / major -> false', () => {
    expect(satisfiesMinVersion('2.1.149', '2.1.150')).toBe(false);
    expect(satisfiesMinVersion('2.0.999', '2.1.150')).toBe(false);
    expect(satisfiesMinVersion('1.9.9', '2.1.150')).toBe(false);
  });
  it('compares NUMERICALLY, not lexically (10 > 9)', () => {
    expect(satisfiesMinVersion('2.1.10', '2.1.9')).toBe(true);
    expect(satisfiesMinVersion('2.10.0', '2.9.0')).toBe(true);
  });
  it('ignores a trailing suffix ( (Claude Code) / -pre / +build )', () => {
    expect(satisfiesMinVersion('2.1.185 (Claude Code)', '2.1.150')).toBe(true);
    expect(satisfiesMinVersion('2.1.150-beta', '2.1.150')).toBe(true);
    expect(satisfiesMinVersion('2.1.150+build.7', '2.1.150')).toBe(true);
  });
});
