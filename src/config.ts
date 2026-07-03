/**
 * src/config.ts — paths, defaults, and the resolved judge path (SPEC §2, §8.1, §13).
 *
 * Pure / DI-friendly: every function takes its environment (env, dirname) as an
 * argument so a test can drive any base dir / plugin root without touching real
 * process globals. Nothing here does I/O except `isEnabled`, which reads state.json
 * through the injected store (and that read never throws — store contract).
 *
 * BASE DIR: ~/.claude/prompt-coach, overridable via PROMPT_COACH_DIR (tests point this
 * at a tmpdir). This is the single root for inbox/mailbox/patterns/state (§2).
 *
 * JUDGE PATH (load-bearing, §8.1/§11.1): the detached judge is path-ANCHORED to
 * CLAUDE_PLUGIN_ROOT/dist/judge.js when the plugin root is known, else the hook's OWN
 * __dirname-relative dist/judge.js. NEVER cwd-relative — a plugin installs under
 * ~/.claude/plugins/cache/.../dist/ so a bare `dist/judge.js` resolves against the
 * user's cwd and is never found.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BASE_DIR, type Store } from './state/store.js';

/** The env subset config reads. */
export interface ConfigEnv {
  /** Override the base dir (tests). When set+non-empty it wins over ~/.claude/prompt-coach. */
  PROMPT_COACH_DIR?: string | undefined;
  /** The plugin install root Claude Code sets when running a plugin hook (§11.1). */
  CLAUDE_PLUGIN_ROOT?: string | undefined;
}

/** The compiled judge filename relative to the dist root. */
export const JUDGE_FILENAME = 'judge.js';

// ── M2 same-turn coaching: the Stop-hook mailbox drain (PLAN §B Step 1) ────────
/**
 * How long the `Stop` hook is willing to wait for the concurrently-running judge's tip
 * before giving up (the tip then surfaces NEXT turn via the labeled UPS backstop).
 * Owner-locked at 7s: near-guarantees same-turn delivery even on fast turns, and the
 * cost is only ever a tail on the END of a fast COACHABLE turn — never on prompt entry.
 * Well-formed (silent) turns exit early on the judge-done marker [A2], not this cap.
 */
export const STOP_DRAIN_POLL_MS = 7000;
/** The poll tick between mailbox claims inside the Stop drain. */
export const STOP_DRAIN_INTERVAL_MS = 250;

/**
 * W2-OUTCOME scoping: a STABLE project key derived from the session's cwd. Fixes the
 * confirmed cross-project leak — a `last-outcome.json` is GLOBAL, so ending a session in
 * project A must not surface its recap in project B. The recap is only shown when the
 * record's projectKey matches the current session's. A null/empty cwd → '' (unscoped),
 * which NEVER matches, so an unknown-project record is never surfaced (fail-safe).
 *
 * Hotfix keeps this dependency-free (normalized absolute cwd, case-folded on darwin/win).
 * A future build may refine to the git-toplevel so worktrees/subdirs of one repo collapse.
 */
export function projectKeyForCwd(cwd: string | null | undefined): string {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return '';
  let key = cwd.trim().replace(/[/\\]+$/, ''); // strip trailing slash(es).
  if (process.platform === 'darwin' || process.platform === 'win32') key = key.toLowerCase();
  return key;
}

/**
 * Resolve the coach base dir: PROMPT_COACH_DIR (when set + non-empty) else
 * ~/.claude/prompt-coach. Pure — depends only on the passed env (+ homedir default).
 */
export function resolveBaseDir(env: ConfigEnv = process.env): string {
  const override = env.PROMPT_COACH_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return DEFAULT_BASE_DIR;
}

/** The concrete state/patterns paths under the base dir (§2). Mailbox/inbox are owned by the store. */
export function paths(env: ConfigEnv = process.env): {
  baseDir: string;
  statePath: string;
  patternsPath: string;
  mailboxDir: string;
  inboxDir: string;
} {
  const baseDir = resolveBaseDir(env);
  return {
    baseDir,
    statePath: join(baseDir, 'state.json'),
    patternsPath: join(baseDir, 'patterns.json'),
    mailboxDir: join(baseDir, 'mailbox'),
    inboxDir: join(baseDir, 'inbox'),
  };
}

/**
 * Resolve the absolute path to the compiled judge (`dist/judge.js`) the hook spawns
 * (§8.1). Anchored to CLAUDE_PLUGIN_ROOT/dist when the plugin root is known, else to the
 * hook's own dist dir (`hookDirname`, i.e. the dir the compiled hook.js lives in — both
 * hook.js and judge.js land in dist/). NEVER cwd-relative.
 *
 * @param hookDirname the directory of the running hook (pass `__dirname`-equivalent;
 *                    for ESM the caller derives it from import.meta.url).
 */
export function resolveJudgePath(hookDirname: string, env: ConfigEnv = process.env): string {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
  if (typeof pluginRoot === 'string' && pluginRoot.trim().length > 0) {
    return join(pluginRoot, 'dist', JUDGE_FILENAME);
  }
  // hookDirname is already the dist dir (the hook compiles to dist/hook.js), so the
  // judge is a sibling. This is __dirname-relative, never cwd-relative.
  return join(hookDirname, JUDGE_FILENAME);
}

/**
 * Is the coach enabled? Reads `state.enabled` via the injected store (defaults to true
 * for a fresh install). Never throws — the store read returns the default on any error.
 */
export function isEnabled(store: Store): boolean {
  return store.getState().enabled !== false;
}
