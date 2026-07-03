/**
 * scan-skills.ts — the installed-SKILLS probe (ported §0.1 row 12) + the curated
 * skill seed with database-migrations added (§5.5.5d).
 */
import { describe, expect, it } from 'vitest';
import { scanInstalledSkills, CURATED_SKILLS } from '../src/capability/scan-skills.js';

interface Dirent {
  name: string;
  isDirectory(): boolean;
}
const dir = (name: string): Dirent => ({ name, isDirectory: () => true });
const file = (name: string): Dirent => ({ name, isDirectory: () => false });

function fakeFs(tree: Record<string, Dirent[]>, files: Record<string, string> = {}) {
  const existsSync = (p: string) => Object.prototype.hasOwnProperty.call(tree, p);
  const readdir = async (p: string, _o: { withFileTypes: true }) => {
    if (!Object.prototype.hasOwnProperty.call(tree, p)) throw new Error('ENOENT');
    return tree[p];
  };
  const readFile = async (p: string, _e: 'utf8') => {
    if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
    return files[p];
  };
  return { existsSync, readdir, readFile };
}

const HOME = '/home/dev';
const CWD = '/work/proj';

describe('CURATED_SKILLS — §5.5.5d', () => {
  it('includes database-migrations (data-safety affordance)', () => {
    expect(CURATED_SKILLS).toContain('database-migrations');
  });

  it('still carries the original curated seed', () => {
    for (const id of ['grill-me', 'tdd-workflow', 'security-review', 'systematic-debugging']) {
      expect(CURATED_SKILLS).toContain(id);
    }
  });
});

describe('scanInstalledSkills — roots & ids', () => {
  it('scans ~/.claude/skills and <cwd>/.claude/skills (dir name when no SKILL.md)', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/skills': [dir('alpha'), dir('beta')],
      '/work/proj/.claude/skills': [dir('gamma')],
    });
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('prefers the SKILL.md frontmatter `name:` over the directory name', async () => {
    const fs = fakeFs(
      { '/home/dev/.claude/skills': [dir('dir-name')] },
      { '/home/dev/.claude/skills/dir-name/SKILL.md': '---\nname: real-skill-name\n---\nbody' },
    );
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['real-skill-name']);
  });

  it('expands plugins/<plugin>/skills by reading the plugins dir', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/plugins': [dir('plug-a'), dir('plug-b')],
      '/home/dev/.claude/plugins/plug-a/skills': [dir('sa')],
      '/home/dev/.claude/plugins/plug-b/skills': [dir('sb')],
    });
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['sa', 'sb']);
  });

  it('dedupes + sorts across roots', async () => {
    const fs = fakeFs({
      '/home/dev/.claude/skills': [dir('shared'), dir('zeta')],
      '/work/proj/.claude/skills': [dir('shared'), dir('alpha')],
    });
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['alpha', 'shared', 'zeta']);
  });
});

describe('scanInstalledSkills — robustness', () => {
  it('returns [] when nothing exists, never throws', async () => {
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fakeFs({}) });
    expect(out).toEqual([]);
  });

  it('falls back to the dir name when SKILL.md read throws', async () => {
    const fs = fakeFs({ '/home/dev/.claude/skills': [dir('fallback')] }); // no files registered
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out).toEqual(['fallback']);
  });

  it('caps the result at 200 ids', async () => {
    const many = Array.from({ length: 250 }, (_, i) => dir(`s${String(i).padStart(3, '0')}`));
    const fs = fakeFs({ '/home/dev/.claude/skills': many });
    const out = await scanInstalledSkills({ platform: 'linux', homeDir: HOME, cwd: CWD, ...fs });
    expect(out.length).toBe(200);
  });
});
