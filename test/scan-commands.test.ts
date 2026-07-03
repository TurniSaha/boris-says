/**
 * scan-commands.ts — the installed-COMMANDS probe (ported §0.1 row 10).
 * Driven entirely through DI (platform/home/cwd/readdir/existsSync) — no real fs.
 */
import { describe, expect, it } from 'vitest';
import { scanInstalledCommands } from '../src/capability/scan-commands.js';

interface Dirent {
  name: string;
  isDirectory(): boolean;
}
const dir = (name: string): Dirent => ({ name, isDirectory: () => true });
const file = (name: string): Dirent => ({ name, isDirectory: () => false });

/**
 * Build a posix-path-keyed fake fs. `tree` maps a dir path -> its entries. existsSync
 * is true iff the path is a known dir. readdir returns the entries (or throws ENOENT).
 */
function fakeFs(tree: Record<string, Dirent[]>) {
  const existsSync = (p: string) => Object.prototype.hasOwnProperty.call(tree, p);
  const readdir = async (p: string, _o: { withFileTypes: true }) => {
    if (!Object.prototype.hasOwnProperty.call(tree, p)) throw new Error('ENOENT');
    return tree[p];
  };
  return { existsSync, readdir };
}

const HOME = '/home/dev';
const CWD = '/work/proj';

describe('scanInstalledCommands — roots & basics', () => {
  it('reads ~/.claude/commands and <cwd>/.claude/commands (roots 1 & 2)', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/commands': [file('alpha.md'), file('beta.md')],
      '/work/proj/.claude/commands': [file('gamma.md')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('reads plugin CACHE root 3: cache/<market>/<plugin>/<version>/commands', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/plugins/cache': [dir('mkt')],
      '/home/dev/.claude/plugins/cache/mkt': [dir('plug')],
      '/home/dev/.claude/plugins/cache/mkt/plug': [dir('1.0.0')],
      '/home/dev/.claude/plugins/cache/mkt/plug/1.0.0/commands': [file('cached.md')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['cached']);
  });

  it('reads marketplace roots 4 (bundled) & 5 (market-root)', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/plugins/marketplaces': [dir('mkt')],
      '/home/dev/.claude/plugins/marketplaces/mkt/plugins': [dir('p1')],
      '/home/dev/.claude/plugins/marketplaces/mkt/plugins/p1/commands': [file('bundled.md')],
      '/home/dev/.claude/plugins/marketplaces/mkt/commands': [file('marketroot.md')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['bundled', 'marketroot']);
  });

  it('combines all 5 roots, deduped + sorted', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/commands': [file('home.md')],
      '/work/proj/.claude/commands': [file('proj.md')],
      '/home/dev/.claude/plugins/cache': [dir('m')],
      '/home/dev/.claude/plugins/cache/m': [dir('pl')],
      '/home/dev/.claude/plugins/cache/m/pl': [dir('2.0.0')],
      '/home/dev/.claude/plugins/cache/m/pl/2.0.0/commands': [file('cache.md')],
      '/home/dev/.claude/plugins/marketplaces': [dir('m2')],
      '/home/dev/.claude/plugins/marketplaces/m2/plugins': [dir('q')],
      '/home/dev/.claude/plugins/marketplaces/m2/plugins/q/commands': [file('bun.md')],
      '/home/dev/.claude/plugins/marketplaces/m2/commands': [file('mroot.md')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['bun', 'cache', 'home', 'mroot', 'proj']);
  });
});

describe('scanInstalledCommands — exclusions & nested→leaf', () => {
  it('skips .opencode and docs directories during the walk', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/commands': [file('keep.md'), dir('.opencode'), dir('docs')],
      '/home/dev/.claude/commands/.opencode': [file('oc.md')],
      '/home/dev/.claude/commands/docs': [file('ja.md')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['keep']);
  });

  it('a nested command file yields the LEAF id only', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/commands': [dir('autoresearch')],
      '/home/dev/.claude/commands/autoresearch': [file('debug.md'), file('plan.md')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['debug', 'plan']);
  });

  it('ignores non-.md files', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/commands': [file('real.md'), file('README.txt'), file('notes')],
    });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['real']);
  });
});

describe('scanInstalledCommands — robustness', () => {
  it('returns [] when no roots exist and never throws', async () => {
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fakeFs({}) });
    expect(out).toEqual([]);
  });

  it('degrades past a throwing readdir (per-dir catch)', async () => {
    const existsSync = () => true;
    const readdir = async (p: string) => {
      if (p === '/home/dev/.claude/commands') return [file('ok.md')];
      throw new Error('EACCES');
    };
    const out = await scanInstalledCommands({
      platform: 'linux',
      homeDir: HOME,
      cwd: CWD,
      existsSync,
      readdir: readdir as never,
    });
    expect(out).toContain('ok');
  });

  it('caps the result at 200 ids', async () => {
    const many = Array.from({ length: 300 }, (_, i) => file(`c${String(i).padStart(3, '0')}.md`));
    const fs = fakeFs({ '/home/dev/.claude/commands': many });
    const out = await scanInstalledCommands({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out.length).toBe(200);
  });

  it('uses win32 join when platform is win32', async () => {
    const fs = fakeFs({
      'C:\\Users\\dev\\.claude\\commands': [file('w.md')],
    });
    const out = await scanInstalledCommands({
      platform: 'win32',
      homeDir: 'C:\\Users\\dev',
      cwd: 'C:\\work',
      ...fs,
    });
    expect(out).toEqual(['w']);
  });
});
