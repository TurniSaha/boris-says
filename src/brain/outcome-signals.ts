/**
 * outcome-signals.ts — W2-OUTCOME (Phase 1): PURE extractors that turn the permissively-scanned
 * tool events (jsonl/outcome-reader.ts) into HONEST per-signal facts. No I/O, no clock.
 *
 * Honesty rules (the outcome-scoring design; SPEC §5.2) encoded here:
 *  1. Every value carries provenance: 'measured' (real, from disk) vs 'no-signal' (not run /
 *     not recognized). A missing signal is NEVER 0 or a passing default.
 *  2. tests-passed emits ONLY on a WHITELISTED runner's own summary grammar in a paired
 *     result. Unrecognized runners, `curl` assertions (`expect 400`), and prose "passed" →
 *     no signal (the precision wall). The runner allowlist is small + verified.
 *  3. NEVER infer pass/fail from an exit code — none exists. Summary text + stderr/interrupted
 *     only. An `interrupted` test run → no clean pass signal.
 *  4. change-size is a LABELED PROXY (added/removed lines, file count) — never "quality".
 *  5. commit prefers the structured `gitOperation` over scraping stdout.
 *  6. NO combined 0–100 number — this module returns raw signals only.
 */
import type { ToolEvent } from '../jsonl/outcome-reader.js';

export type Provenance = 'measured' | 'no-signal';

/** A test-run signal. ran=false ⇒ no whitelisted runner summary was found (no-signal). */
export interface TestSignal {
  readonly provenance: Provenance;
  readonly ran: boolean;
  readonly passed: number | null;
  readonly failed: number | null;
  /** Coverage % (overall) when a coverage table is present, else null. */
  readonly coverage: number | null;
  /** The runner that produced the recognized summary (e.g. 'vitest'), else null. */
  readonly runner: string | null;
  /** Verbatim summary line(s) the signal was read from (provenance for the dev). */
  readonly source: string | null;
}

/** A commit signal — measured from the structured gitOperation (preferred) or a git command. */
export interface CommitSignal {
  readonly provenance: Provenance;
  readonly committed: boolean;
  /** Short SHA when available (from gitOperation), else null. */
  readonly sha: string | null;
}

/** A change-size PROXY — added/removed lines + distinct files edited this session. */
export interface ChangeSizeSignal {
  readonly provenance: Provenance;
  readonly added: number;
  readonly removed: number;
  readonly filesChanged: number;
  /**
   * FACTS tweak (b): true iff EVERY changed file is docs/config (never a source file). A
   * docs-only session (e.g. editing a README) drops the honest "no test run detected" clause
   * — you don't run a suite to touch a Markdown file. ANY source file present → false (keep
   * the honest clause). NO_CHANGE / no files → false (fail-safe).
   */
  readonly docsOnly: boolean;
}

/** The whole-session Outcome report — honest per-signal, NO combined score. */
export interface OutcomeReport {
  readonly tests: TestSignal;
  readonly commit: CommitSignal;
  readonly changeSize: ChangeSizeSignal;
}

// ── The DEMOTED L34b (M1 relevance overhaul) ──────────────────────────────────
/**
 * Retrospective prune-advice floor, values carried over from the retired prompt-path
 * L34b lever's config floors (120 added / 3 files): the recap only appends the prune
 * clause when the ended session's OWN agent edits were genuinely large — at least this
 * many added lines across at least this many files — AND nothing was committed (a commit
 * is a natural review checkpoint, so committed-large stays clause-free). Conservative on
 * purpose (precision wall): a small change never triggers anti-overengineering advice.
 *
 * HONEST ATTRIBUTION BY CONSTRUCTION: the change-size signal is computed from the ended
 * session's Edit/Write patch events — never the whole dirty working tree — so "that
 * change" is always the agent's own work. The clause is retrospective, session-boundary,
 * consume-once, and project-scoped (outcome-store.ts owns those pins).
 */
export const PRUNE_RECAP_MIN_ADDED = 120;
export const PRUNE_RECAP_MIN_FILES = 3;

/** The retrospective prune clause appended to the recap line (see the floor doc above). */
const PRUNE_RECAP_CLAUSE =
  ' That change is large and uncommitted — worth a skim for dead code or one-off abstractions before building on it.';

const NO_TEST: TestSignal = {
  provenance: 'no-signal',
  ran: false,
  passed: null,
  failed: null,
  coverage: null,
  runner: null,
  source: null,
};
const NO_COMMIT: CommitSignal = { provenance: 'no-signal', committed: false, sha: null };
const NO_CHANGE: ChangeSizeSignal = { provenance: 'no-signal', added: 0, removed: 0, filesChanged: 0, docsOnly: false };

/**
 * FACTS tweak (b): docs/config file extensions (lowercased, incl. leading dot). A file whose
 * basename is a dotfile, or is LICENSE / NOTICE, or ends in one of these is "docs/config".
 * Anything else — including any code extension (.ts .js .py .go .rs .java …) or an unknown /
 * extensionless file (e.g. Makefile) — is NOT docs-only, so the honest test clause is kept.
 */
const DOCS_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.lock', '.csv', '.html', '.css',
]);
const DOCS_BASENAMES: ReadonlySet<string> = new Set(['license', 'notice']);

/** True iff this single path is a docs/config file (dotfile / LICENSE / NOTICE / docs ext). */
function isDocsPath(path: string): boolean {
  // Basename is the last path segment (handles both / and \ separators, trailing text only).
  const base = path.split(/[\\/]/).pop() ?? path;
  if (base.length === 0) return false;
  if (base.startsWith('.')) return true; // a dotfile (.gitignore, .eslintrc, …).
  if (DOCS_BASENAMES.has(base.toLowerCase())) return true; // LICENSE / NOTICE (any case).
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false; // no extension (Makefile) → NOT docs-only (fail-safe).
  return DOCS_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/**
 * The runner allowlist. Each entry: a `detect` (does this output belong to this runner?) and
 * a `summary` matcher returning {passed, failed} from the runner's OWN summary grammar. We
 * deliberately key on the framework's distinctive summary line, NOT a bare "passed" (which
 * over-counts prose + curl `expect`). vitest/jest verified against real output; pytest / go /
 * cargo grammars added from their documented summary lines (fixture-confirm before trusting).
 */
interface Runner {
  readonly name: string;
  readonly summary: (text: string) => { passed: number; failed: number; line: string } | null;
}

/** Parse "Tests  53 passed (53)" / "Tests  4 failed | 49 passed (53)" (vitest/jest top line). */
function vitestSummary(text: string): { passed: number; failed: number; line: string } | null {
  // Match the framework's own summary line: starts with "Tests" (vitest) and reports counts.
  for (const line of text.split('\n')) {
    const m = /^\s*Tests\s+(?:(\d+)\s+failed[^\d]*)?(\d+)\s+passed\b/.exec(line);
    if (m) {
      const failed = m[1] !== undefined ? Number(m[1]) : 0;
      const passed = Number(m[2]);
      return { passed, failed, line: line.trim() };
    }
  }
  return null;
}

/** Parse jest "Tests:       3 failed, 49 passed, 52 total". */
function jestSummary(text: string): { passed: number; failed: number; line: string } | null {
  for (const line of text.split('\n')) {
    const m = /^\s*Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+\d+\s+total/.exec(line);
    if (m) {
      const failed = m[1] !== undefined ? Number(m[1]) : 0;
      const passed = Number(m[2]);
      return { passed, failed, line: line.trim() };
    }
  }
  return null;
}

/** Parse pytest "===== 12 passed, 1 failed in 0.34s =====" (and "12 passed in ..."). */
function pytestSummary(text: string): { passed: number; failed: number; line: string } | null {
  for (const line of text.split('\n')) {
    if (!/={3,}/.test(line) || !/\bpassed\b/.test(line)) continue;
    const passedM = /(\d+)\s+passed/.exec(line);
    if (passedM === null) continue;
    const failedM = /(\d+)\s+failed/.exec(line);
    return {
      passed: Number(passedM[1]),
      failed: failedM !== null ? Number(failedM[1]) : 0,
      line: line.trim(),
    };
  }
  return null;
}

/** Parse go test "ok  pkg  0.1s" / "FAIL pkg" — go reports pass/fail per package, not counts. */
function goSummary(text: string): { passed: number; failed: number; line: string } | null {
  const lines = text.split('\n');
  const okLines = lines.filter((l) => /^ok\s+\S/.test(l));
  const failLines = lines.filter((l) => /^(FAIL|---\s+FAIL)\b/.test(l));
  if (okLines.length === 0 && failLines.length === 0) return null;
  // go doesn't emit a passed-count; report package-level pass/fail as the honest proxy.
  return {
    passed: okLines.length,
    failed: failLines.length,
    line: (failLines[0] ?? okLines[0]).trim(),
  };
}

/** Parse cargo test "test result: ok. 12 passed; 0 failed; ...". */
function cargoSummary(text: string): { passed: number; failed: number; line: string } | null {
  for (const line of text.split('\n')) {
    const m = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/.exec(line);
    if (m) return { passed: Number(m[1]), failed: Number(m[2]), line: line.trim() };
  }
  return null;
}

const RUNNERS: readonly Runner[] = [
  { name: 'vitest', summary: vitestSummary },
  { name: 'jest', summary: jestSummary },
  { name: 'pytest', summary: pytestSummary },
  { name: 'go', summary: goSummary },
  { name: 'cargo', summary: cargoSummary },
];

/** Coverage % from a vitest/istanbul "All files | 95.85 | ..." row, else null. */
function coveragePct(text: string): number | null {
  for (const line of text.split('\n')) {
    const m = /All files\s*\|\s*([\d.]+)\s*\|/.exec(line);
    if (m) {
      const pct = Number(m[1]);
      if (Number.isFinite(pct)) return pct;
    }
  }
  return null;
}

/**
 * Extract the test signal. Considers ONLY Bash events (a runner runs via Bash). For each, if
 * the command looks like a test invocation AND a whitelisted runner's summary grammar is
 * present in stdout/stderr, emit a measured signal. An `interrupted` run yields NO clean pass
 * signal (rule 3). The LAST recognized run wins (the session's final state). No match → no-signal.
 */
export function testSignal(events: readonly ToolEvent[]): TestSignal {
  let latest: TestSignal | null = null;
  for (const e of events) {
    if (e.toolName !== 'Bash') continue;
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    if (out.trim().length === 0) continue;
    for (const runner of RUNNERS) {
      const s = runner.summary(out);
      if (s === null) continue;
      // An interrupted run is not a clean pass — record ran but null the pass/fail counts.
      const interrupted = e.interrupted;
      latest = {
        provenance: 'measured',
        ran: true,
        passed: interrupted ? null : s.passed,
        failed: interrupted ? null : s.failed,
        coverage: coveragePct(out),
        runner: runner.name,
        source: interrupted ? `${s.line} (interrupted)` : s.line,
      };
      break; // first matching runner for this event.
    }
  }
  return latest ?? NO_TEST;
}

/** Extract the commit signal — prefer the structured gitOperation; else a `git commit` cmd. */
export function commitSignal(events: readonly ToolEvent[]): CommitSignal {
  let latest: CommitSignal | null = null;
  for (const e of events) {
    // Preferred: the structured gitOperation.commit.
    if (e.gitOperation !== null) {
      const commit = e.gitOperation.commit;
      if (commit !== null && typeof commit === 'object') {
        const sha = (commit as Record<string, unknown>).sha;
        latest = { provenance: 'measured', committed: true, sha: typeof sha === 'string' ? sha : null };
        continue;
      }
    }
    // Fallback: a Bash `git commit` that did not error (we cannot read an exit code, so we
    // only count it when stderr does not clearly indicate a failure — conservative).
    if (e.toolName === 'Bash' && e.command !== null && /\bgit\s+commit\b/.test(e.command) && !e.interrupted) {
      const err = e.stderr ?? '';
      if (!/error:|fatal:/i.test(err)) {
        latest = { provenance: 'measured', committed: true, sha: null };
      }
    }
  }
  return latest ?? NO_COMMIT;
}

/** Extract the change-size PROXY from Edit/Write patch counts (added/removed/files). */
export function changeSizeSignal(events: readonly ToolEvent[]): ChangeSizeSignal {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  let any = false;
  for (const e of events) {
    if (e.toolName !== 'Edit' && e.toolName !== 'Write' && e.toolName !== 'NotebookEdit') continue;
    if (e.patch !== null) {
      added += e.patch.added;
      removed += e.patch.removed;
      any = true;
    }
    if (e.filePath !== null) {
      files.add(e.filePath);
      any = true;
    }
  }
  if (!any) return NO_CHANGE;
  // FACTS tweak (b): docs-only iff there IS at least one file and EVERY file is docs/config.
  const docsOnly = files.size > 0 && [...files].every(isDocsPath);
  return { provenance: 'measured', added, removed, filesChanged: files.size, docsOnly };
}

/** Compose the whole-session report from the scanned events. Pure. */
export function buildOutcomeReport(events: readonly ToolEvent[]): OutcomeReport {
  return {
    tests: testSignal(events),
    commit: commitSignal(events),
    changeSize: changeSizeSignal(events),
  };
}

/**
 * item 6: the honest count NOUN for a runner. `go test` reports pass/fail per PACKAGE (there
 * is no per-test count in its summary — goSummary counts `ok`/`FAIL` package lines), so the
 * count is PACKAGES, not tests. Every other whitelisted runner (vitest/jest/pytest/cargo)
 * emits real per-test counts → "tests". Pluralized for a count of 1.
 */
function testCountUnit(runner: string | null, count: number): string {
  const singular = runner === 'go' ? 'package' : 'test';
  return count === 1 ? singular : `${singular}s`;
}

/**
 * Render the report as ONE short factual line (or '' when there is NOTHING measured — never
 * fabricate a "0 tests passed" or a passing default). Each clause is verbatim-from-disk or a
 * labeled proxy, joined with ", " — and the "no test run detected" clause TAILS the line
 * (item 6), it never leads. NO score. Examples:
 *   "Last time here: 422 tests passed, 96% coverage, 3 files changed (+120/-40), committed."
 *   "Last time here: 2 files changed (+8/-3), no test run detected."
 */
export function renderOutcomeLine(report: OutcomeReport): string {
  const parts: string[] = [];
  // item 6: whether a test run was detected — its clause moves to the END, not the lead.
  let noTestRun = false;

  if (report.tests.provenance === 'measured' && report.tests.ran) {
    if (report.tests.passed !== null) {
      const failClause =
        report.tests.failed !== null && report.tests.failed > 0 ? `, ${report.tests.failed} failed` : '';
      // item 6 HONESTY: go reports PASS/FAIL per PACKAGE, not per test (no per-test count) —
      // render "N packages passed" for go; runners with real per-test counts stay "N tests
      // passed". Keyed on the runner that produced the summary.
      const unit = testCountUnit(report.tests.runner, report.tests.passed);
      parts.push(`${report.tests.passed} ${unit} passed${failClause}`);
    } else {
      parts.push('a test run was interrupted (no clean pass count)');
    }
    if (report.tests.coverage !== null) parts.push(`${report.tests.coverage}% coverage`);
  } else {
    // Do NOT lead with this — defer it to the end of the line (item 6).
    noTestRun = true;
  }

  if (report.changeSize.provenance === 'measured') {
    const f = report.changeSize.filesChanged;
    parts.push(`${f} file${f === 1 ? '' : 's'} changed (+${report.changeSize.added}/-${report.changeSize.removed})`);
  }

  if (report.commit.provenance === 'measured' && report.commit.committed) {
    parts.push(report.commit.sha !== null ? `committed (${report.commit.sha})` : 'committed');
  }

  // item 6: the "no test run detected" clause tails the line (never leads it). FACTS tweak
  // (b): DROP it for a docs/config-only session — you don't run a suite to edit a README, so
  // the honest clause would only read as noise. A session touching ANY source file keeps it.
  if (noTestRun && !report.changeSize.docsOnly) parts.push('no test run detected');

  // Nothing measured at all → '' so the caller surfaces nothing (no fabricated line).
  const everythingEmpty =
    report.tests.provenance === 'no-signal' &&
    report.commit.provenance === 'no-signal' &&
    report.changeSize.provenance === 'no-signal';
  if (everythingEmpty) return '';

  const line = `Last time here: ${parts.join(', ')}.`;

  // The DEMOTED L34b: append ONE retrospective prune clause when the ended session's own
  // agent edits were large AND uncommitted (see the PRUNE_RECAP_* doc). "That change" is
  // the recapped session's measured Edit/Write churn — no claim about the current prompt.
  const largeUncommitted =
    report.changeSize.provenance === 'measured' &&
    report.changeSize.added >= PRUNE_RECAP_MIN_ADDED &&
    report.changeSize.filesChanged >= PRUNE_RECAP_MIN_FILES &&
    !(report.commit.provenance === 'measured' && report.commit.committed);
  return largeUncommitted ? line + PRUNE_RECAP_CLAUSE : line;
}
