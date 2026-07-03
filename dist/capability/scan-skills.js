import { existsSync as nodeExistsSync } from 'node:fs';
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { cwd as processCwd } from 'node:process';
/**
 * Capability-awareness — the installed-SKILLS probe (ported from
 * upstream-extension/src/installed-skills-scan.ts, §0.1 row 12).
 *
 * Scans the dev's on-disk skill DIRECTORIES (each with a SKILL.md) and returns a
 * deduped, SORTED string[] of skill ids (SKILL.md `name:` frontmatter when readable,
 * else the directory name), capped at 200. Every emitted value is a skill NAME —
 * NEVER a filesystem path — and the scan NEVER throws.
 *
 * GLOB-FREE + PLATFORM-PINNED (load-bearing Windows lesson): roots are built with
 * the platform's join (win32.join on 'win32', posix.join elsewhere) — never a
 * hardcoded '/' and never a shell/fast-glob '*'. The per-plugin skills wildcard
 * (plugins then each plugin's skills dir) is expanded by READING the plugins dir,
 * deterministically + cross-platform.
 *
 * Fully dependency-injected (platform, homeDir, cwd, readdir, readFile, existsSync)
 * so tests can drive any platform/fs.
 */
// Bound the shipped skill list so a pathological machine (thousands of skills) can
// never inflate the payload. Generous: a real machine has tens.
const MAX_INSTALLED_SKILLS = 200;
// First N bytes of a SKILL.md is plenty for the `name:` frontmatter line; we never
// read past this just to learn an id.
const SKILL_MD_PEEK_BYTES = 4096;
/**
 * The CURATED skill seed: skills vetted as worth recommending (the INSTALLABLE side
 * of the merged catalog — a dev missing one gets the [install + run] action).
 *
 * §5.5.5d: `database-migrations` is ADDED so the data-safety affordance is actually
 * offerable as [install + run] for destructive-DDL prompts and can WIN over
 * /code-review ultra via the existing SKILL-WINS rule. Without it, skill-wins is a
 * no-op for destructive-data prompts.
 */
export const CURATED_SKILLS = [
    'grill-me',
    'plan-optimizer',
    'tdd-workflow',
    'verification-loop',
    'security-review',
    'code-review',
    'brainstorming',
    'writing-plans',
    'systematic-debugging',
    'database-migrations', // §5.5.5d — data-safety affordance for destructive-DDL prompts.
];
/**
 * Scan the machine's Claude Code / agent skill directories and return a deduped,
 * SORTED string[] of skill ids (capped). Fully dependency-injected. Never throws.
 */
export async function scanInstalledSkills(options = {}) {
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? homedir();
    const cwd = options.cwd ?? processCwd();
    const fileExists = options.existsSync ?? nodeExistsSync;
    const readdir = options.readdir ??
        fsReaddir;
    const readFile = options.readFile ??
        fsReadFile;
    const pathApi = platform === 'win32' ? win32 : posix;
    const j = (...parts) => pathApi.join(...parts);
    // Canonical skill roots: per-user home skills, the project-local .claude skills
    // under the launch cwd, and per-user plugin skills (a wildcard root, expanded
    // below). Attribution is per-person; project-local skills still live on this
    // person's machine, so they count.
    const homeClaude = j(homeDir, '.claude');
    const directRoots = [j(homeClaude, 'skills'), j(cwd, '.claude', 'skills')];
    const pluginsRoot = j(homeClaude, 'plugins');
    const ids = new Set();
    // Expand plugins/*/skills by READING the plugins dir (NOT a glob): each plugin
    // dir contributes its own `skills` root.
    const expandedRoots = [...directRoots];
    for (const plugin of await safeReaddirDirs(pluginsRoot, { fileExists, readdir })) {
        expandedRoots.push(j(pluginsRoot, plugin, 'skills'));
    }
    for (const root of expandedRoots) {
        for (const skillDir of await safeReaddirDirs(root, { fileExists, readdir })) {
            ids.add(await skillIdFor(j(root, skillDir), skillDir, { readFile }));
        }
    }
    return [...ids].sort().slice(0, MAX_INSTALLED_SKILLS);
}
/**
 * Read a directory's immediate sub-DIRECTORY names. A missing root or any fs error
 * degrades to [] (per-root catch — never throws). Non-directory entries are ignored.
 */
async function safeReaddirDirs(dir, deps) {
    if (!deps.fileExists(dir))
        return [];
    try {
        const entries = await deps.readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        return [];
    }
}
/**
 * A skill's id is its SKILL.md `name:` frontmatter when readable, else the
 * directory name. Reading the SKILL.md is best-effort: any error falls back to the
 * directory name.
 */
async function skillIdFor(skillPath, dirName, deps) {
    try {
        const text = await deps.readFile(posixOrWin32Join(skillPath, 'SKILL.md'), 'utf8');
        const name = frontmatterName(typeof text === 'string' ? text : String(text));
        return name || dirName;
    }
    catch {
        return dirName;
    }
}
/** join SKILL.md onto a skill path using the same separator already in the path. */
function posixOrWin32Join(skillPath, leaf) {
    return skillPath.includes('\\') && !skillPath.includes('/')
        ? win32.join(skillPath, leaf)
        : posix.join(skillPath, leaf);
}
function frontmatterName(text) {
    const head = text.length > SKILL_MD_PEEK_BYTES ? text.slice(0, SKILL_MD_PEEK_BYTES) : text;
    const match = head.match(/^---[\s\S]*?\nname:\s*["']?(.+?)["']?\s*\n/m);
    return match ? match[1].trim() : '';
}
