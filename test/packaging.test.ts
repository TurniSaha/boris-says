import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// test/ lives at the repo root next to .claude-plugin/, hooks/, dist/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

describe('.claude-plugin/plugin.json (SPEC §11.1)', () => {
  const plugin = readJson('.claude-plugin/plugin.json');

  it('parses and has name/version/author', () => {
    expect(plugin.name).toBe('boris-says');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/); // valid semver (bumped every release — do NOT pin a literal)
    expect(typeof plugin.description).toBe('string');
    expect(plugin.author).toEqual({ name: 'TurniSaha', email: 'turni.saha@gmail.com' });
  });

  it('is metadata ONLY — no hooks or commands keys', () => {
    expect(plugin).not.toHaveProperty('hooks');
    expect(plugin).not.toHaveProperty('commands');
  });
});

describe('hooks/hooks.json (SPEC §11.1)', () => {
  const hooks = readJson('hooks/hooks.json');

  it('registers a UserPromptSubmit command hook', () => {
    const entry = hooks.hooks.UserPromptSubmit[0].hooks[0];
    expect(entry.type).toBe('command');
  });

  it('UserPromptSubmit hook group takes NO matcher (CC ignores one for this event)', () => {
    // Auto-discovery of hooks/hooks.json works WITHOUT a plugin.json hooks key (verified
    // against working reference plugins), so plugin.json stays metadata-only. And
    // UserPromptSubmit does not support a matcher — omit it to match the schema.
    const group = hooks.hooks.UserPromptSubmit[0];
    expect(group).not.toHaveProperty('matcher');
  });

  it('command is anchored to CLAUDE_PLUGIN_ROOT, self-locating (fallback), node-guarded, non-blocking', () => {
    const entry = hooks.hooks.UserPromptSubmit[0].hooks[0];
    // Anchored to the plugin root env var (preferred) — never a cwd-relative path.
    expect(entry.command).toContain('CLAUDE_PLUGIN_ROOT');
    expect(entry.command).toContain('dist/hook.js');
    // node-guarded + always exit 0 (never blocks the prompt).
    expect(entry.command).toContain('command -v node');
    expect(entry.command).toContain('exit 0');
    // EMPTY/UNSET-ENV GUARD (the fix for the empty/unset CLAUDE_PLUGIN_ROOT failure mode):
    // `[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]` short-circuits to `exit 0` when the env var is empty,
    // and `-f` verifies dist/hook.js exists before exec — so it never collapses to a bare
    // `/dist/hook.js` module-not-found error on every prompt. (This is a fail-safe guard, not
    // a self-locating fallback — there is no mechanism to rediscover the root when it is unset.)
    expect(entry.command).toContain('CLAUDE_PLUGIN_ROOT:-');
    expect(entry.command).toContain('-f '); // existence check before exec.
    // The bare-collapse footgun must be gone (no unguarded "${CLAUDE_PLUGIN_ROOT}/dist").
    expect(entry.command).not.toContain('"${CLAUDE_PLUGIN_ROOT}/dist/hook.js"');
  });

  it('carries NO dead commandWindows field (not a real CC hook-schema key) + has a timeout', () => {
    // `commandWindows` is NOT part of the Claude Code hook schema (verified: 0 occurrences in
    // the 2.1.x binary; official docs say "There is no `commandWindows` field"). It was silently
    // ignored dead config. Windows runs the POSIX `command` via Git Bash (CC's documented Windows
    // shell); the field must stay removed so maintainers are not misled into thinking a separate
    // PowerShell path is wired.
    const entry = hooks.hooks.UserPromptSubmit[0].hooks[0];
    expect(entry).not.toHaveProperty('commandWindows');
    expect(entry.timeout).toBe(5);
  });
});

describe('.claude-plugin/marketplace.json (SPEC §11.2)', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  const plugin = readJson('.claude-plugin/plugin.json');

  it('parses with a name and an OBJECT owner', () => {
    expect(market.name).toBe('boris-says');
    expect(typeof market.owner).toBe('object');
    expect(market.owner).not.toBeNull();
    expect(market.owner.name).toBe('TurniSaha');
    expect(market.owner.email).toBe('turni.saha@gmail.com');
  });

  it('all manifests agree on version (a mismatch silently ships stale code via the version-keyed cache)', () => {
    const pkg = readJson('package.json');
    expect(plugin.version).toBe(pkg.version);
    expect(market.metadata.version).toBe(pkg.version);
    expect(market.plugins[0].version).toBe(pkg.version);
  });

  it('plugins[0] matches plugin.json name, source "./", version + license', () => {
    const p = market.plugins[0];
    expect(p.name).toBe(plugin.name);
    expect(p.source).toBe('./');
    expect(p.version).toBe(plugin.version); // marketplace entry must track plugin.json in lockstep
    expect(p.license).toBe('MIT');
  });
});

describe('committed-dist invariant (SPEC §11.1 / §10)', () => {
  it('dist/hook.js, dist/judge.js, dist/coach-cmd.js are present on disk', () => {
    expect(existsSync(join(REPO_ROOT, 'dist/hook.js'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'dist/judge.js'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'dist/coach-cmd.js'))).toBe(true);
  });
});

describe('M4 external-skill index ships with the plugin', () => {
  it('data/skill-index.json is present, parses, and matches the loader schema', () => {
    expect(existsSync(join(REPO_ROOT, 'data/skill-index.json'))).toBe(true);
    const index = readJson('data/skill-index.json');
    expect(index.schemaVersion).toBe(1);
    expect(typeof index.generatedAt).toBe('string');
    expect(Array.isArray(index.entries)).toBe(true);
    expect(index.entries.length).toBeGreaterThan(0);
    expect(index.entries.length).toBeLessThanOrEqual(400);
    for (const e of index.entries) {
      expect(typeof e.name).toBe('string');
      expect(typeof e.description).toBe('string');
      expect(typeof e.install).toBe('string');
      expect(typeof e.sourceUrl).toBe('string');
    }
  });
});

describe('M2 — Stop hook registration (PLAN Step 8)', () => {
  const hooks = readJson('hooks/hooks.json');

  it('registers a Stop command hook, anchored + node-guarded + existence-checked, never blocking', () => {
    const entry = hooks.hooks.Stop[0].hooks[0];
    expect(entry.type).toBe('command');
    expect(entry.command).toContain('CLAUDE_PLUGIN_ROOT');
    expect(entry.command).toContain('dist/stop-hook.js');
    expect(entry.command).toContain('command -v node');
    expect(entry.command).toContain('exit 0');
    expect(entry.command).toContain('-f '); // existence check before exec.
    expect(entry.command).not.toContain('"${CLAUDE_PLUGIN_ROOT}/dist/stop-hook.js"');
  });

  it('carries NO dead commandWindows field + a timeout covering the 7s poll + margin', () => {
    const entry = hooks.hooks.Stop[0].hooks[0];
    expect(entry).not.toHaveProperty('commandWindows');
    expect(entry.timeout).toBe(10); // > STOP_DRAIN_POLL_MS (7s) with margin.
  });

  it('the Stop group takes NO matcher (CC schema for Stop)', () => {
    expect(hooks.hooks.Stop[0]).not.toHaveProperty('matcher');
  });

  it('dist/stop-hook.js ships on disk (users run dist)', () => {
    expect(existsSync(join(REPO_ROOT, 'dist/stop-hook.js'))).toBe(true);
  });
});
