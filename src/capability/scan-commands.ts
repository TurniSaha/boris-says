import { existsSync as nodeExistsSync } from 'node:fs';
import { readdir as fsReaddir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { cwd as processCwd } from 'node:process';

/**
 * Capability-awareness — the installed-COMMANDS probe (ported from
 * upstream-extension/src/installed-commands-scan.ts, §0.1 row 10).
 *
 * Sibling of scan-skills.ts. Where the skills probe scans skill DIRECTORIES (each
 * with a SKILL.md), this scans flat `.md` command FILES inside the dev's on-disk
 * slash-command roots and returns a deduped, SORTED string[] of command ids
 * (filename minus `.md`), capped at 200. Every emitted value is a command NAME —
 * NEVER a filesystem path — and the scan NEVER throws.
 *
 * The roots are DEEPER and varied (verified against the real ~/.claude/plugins
 * layout — it is NOT a mirror of the skills layout). Read IN THIS ORDER, each
 * expanded by READING dirs (never a glob), first-seen id wins on collision:
 *   1. ~/.claude/commands
 *   2. <cwd>/.claude/commands
 *   3. ~/.claude/plugins/cache/<market>/<plugin>/<version>/commands
 *   4. ~/.claude/plugins/marketplaces/<market>/plugins/<plugin>/commands
 *   5. ~/.claude/plugins/marketplaces/<market>/commands
 *
 * Each `commands` root is then walked RECURSIVELY for `.md` files; a nested file
 * (commands/autoresearch/debug.md) yields the LEAF id only (`debug`) — Claude
 * registers nested plugin commands under their own leaf name; the namespace is the
 * plugin, which we do not surface. Directories named `.opencode` or `docs` are
 * SKIPPED during the walk (the opencode command dir + locale doc mirrors like
 * docs/ja-JP/commands are not real Claude commands).
 *
 * GLOB-FREE + PLATFORM-PINNED (the Windows lesson): roots are built with the
 * platform's join (win32.join on 'win32', posix.join elsewhere) — never a
 * hardcoded '/' and never a shell/fast-glob '*'. The per-market/plugin/version
 * wildcards are expanded by READING the dirs, deterministically + cross-platform.
 *
 * Fully dependency-injected (platform, homeDir, cwd, readdir, existsSync) so tests
 * can drive any platform/fs.
 */

// Bound the shipped command list so a pathological machine can never inflate the
// payload. Mirrors the skills cap.
const MAX_INSTALLED_COMMANDS = 200;
// Directory names that are never real Claude command dirs even when they sit under
// a `commands` root (the opencode command dir + locale doc mirrors).
const EXCLUDED_DIR_NAMES = new Set(['.opencode', 'docs']);
// Bound recursion depth so a pathological symlink/loop cannot spin forever.
const MAX_WALK_DEPTH = 8;

/** A directory entry as returned by readdir(withFileTypes:true). */
interface DirentLike {
  readonly name: string;
  isDirectory(): boolean;
}

export interface ScanInstalledCommandsOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly existsSync?: (path: string) => boolean;
  readonly readdir?: (
    path: string,
    options: { withFileTypes: true },
  ) => Promise<DirentLike[]>;
}

interface ScanDeps {
  readonly fileExists: (path: string) => boolean;
  readonly readdir: NonNullable<ScanInstalledCommandsOptions['readdir']>;
  readonly join: (...parts: string[]) => string;
}

/**
 * Scan the dev's on-disk slash-command roots and return a deduped, SORTED string[]
 * of command ids (capped). Fully DI'd. Never throws.
 */
export async function scanInstalledCommands(
  options: ScanInstalledCommandsOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? processCwd();
  const fileExists = options.existsSync ?? nodeExistsSync;
  const readdir =
    options.readdir ??
    (fsReaddir as unknown as NonNullable<ScanInstalledCommandsOptions['readdir']>);

  const pathApi = platform === 'win32' ? win32 : posix;
  const j = (...parts: string[]) => pathApi.join(...parts);
  const deps: ScanDeps = { fileExists, readdir, join: j };

  const homeClaude = j(homeDir, '.claude');
  const pluginsRoot = j(homeClaude, 'plugins');
  const cacheRoot = j(pluginsRoot, 'cache');
  const marketplacesRoot = j(pluginsRoot, 'marketplaces');

  // The `commands` roots, expanded in priority order. Each is walked recursively.
  const commandRoots: string[] = [
    j(homeClaude, 'commands'),
    j(cwd, '.claude', 'commands'),
  ];

  // (3) plugin CACHE: cache/<market>/<plugin>/<version>/commands.
  for (const market of await safeReaddirDirs(cacheRoot, deps)) {
    const marketDir = j(cacheRoot, market);
    for (const plugin of await safeReaddirDirs(marketDir, deps)) {
      const pluginDir = j(marketDir, plugin);
      for (const version of await safeReaddirDirs(pluginDir, deps)) {
        commandRoots.push(j(pluginDir, version, 'commands'));
      }
    }
  }

  // (4) marketplace-bundled: marketplaces/<market>/plugins/<plugin>/commands.
  // (5) marketplace-root:    marketplaces/<market>/commands.
  // Root 4 is pushed BEFORE root 5 so first-seen-wins matches the spec's 1>2>3>4>5
  // priority on a same-id collision within one market (the bundled plugin command
  // wins over a market-root command of the same name).
  for (const market of await safeReaddirDirs(marketplacesRoot, deps)) {
    const marketDir = j(marketplacesRoot, market);
    const pluginsDir = j(marketDir, 'plugins');
    for (const plugin of await safeReaddirDirs(pluginsDir, deps)) {
      commandRoots.push(j(pluginsDir, plugin, 'commands')); // (4)
    }
    commandRoots.push(j(marketDir, 'commands')); // (5)
  }

  const ids = new Set<string>();
  for (const root of commandRoots) {
    // Skip an entire root whose own path already crosses an excluded segment (an
    // .opencode plugin dir or a docs mirror reached via the cache/marketplace
    // expansion) — the per-walk check below only sees segments BELOW the root.
    if (containsExcludedSegment(root)) continue;
    await walkCommands(root, ids, deps, 0);
  }

  return [...ids].sort().slice(0, MAX_INSTALLED_COMMANDS);
}

/**
 * True when any path segment is an excluded name (.opencode / docs). Splits on BOTH
 * separators so it is correct regardless of the platform that built the path.
 */
function containsExcludedSegment(path: string): boolean {
  for (const segment of path.split(/[/\\]+/)) {
    if (EXCLUDED_DIR_NAMES.has(segment)) return true;
  }
  return false;
}

/**
 * Recursively collect command ids under a `commands` root. `.md` files contribute
 * their LEAF basename (minus extension); subdirectories are descended (nested
 * commands) EXCEPT excluded names (.opencode / docs). Any fs error per dir degrades
 * to the readable subset (per-dir catch — never throws). Depth-bounded.
 */
async function walkCommands(
  dir: string,
  ids: Set<string>,
  deps: ScanDeps,
  depth: number,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  if (!deps.fileExists(dir)) return;
  let entries: DirentLike[];
  try {
    entries = await deps.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      await walkCommands(deps.join(dir, entry.name), ids, deps, depth + 1);
    } else if (entry.name.endsWith('.md')) {
      const id = entry.name.slice(0, -'.md'.length);
      if (id.length > 0) ids.add(id); // first-seen wins (Set is insertion-deduped).
    }
  }
}

/**
 * Read a directory's immediate sub-DIRECTORY names. A missing root or any fs error
 * degrades to [] (per-root catch — never throws). Non-directory entries are ignored.
 * Used to expand the per-market/plugin/version wildcards by READING, not globbing.
 */
async function safeReaddirDirs(dir: string, deps: ScanDeps): Promise<string[]> {
  if (!deps.fileExists(dir)) return [];
  try {
    const entries = await deps.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
