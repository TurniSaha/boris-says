/**
 * test/config-projectkey.test.ts — M2 Step 1: the Stop-drain constants + the projectKey
 * normalization contract (PLAN §B Step 1).
 *
 * NOTE (plan adaptation): `projectKeyForCwd` shipped early in the d8dca0f hotfix with
 * deliberately DEPENDENCY-FREE semantics (normalized absolute cwd; NO git-toplevel
 * resolution — the helper runs inside the <100ms UserPromptSubmit path, and the shipped
 * on-disk records already use these keys). The "same repo from a subdir collapses to one
 * key" case from the plan is therefore a DOCUMENTED caveat, not implemented behavior —
 * this file pins the shipped contract instead.
 */
import { describe, it, expect } from 'vitest';
import {
  projectKeyForCwd,
  STOP_DRAIN_POLL_MS,
  STOP_DRAIN_INTERVAL_MS,
} from '../src/config.js';

describe('M2 — Stop-drain constants (PLAN Step 1)', () => {
  it('poll cap is 7s and the tick is 250ms (owner-locked decisions)', () => {
    expect(STOP_DRAIN_POLL_MS).toBe(7000);
    expect(STOP_DRAIN_INTERVAL_MS).toBe(250);
  });

  it('the tick divides the cap (the poll loop terminates exactly at the cap)', () => {
    expect(STOP_DRAIN_POLL_MS % STOP_DRAIN_INTERVAL_MS).toBe(0);
  });
});

describe('projectKeyForCwd — stable normalized key (shipped hotfix contract)', () => {
  it('null / undefined / empty / whitespace cwd → "" (unscoped, never surfaced)', () => {
    expect(projectKeyForCwd(null)).toBe('');
    expect(projectKeyForCwd(undefined)).toBe('');
    expect(projectKeyForCwd('')).toBe('');
    expect(projectKeyForCwd('   ')).toBe('');
  });

  it('two different repos → different keys', () => {
    expect(projectKeyForCwd('/Users/x/ProjA')).not.toBe(projectKeyForCwd('/Users/x/ProjB'));
  });

  it('trailing slash(es) are stripped — same dir with/without slash → same key', () => {
    expect(projectKeyForCwd('/Users/x/ProjA/')).toBe(projectKeyForCwd('/Users/x/ProjA'));
    expect(projectKeyForCwd('/Users/x/ProjA//')).toBe(projectKeyForCwd('/Users/x/ProjA'));
  });

  it('case is folded on case-insensitive platforms (darwin/win32)', () => {
    const a = projectKeyForCwd('/Users/x/ProjA');
    const b = projectKeyForCwd('/users/X/proja');
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(a).toBe(b);
    } else {
      expect(a).not.toBe(b);
    }
  });
});
