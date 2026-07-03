/**
 * src/brain/local-context-probe.ts — GATHER the dev's local context (SPEC §8.6 / §15).
 *
 * The quality cascade's suppression gate (judge-cascade.ts `localContextSuppresses`)
 * needs to know cheap, local facts the LLM judge cannot see: is the dev ALREADY in plan
 * mode, does CLAUDE.md already document the test command, is the working tree a clean
 * branch (so an "undo" already exists). This module GATHERS those signals from three
 * sources — the live session JSONL, `git`, and a couple of on-disk config files — behind
 * INJECTED I/O seams so the whole thing unit-tests with zero real I/O.
 *
 * THE LOAD-BEARING CONTRACT (verify, don't assume):
 *  - This module NEVER throws. EVERY signal is independently try/caught and degrades to
 *    `null` (UNKNOWN). A torn JSONL line, a missing repo, an unreadable file — none are
 *    fatal; they just leave that one signal UNKNOWN.
 *  - UNKNOWN (null) is NOT the same as a negative observation. We report a positive fact
 *    ONLY on positive evidence. The suppression gate treats UNKNOWN as "never suppress".
 *    (The one exception is `project.claudeMdPresent`, which is reported `false` on a
 *    definite absence — it is used additively, NEVER to fire or suppress.)
 *  - We do NOT depend on line-parser.ts (the strict typed-prompt gate). This is a
 *    separate, PERMISSIVE scan: we want assistant lines + any mode/effort fields, which
 *    the typed gate deliberately rejects.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalContext } from './judge-cascade.js';
import type { CapabilityModelFamily } from '../capability/catalog.js';

/** The injected I/O seams + the two payload-derived paths the probe reads. */
export interface ProbeDeps {
  /** payload.transcript_path — the live `.jsonl` session file. */
  readonly transcriptPath: string;
  /** payload.cwd — the project working directory. */
  readonly cwd: string;
  /** Defaults to os.homedir(). */
  readonly homeDir?: string;
  /** Read a file's utf8 content; returns null on ANY error (default: fs.readFileSync). */
  readonly readFile?: (p: string) => string | null;
  /** Run `git <args>` in `cwd`; returns stdout or null on ANY error (default: spawnSync). */
  readonly runGit?: (args: string[], cwd: string) => string | null;
}

/** Test-command signals (case-folded substring match) that count as "documented". */
const TEST_CMD_SIGNALS: readonly string[] = [
  'npm test',
  'npm run test',
  'pnpm test',
  'yarn test',
  'vitest',
  'jest',
  'pytest',
  'go test',
  'cargo test',
  'make test',
  'test command:',
  'run tests',
];

/** Phrases that indicate plan mode is MANDATED (not merely mentioned). */
const PLAN_MANDATE_WORDS: readonly string[] = ['always', 'mandatory', 'must', 'required'];

/** Default file reader: utf8, null on any error (missing/permission/etc). NEVER throws. */
function defaultReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Default git runner: spawnSync, trimmed stdout on success, null on any error/failure. */
function defaultRunGit(args: string[], cwd: string): string | null {
  try {
    const res = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 1500,
    });
    if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;
    return res.stdout;
  } catch {
    return null;
  }
}

/**
 * GATHER the local context. Each signal is independently guarded so a failure in one
 * (a torn JSONL line, a missing repo, an unreadable CLAUDE.md) NEVER affects the others
 * and NEVER throws — it just leaves that signal UNKNOWN (null).
 */
export function gatherLocalContext(deps: ProbeDeps): LocalContext {
  const readFile = deps.readFile ?? defaultReadFile;
  const runGit = deps.runGit ?? defaultRunGit;
  const homeDir = deps.homeDir ?? safeHomeDir();

  const jsonl = liftFromJsonl(deps.transcriptPath, readFile);
  const git = liftGit(deps.cwd, runGit);
  const project = liftProject(deps.cwd, homeDir, readFile);

  return {
    activeModel: jsonl.activeModel,
    mode: jsonl.mode,
    effort: jsonl.effort,
    git,
    project,
  };
}

function safeHomeDir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

// ── JSONL lift ────────────────────────────────────────────────────────────────

interface JsonlSignals {
  readonly activeModel: string | null;
  readonly mode: string | null;
  readonly effort: string | null;
}

/**
 * Walk the session `.jsonl` line by line (PERMISSIVE scan, NOT the typed gate) and lift:
 *  - activeModel = the LAST assistant line's `message.model`,
 *  - mode = the LAST top-level `mode` or `permissionMode` value (last-seen wins),
 *  - effort = the LAST `effort` field (top-level or on the message).
 * Every line is parsed in its own try/catch — a malformed line is skipped, never fatal.
 * A missing/empty/unreadable file yields all-null.
 */
function liftFromJsonl(
  transcriptPath: string,
  readFile: (p: string) => string | null,
): JsonlSignals {
  let activeModel: string | null = null;
  let mode: string | null = null;
  let effort: string | null = null;
  try {
    const raw = readFile(transcriptPath);
    if (raw === null || raw.length === 0) return { activeModel, mode, effort };
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let o: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object') {
          o = parsed as Record<string, unknown>;
        }
      } catch {
        continue; // torn / non-JSON line — skip.
      }
      if (o === null) continue;

      const msg =
        o.message !== null && typeof o.message === 'object'
          ? (o.message as Record<string, unknown>)
          : null;

      // activeModel = LAST assistant line's message.model.
      if (o.type === 'assistant' && msg !== null && typeof msg.model === 'string' && msg.model.length > 0) {
        activeModel = msg.model;
      }

      // mode = LAST top-level mode OR permissionMode (whichever appears later wins).
      if (typeof o.mode === 'string' && o.mode.length > 0) mode = o.mode;
      if (typeof o.permissionMode === 'string' && o.permissionMode.length > 0) mode = o.permissionMode;

      // effort = LAST effort field, top-level or on the message.
      if (typeof o.effort === 'string' && o.effort.length > 0) effort = o.effort;
      if (msg !== null && typeof msg.effort === 'string' && msg.effort.length > 0) effort = msg.effort;
    }
  } catch {
    // any unexpected failure → leave whatever we lifted; the rest stays null.
  }
  return { activeModel, mode, effort };
}

// ── git lift ──────────────────────────────────────────────────────────────────

/**
 * Probe git state in `cwd`. branch from `rev-parse --abbrev-ref HEAD`:
 *  - 'HEAD' (detached) → onBranch=false, branch='HEAD',
 *  - a real branch name → onBranch=true, branch=that.
 * If the branch probe returns null/empty (no repo / git missing) → return null entirely
 * (UNKNOWN — we do NOT fabricate a clean state). dirty from `status --porcelain`:
 * non-empty→true, empty→false, null→dirty=null.
 */
function liftGit(
  cwd: string,
  runGit: (args: string[], cwd: string) => string | null,
): NonNullable<LocalContext['git']> | null {
  try {
    const branchOut = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (branchOut === null) return null; // no repo / git missing → UNKNOWN.
    const branch = branchOut.trim();
    if (branch.length === 0) return null; // empty → UNKNOWN.
    const onBranch = branch !== 'HEAD';

    let dirty: boolean | null = null;
    const statusOut = runGit(['status', '--porcelain'], cwd);
    if (statusOut !== null) dirty = statusOut.trim().length > 0;

    return { onBranch, dirty, branch };
  } catch {
    return null;
  }
}

// ── project lift ──────────────────────────────────────────────────────────────

/**
 * Probe the project config. Reads `<cwd>/CLAUDE.md`, `<cwd>/.claude/settings.json`, and
 * `<homeDir>/.claude/settings.json`. claudeMdPresent is reported false on a definite
 * absence (used additively only). testCmdDocumented / planModeMandated / hooksConfigured
 * are TRUE only on positive evidence, else NULL (UNKNOWN). NEVER throws.
 */
function liftProject(
  cwd: string,
  homeDir: string,
  readFile: (p: string) => string | null,
): NonNullable<LocalContext['project']> {
  let claudeMdPresent = false;
  let testCmdDocumented: boolean | null = null;
  let planModeMandated: boolean | null = null;
  let hooksConfigured: boolean | null = null;

  // CLAUDE.md.
  try {
    const claudeMd = readFile(join(cwd, 'CLAUDE.md'));
    if (claudeMd !== null) {
      claudeMdPresent = true;
      const folded = claudeMd.toLowerCase();
      if (TEST_CMD_SIGNALS.some((sig) => folded.includes(sig))) testCmdDocumented = true;
      if (mentionsPlanMandate(folded)) planModeMandated = true;
    }
  } catch {
    // leave defaults.
  }

  // settings.json — cwd first, then home (either source can satisfy a positive signal).
  for (const settingsPath of [join(cwd, '.claude', 'settings.json'), join(homeDir, '.claude', 'settings.json')]) {
    try {
      const raw = readFile(settingsPath);
      if (raw === null) continue;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') continue;
      const o = parsed as Record<string, unknown>;

      // hooksConfigured: a non-empty `hooks` key.
      if (hooksConfigured !== true && hasNonEmptyHooks(o.hooks)) hooksConfigured = true;

      // A settings-level plan-mode mandate flag is also evidence.
      if (planModeMandated !== true && settingsMandatesPlan(o)) planModeMandated = true;
    } catch {
      // unparseable / unreadable settings — skip this source.
    }
  }

  return { claudeMdPresent, testCmdDocumented, planModeMandated, hooksConfigured };
}

/** A CLAUDE.md mentions 'plan mode' AND a mandate word (always/mandatory/must/required). */
function mentionsPlanMandate(folded: string): boolean {
  if (!folded.includes('plan mode')) return false;
  return PLAN_MANDATE_WORDS.some((w) => folded.includes(w));
}

/** A settings object carries an explicit plan-mode mandate flag. */
function settingsMandatesPlan(o: Record<string, unknown>): boolean {
  // Tolerate a couple of plausible flag names; positive boolean true only.
  return o.planModeMandated === true || o.alwaysPlanMode === true;
}

/** True iff `hooks` is a non-empty object (or array) — i.e. at least one hook configured. */
function hasNonEmptyHooks(hooks: unknown): boolean {
  if (hooks === null || typeof hooks !== 'object') return false;
  return Object.keys(hooks as Record<string, unknown>).length > 0;
}

// ── model-string → family ───────────────────────────────────────────────────────

/**
 * Map a RAW model string (from the JSONL) to a CapabilityModelFamily for the §5.5.5b
 * model-gate, or undefined when the family is unknown / not gated. Opus 4.7/4.8 → opus;
 * Opus 4.5/4.6 → opus46; 'claude-fable-*' → fable; 'claude-mythos-*' → mythos; a Sonnet 5
 * string → sonnet5; a Sonnet 4.x string → sonnet; a GPT/Codex model string → codex; haiku /
 * unknown / null / undefined → undefined (genuinely unknown families fail open — gate skipped).
 *
 * The version splits are the load-bearing W2-MODELGATE case: `--effort xhigh` is available on
 * Opus 4.8/4.7 + Sonnet 5 but NOT Opus 4.6 or Sonnet 4.6 (official effort matrix, fetched
 * 2026-06-30: platform.claude.com/docs/en/build-with-claude/effort — Opus 4.6 / Sonnet 4.6 are
 * `max`-only, where `xhigh` silently falls back to `high`). So:
 *  - Sonnet 5 → `sonnet5` (IN scope); Sonnet 4.x → `sonnet` (KNOWN, OUT of scope → gate hides).
 *  - Opus 4.7/4.8 → `opus` (IN scope); Opus 4.5/4.6 → `opus46` (KNOWN, OUT of scope → gate hides).
 * The OUT-of-scope versions MUST be tested BEFORE the generic family match: Opus 4.6 is detected
 * by a `4.5`/`4.6` minor right after the `opus` token; Sonnet 5 by a `5` right after `sonnet`.
 */
const SONNET5_RE = /sonnet[-\s]?5(?![.\d])/;
const OPUS46_RE = /opus[-\s]?4[-.\s]?[56](?!\d)/;

export function modelStringToFamily(raw: string | null | undefined): CapabilityModelFamily | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const m = raw.toLowerCase();
  // Opus 4.5/4.6 BEFORE the generic `opus` fall-through: these are max-only (NOT xhigh) →
  // the `opus46` family (known, out of xhigh scope) so the gate actively excludes them.
  if (OPUS46_RE.test(m)) return 'opus46';
  if (m.includes('opus')) return 'opus';
  if (m.includes('fable')) return 'fable';
  if (m.includes('mythos')) return 'mythos';
  // Sonnet 5 BEFORE the generic `sonnet` fall-through: only a `sonnet…5` string is
  // xhigh-scoped. A Sonnet 4.x string then maps to the `sonnet` family (known, out of xhigh
  // scope) so the gate actively excludes it — the over-fire fix.
  if (SONNET5_RE.test(m)) return 'sonnet5';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('codex') || m.includes('gpt')) return 'codex';
  return undefined;
}
