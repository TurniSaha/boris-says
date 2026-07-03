/**
 * catalog.ts — CAPABILITY_CATALOG + resolveCapability (capability-awareness).
 * Ported from the upstream coach service pm-service/test/capability-catalog.test.ts (§16/§20) plus
 * the §5.5.5 shape additions (appliesAt, modelFamily, activeModel gate) and the
 * data/catalog.json drift guard (§7/§11).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  resolveCapability,
  type Capability,
  type CapabilityKind,
  type CapabilityPerson,
} from '../src/capability/catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_JSON = join(HERE, '..', 'data', 'catalog.json');

const noScan: CapabilityPerson = { installedCommands: null, cliVersion: null };
const recentCli: CapabilityPerson = { installedCommands: [], cliVersion: '2.1.185' };

describe('CAPABILITY_CATALOG — shape & counts (§20)', () => {
  it('has EXACTLY 24 entries', () => {
    expect(CAPABILITY_CATALOG.length).toBe(24);
  });

  it('has NO /deep-research slash_command (item 5: verified absent from the real CLI 2.1.199)', () => {
    // `/deep-research` is NOT a user slash command — the bundled "deep-research" is a
    // Workflow the agent invokes (Workflow({name:'deep-research'})), not something a dev types.
    // A coach telling the dev to type `/deep-research` would name a nonexistent command.
    expect(CAPABILITY_CATALOG.some((c) => c.id === 'deep-research')).toBe(false);
    expect(CAPABILITY_CATALOG.some((c) => c.trigger === '/deep-research')).toBe(false);
  });

  it('keeps the VERIFIED real commands /btw, /batch, /fast, ultracode', () => {
    // Verified present in the installed claude 2.1.199 binary (strings + --help contexts).
    for (const id of ['btw', 'batch', 'fast-mode', 'ultracode']) {
      expect(CAPABILITY_CATALOG.some((c) => c.id === id)).toBe(true);
    }
  });

  it('covers all 5 kinds', () => {
    const kinds = new Set<CapabilityKind>(CAPABILITY_CATALOG.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(
      ['authoring', 'cli_flag', 'keyword', 'mode', 'slash_command'].sort(),
    );
  });

  it('has the exact per-kind distribution (slash_command×14, authoring×4, cli_flag×2, keyword×2, mode×2)', () => {
    const count = (k: CapabilityKind) => CAPABILITY_CATALOG.filter((c) => c.kind === k).length;
    expect(count('slash_command')).toBe(14);
    expect(count('authoring')).toBe(4);
    expect(count('cli_flag')).toBe(2);
    expect(count('keyword')).toBe(2);
    expect(count('mode')).toBe(2);
  });

  it('has EXACTLY two removedIn entries: /vim and /output-style, both 2.1.92', () => {
    const removed = CAPABILITY_CATALOG.filter((c) => c.removedIn !== null);
    expect(removed.length).toBe(2);
    expect(removed.map((c) => c.id).sort()).toEqual(['output-style', 'vim']);
    for (const c of removed) expect(c.removedIn).toBe('2.1.92');
  });

  it('has NO /pr-comments entry anywhere (the phantom — §20)', () => {
    expect(CAPABILITY_CATALOG.some((c) => c.id === 'pr-comments')).toBe(false);
    expect(CAPABILITY_CATALOG.some((c) => c.trigger === '/pr-comments')).toBe(false);
  });

  it('every entry carries an appliesAt of launch|in_turn (§5.5.5a)', () => {
    for (const c of CAPABILITY_CATALOG) {
      expect(['launch', 'in_turn']).toContain(c.appliesAt);
    }
  });
});

describe('§5.5.5 shape — appliesAt & modelFamily tags', () => {
  const byId = (id: string): Capability => {
    const c = CAPABILITY_CATALOG.find((x) => x.id === id);
    if (c === undefined) throw new Error(`missing capability ${id}`);
    return c;
  };

  it('effort-xhigh is launch + scoped to {opus, fable, sonnet5, mythos} (§5.5.5a/b, official effort matrix)', () => {
    expect(byId('effort-xhigh').appliesAt).toBe('launch');
    // xhigh is scoped to the SET of xhigh-capable families per the official effort matrix
    // (Fable 5 + Mythos 5 + Opus 4.8/4.7 + Sonnet 5) — NOT opus-only, and NOT Sonnet 4.6:
    // a Fable/Sonnet-5 dev must not be wrongly denied it, a Sonnet 4.6 dev must not be offered it.
    expect(byId('effort-xhigh').modelFamilies).toEqual(['opus', 'fable', 'sonnet5', 'mythos']);
    expect(byId('effort-xhigh').modelFamily).toBeUndefined();
  });

  it('worktree is launch (§5.5.5a)', () => {
    expect(byId('worktree').appliesAt).toBe('launch');
  });

  it('the only launch-only capabilities are effort-xhigh and worktree', () => {
    const launch = CAPABILITY_CATALOG.filter((c) => c.appliesAt === 'launch').map((c) => c.id);
    expect(launch.sort()).toEqual(['effort-xhigh', 'worktree']);
  });

  it('an in-turn affordance like ultrathink stays in_turn (model-agnostic)', () => {
    expect(byId('ultrathink').appliesAt).toBe('in_turn');
    expect(byId('ultrathink').modelFamily).toBeUndefined();
  });
});

describe('resolveCapability — match by id OR trigger (the S16 fix)', () => {
  it('matches by canonical id', () => {
    const r = resolveCapability('design-sync', { installedCommands: ['design-sync'], cliVersion: null });
    expect(r.capability?.id).toBe('design-sync');
    expect(r.available).toBe(true);
  });

  it('matches by TRIGGER form /design-sync (the judge echoes the trigger, not the id)', () => {
    const r = resolveCapability('/design-sync', { installedCommands: ['design-sync'], cliVersion: null });
    expect(r.capability?.id).toBe('design-sync');
    expect(r.available).toBe(true);
  });

  it('matches a cli_flag by its trigger form (--effort xhigh) where trigger !== id', () => {
    const r = resolveCapability('--effort xhigh', recentCli);
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('is fold-insensitive (case + surrounding whitespace)', () => {
    const r = resolveCapability('  /DESIGN-SYNC  ', { installedCommands: ['design-sync'], cliVersion: null });
    expect(r.capability?.id).toBe('design-sync');
  });

  it('unknown id/trigger -> { available:false, capability:null }', () => {
    expect(resolveCapability('nope', recentCli)).toEqual({ available: false, capability: null });
  });
});

describe('resolveCapability — disk_command fail-closed (§16)', () => {
  it('null installedCommands (never scanned) -> available:false, capability kept', () => {
    const r = resolveCapability('design-sync', noScan);
    expect(r.available).toBe(false);
    expect(r.capability?.id).toBe('design-sync');
  });

  it('scanned-empty (not in list) -> available:false', () => {
    const r = resolveCapability('design-sync', { installedCommands: [], cliVersion: null });
    expect(r.available).toBe(false);
  });

  it('present in installedCommands -> available:true', () => {
    const r = resolveCapability('design-sync', { installedCommands: ['design-sync', 'goal'], cliVersion: null });
    expect(r.available).toBe(true);
  });
});

describe('resolveCapability — version-gated (builtin/universal)', () => {
  it('a minVersion-set capability with null cliVersion -> fail-closed (false)', () => {
    const r = resolveCapability('ultracode', { installedCommands: [], cliVersion: null });
    expect(r.available).toBe(false);
    expect(r.capability?.id).toBe('ultracode');
  });

  it('a long-stable (minVersion null) capability with null cliVersion -> available', () => {
    const r = resolveCapability('plan-mode', { installedCommands: [], cliVersion: null });
    expect(r.available).toBe(true);
  });

  it('a minVersion-set capability satisfied by a recent cliVersion -> available', () => {
    const r = resolveCapability('ultracode', { installedCommands: [], cliVersion: '2.1.185' });
    expect(r.available).toBe(true);
  });

  it('a minVersion-set capability below the floor -> not available', () => {
    const r = resolveCapability('ultracode', { installedCommands: [], cliVersion: '2.1.100' });
    expect(r.available).toBe(false);
  });
});

describe('resolveCapability — removedIn suppression', () => {
  it('a removedIn capability with null/unparseable cliVersion is HIDDEN (cannot confirm before removal)', () => {
    expect(resolveCapability('/vim', noScan).available).toBe(false);
    expect(resolveCapability('/output-style', { installedCommands: [], cliVersion: 'garbage' }).available).toBe(false);
  });

  it('a removedIn capability on a build PAST the removal is suppressed', () => {
    expect(resolveCapability('/vim', { installedCommands: [], cliVersion: '2.1.185' }).available).toBe(false);
  });

  it('a removedIn capability on a build BEFORE the removal is available', () => {
    expect(resolveCapability('/vim', { installedCommands: [], cliVersion: '2.1.50' }).available).toBe(true);
  });
});

describe('resolveCapability — model-scoped gate (§5.5.5b)', () => {
  it('effort-xhigh is UNAVAILABLE when activeModel is a non-opus family (codex)', () => {
    const r = resolveCapability('--effort xhigh', {
      installedCommands: [],
      cliVersion: '2.1.185',
      activeModel: 'codex',
    });
    expect(r.available).toBe(false);
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('effort-xhigh is AVAILABLE when activeModel matches (opus)', () => {
    const r = resolveCapability('--effort xhigh', {
      installedCommands: [],
      cliVersion: '2.1.185',
      activeModel: 'opus',
    });
    expect(r.available).toBe(true);
  });

  it('effort-xhigh resolves on version alone when activeModel is unknown (no model gate applied)', () => {
    const r = resolveCapability('--effort xhigh', recentCli); // no activeModel
    expect(r.available).toBe(true);
  });

  it('a model-agnostic capability is unaffected by activeModel', () => {
    const r = resolveCapability('plan-mode', {
      installedCommands: [],
      cliVersion: '2.1.185',
      activeModel: 'codex',
    });
    expect(r.available).toBe(true);
  });
});

describe('data/catalog.json mirror — must not drift from the in-code array (§7/§11)', () => {
  it('deep-equals CAPABILITY_CATALOG (the array is the source of truth)', () => {
    const onDisk = JSON.parse(readFileSync(CATALOG_JSON, 'utf8'));
    // JSON.parse drops `undefined` fields exactly like JSON.stringify omits them, so a
    // round-trip of the in-code array is the faithful comparison target.
    const expected = JSON.parse(JSON.stringify(CAPABILITY_CATALOG));
    expect(onDisk).toEqual(expected);
  });

  it('the mirror has 25 entries too', () => {
    const onDisk = JSON.parse(readFileSync(CATALOG_JSON, 'utf8'));
    expect(onDisk.length).toBe(24);
  });
});
