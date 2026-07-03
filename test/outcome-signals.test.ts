/**
 * outcome-signals.test.ts — W2-OUTCOME (Phase 1): the permissive reader + honest extractors.
 *
 * Load-bearing honesty guards (docs/DESIGN-outcome-scoring.md §3):
 *  - tests-passed emits ONLY on a whitelisted runner's OWN summary grammar.
 *  - The extractor stays SILENT on `curl`-assertion `expect 400` and prose "passed" (the
 *    precision wall — a naive grep would over-count).
 *  - A missing signal is "no-signal", NEVER 0 / a passing default.
 *  - NEVER infer pass/fail from an exit code (none exists); an interrupted run → no clean pass.
 *  - change-size is a labeled proxy; commit prefers the structured gitOperation.
 */
import { describe, it, expect } from 'vitest';
import { scanToolEvents, type ToolEvent } from '../src/jsonl/outcome-reader.js';
import {
  testSignal,
  commitSignal,
  changeSizeSignal,
  buildOutcomeReport,
  renderOutcomeLine,
  PRUNE_RECAP_MIN_ADDED,
  PRUNE_RECAP_MIN_FILES,
  type OutcomeReport,
} from '../src/brain/outcome-signals.js';

// ── JSONL fixture builders (shaped like real Claude Code sessions) ────────────

let uid = 0;
function id(): string {
  uid += 1;
  return `toolu_${uid}`;
}

/** An assistant line with one tool_use block. */
function toolUseLine(name: string, input: Record<string, unknown>, tuid: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: tuid, name, input }] },
  });
}

/** A user line with the matching tool_result + the structured toolUseResult. */
function toolResultLine(tuid: string, toolUseResult: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid }] },
    toolUseResult,
  });
}

/** A full Bash call+result pair as two JSONL lines. */
function bashPair(command: string, result: Record<string, unknown>): string {
  const tuid = id();
  return `${toolUseLine('Bash', { command }, tuid)}\n${toolResultLine(tuid, result)}`;
}

function editPair(filePath: string, structuredPatch: unknown): string {
  const tuid = id();
  return `${toolUseLine('Edit', { file_path: filePath }, tuid)}\n${toolResultLine(tuid, { filePath, structuredPatch })}`;
}

// ── 1. The reader pairs tool_use → result ────────────────────────────────────

describe('W2-OUTCOME — scanToolEvents (permissive pairing)', () => {
  it('pairs a Bash tool_use with its result by tool_use_id', () => {
    const jsonl = bashPair('npm test', { stdout: 'Tests  3 passed (3)', stderr: '', interrupted: false });
    const events = scanToolEvents(jsonl);
    expect(events.length).toBe(1);
    expect(events[0].toolName).toBe('Bash');
    expect(events[0].command).toBe('npm test');
    expect(events[0].stdout).toContain('3 passed');
  });

  it('tolerates torn / non-JSON lines and a result with no captured tool_use (never throws)', () => {
    const jsonl = ['not json {', '', toolResultLine('orphan-id', { stdout: 'x' }), bashPair('ls', { stdout: 'a' })].join('\n');
    const events = scanToolEvents(jsonl);
    expect(events.length).toBe(1); // only the real pair; the orphan result is skipped.
    expect(events[0].command).toBe('ls');
  });

  it('empty / null / undefined → []', () => {
    expect(scanToolEvents('')).toEqual([]);
    expect(scanToolEvents(null)).toEqual([]);
    expect(scanToolEvents(undefined)).toEqual([]);
  });
});

// ── 2. testSignal — the precision wall ───────────────────────────────────────

describe('W2-OUTCOME — testSignal (runner allowlist + grammar)', () => {
  it('vitest summary → measured pass count', () => {
    const ev = scanToolEvents(bashPair('npm test', { stdout: ' Test Files  3 passed (3)\n      Tests  53 passed (53)', stderr: '', interrupted: false }));
    const s = testSignal(ev);
    expect(s.provenance).toBe('measured');
    expect(s.ran).toBe(true);
    expect(s.passed).toBe(53);
    expect(s.failed).toBe(0);
    expect(s.runner).toBe('vitest');
  });

  it('vitest with failures → passed + failed both measured', () => {
    const ev = scanToolEvents(bashPair('npm test', { stdout: '      Tests  4 failed | 49 passed (53)', stderr: '', interrupted: false }));
    const s = testSignal(ev);
    expect(s.passed).toBe(49);
    expect(s.failed).toBe(4);
  });

  it('coverage table → coverage % measured', () => {
    const out = '      Tests  10 passed (10)\nAll files |  95.85 |    88 |   92 |  95.85 |';
    const s = testSignal(scanToolEvents(bashPair('npm run coverage', { stdout: out, stderr: '', interrupted: false })));
    expect(s.coverage).toBe(95.85);
  });

  it('pytest / jest / go / cargo summaries are each recognized', () => {
    const pytest = testSignal(scanToolEvents(bashPair('pytest', { stdout: '===== 12 passed, 1 failed in 0.34s =====', stderr: '', interrupted: false })));
    expect(pytest.runner).toBe('pytest');
    expect(pytest.passed).toBe(12);
    expect(pytest.failed).toBe(1);

    const jest = testSignal(scanToolEvents(bashPair('jest', { stdout: 'Tests:       3 failed, 49 passed, 52 total', stderr: '', interrupted: false })));
    expect(jest.runner).toBe('jest');
    expect(jest.passed).toBe(49);
    expect(jest.failed).toBe(3);

    const go = testSignal(scanToolEvents(bashPair('go test ./...', { stdout: 'ok  example/pkg 0.1s', stderr: '', interrupted: false })));
    expect(go.runner).toBe('go');
    expect(go.passed).toBe(1);

    const cargo = testSignal(scanToolEvents(bashPair('cargo test', { stdout: 'test result: ok. 8 passed; 0 failed; 0 ignored', stderr: '', interrupted: false })));
    expect(cargo.runner).toBe('cargo');
    expect(cargo.passed).toBe(8);
  });

  it('SILENT on a curl assertion ("expect 400") — not a test runner (the precision wall)', () => {
    const ev = scanToolEvents(bashPair('curl -s localhost/health', { stdout: 'HTTP 400 — expect 400 passed', stderr: '', interrupted: false }));
    const s = testSignal(ev);
    expect(s.provenance).toBe('no-signal');
    expect(s.ran).toBe(false);
  });

  it('SILENT on prose "passed" with no runner summary grammar', () => {
    const ev = scanToolEvents(bashPair('echo done', { stdout: 'the migration passed without issues', stderr: '', interrupted: false }));
    expect(testSignal(ev).provenance).toBe('no-signal');
  });

  it('an INTERRUPTED test run → ran:true but passed/failed null (never a clean pass from a kill)', () => {
    const ev = scanToolEvents(bashPair('npm test', { stdout: '      Tests  10 passed (10)', stderr: '', interrupted: true }));
    const s = testSignal(ev);
    expect(s.ran).toBe(true);
    expect(s.passed).toBeNull();
    expect(s.source).toContain('interrupted');
  });

  it('no test run at all → no-signal (NOT 0 passed)', () => {
    const ev = scanToolEvents(bashPair('ls -la', { stdout: 'file1 file2', stderr: '', interrupted: false }));
    const s = testSignal(ev);
    expect(s.provenance).toBe('no-signal');
    expect(s.passed).toBeNull(); // never defaults to 0.
  });

  it('the LAST recognized run wins (final session state)', () => {
    const jsonl = [
      bashPair('npm test', { stdout: '      Tests  1 passed (1)', stderr: '', interrupted: false }),
      bashPair('npm test', { stdout: '      Tests  99 passed (99)', stderr: '', interrupted: false }),
    ].join('\n');
    expect(testSignal(scanToolEvents(jsonl)).passed).toBe(99);
  });
});

// ── 3. commitSignal ──────────────────────────────────────────────────────────

describe('W2-OUTCOME — commitSignal', () => {
  it('prefers the structured gitOperation.commit.sha', () => {
    const tuid = id();
    const jsonl = `${toolUseLine('Bash', { command: 'git commit' }, tuid)}\n${toolResultLine(tuid, { stdout: '', gitOperation: { commit: { sha: 'abc1234', kind: 'committed' } } })}`;
    const s = commitSignal(scanToolEvents(jsonl));
    expect(s.committed).toBe(true);
    expect(s.sha).toBe('abc1234');
  });

  it('falls back to a clean `git commit` command (no sha) when no gitOperation', () => {
    const s = commitSignal(scanToolEvents(bashPair('git commit -m "x"', { stdout: '1 file changed', stderr: '', interrupted: false })));
    expect(s.committed).toBe(true);
    expect(s.sha).toBeNull();
  });

  it('a git commit that errored (stderr fatal:) → not counted', () => {
    const s = commitSignal(scanToolEvents(bashPair('git commit', { stdout: '', stderr: 'fatal: nothing to commit', interrupted: false })));
    expect(s.committed).toBe(false);
  });

  it('no commit → no-signal', () => {
    expect(commitSignal(scanToolEvents(bashPair('ls', { stdout: 'x', stderr: '', interrupted: false }))).provenance).toBe('no-signal');
  });
});

// ── 4. changeSizeSignal (labeled proxy) ──────────────────────────────────────

describe('W2-OUTCOME — changeSizeSignal (proxy, not "quality")', () => {
  it('sums added/removed across EVERY edit (churn proxy) + counts distinct files', () => {
    const patchA = [{ lines: ['+a', '+b', '-c'] }]; // +2 / -1
    const patchB = [{ lines: ['+x'] }]; //              +1 / -0
    // Three edits: /a.ts (patchA), /b.ts (patchB), /a.ts AGAIN (patchB). The churn proxy sums
    // ALL edits (2+1+1 added = 4), but counts /a.ts once for distinct files (2).
    const jsonl = [editPair('/a.ts', patchA), editPair('/b.ts', patchB), editPair('/a.ts', patchB)].join('\n');
    const s = changeSizeSignal(scanToolEvents(jsonl));
    expect(s.provenance).toBe('measured');
    expect(s.added).toBe(4);
    expect(s.removed).toBe(1);
    expect(s.filesChanged).toBe(2); // /a.ts counted once.
  });

  it('no edits → no-signal (0/0/0 but explicitly no-signal, not measured-zero)', () => {
    const s = changeSizeSignal(scanToolEvents(bashPair('ls', { stdout: 'x', stderr: '', interrupted: false })));
    expect(s.provenance).toBe('no-signal');
  });
});

// ── 5. renderOutcomeLine — honest, no fabrication ────────────────────────────

describe('W2-OUTCOME — renderOutcomeLine', () => {
  it('renders measured signals as one factual line', () => {
    const jsonl = [
      bashPair('npm test', { stdout: '      Tests  422 passed (422)\nAll files |  96.0 |', stderr: '', interrupted: false }),
      editPair('/a.ts', [{ lines: ['+a', '+b'] }]),
      `${toolUseLine('Bash', { command: 'git commit' }, id())}`,
    ].join('\n');
    // (the git commit has no result line → not paired → not counted; that's fine for this case)
    const line = renderOutcomeLine(buildOutcomeReport(scanToolEvents(jsonl)));
    expect(line).toContain('422 tests passed');
    expect(line).toContain('96% coverage');
    expect(line).toContain('1 file changed');
  });

  it('nothing measured → "" (never a fabricated "0 tests passed" line)', () => {
    const line = renderOutcomeLine(buildOutcomeReport(scanToolEvents(bashPair('ls', { stdout: 'x', stderr: '', interrupted: false }))));
    expect(line).toBe('');
  });

  it('test run absent but edits present → honest "no test run detected"', () => {
    const line = renderOutcomeLine(buildOutcomeReport(scanToolEvents(editPair('/a.ts', [{ lines: ['+a'] }]))));
    expect(line).toContain('no test run detected');
    expect(line).toContain('1 file changed');
  });

  // ── item 6: recap honesty ──────────────────────────────────────────────────
  it('go reports PACKAGES, not "tests" (go has no per-test count)', () => {
    const line = renderOutcomeLine(
      buildOutcomeReport(scanToolEvents(bashPair('go test ./...', { stdout: 'ok  example/pkg  0.2s\nok  example/other  0.1s', stderr: '', interrupted: false }))),
    );
    expect(line).toContain('2 packages passed');
    expect(line).not.toMatch(/\d+ tests passed/); // never mislabel packages as tests.
  });

  it('cargo (real per-test counts) still reads "tests passed"', () => {
    const line = renderOutcomeLine(
      buildOutcomeReport(scanToolEvents(bashPair('cargo test', { stdout: 'test result: ok. 8 passed; 0 failed; 0 ignored', stderr: '', interrupted: false }))),
    );
    expect(line).toContain('8 tests passed');
  });

  it('"no test run detected" is at the END of the line, not the LEAD', () => {
    // With edits present, the change clause leads; the no-test clause tails.
    const line = renderOutcomeLine(buildOutcomeReport(scanToolEvents(editPair('/a.ts', [{ lines: ['+a'] }]))));
    // Strip the "Last session: " prefix; the FIRST clause must NOT be the no-test one.
    const body = line.replace(/^Last session:\s*/, '');
    expect(body.startsWith('no test run detected')).toBe(false);
    expect(line).toMatch(/no test run detected\.?$/); // it ends the line.
  });
});

// ── 5b. The DEMOTED L34b: a retrospective prune clause on the recap ───────────
//
// The prompt-path prune lever was demoted here (M1 relevance overhaul): the only "your
// last change" claim left in the product is this clause, and it is sourced from the ended
// session's OWN Edit/Write patch counts (agent-attributed by construction) — never the
// whole dirty working tree. Retrospective, session-boundary, and conservative: a commit is
// a natural review checkpoint, so committed-large stays clause-free.

/** Build an OutcomeReport directly (no JSONL) so boundaries are exact. */
function reportWith(over: {
  added?: number;
  filesChanged?: number;
  committed?: boolean;
  changeMeasured?: boolean;
}): OutcomeReport {
  const changeMeasured = over.changeMeasured ?? true;
  return {
    tests: { provenance: 'no-signal', ran: false, passed: null, failed: null, coverage: null, runner: null, source: null },
    commit:
      over.committed === true
        ? { provenance: 'measured', committed: true, sha: 'abc1234' }
        : { provenance: 'no-signal', committed: false, sha: null },
    changeSize: changeMeasured
      ? { provenance: 'measured', added: over.added ?? 0, removed: 0, filesChanged: over.filesChanged ?? 0 }
      : { provenance: 'no-signal', added: 0, removed: 0, filesChanged: 0 },
  };
}

describe('W2-OUTCOME — renderOutcomeLine prune clause (the demoted L34b)', () => {
  it('a LARGE uncommitted change appends the retrospective prune clause', () => {
    const line = renderOutcomeLine(reportWith({ added: 900, filesChanged: 12 }));
    expect(line).toContain('worth a skim');
    expect(line).toContain('large and uncommitted');
  });

  it('a small change → no clause', () => {
    const line = renderOutcomeLine(reportWith({ added: 40, filesChanged: 2 }));
    expect(line).not.toContain('worth a skim');
    expect(line).toContain('2 files changed'); // the factual recap still renders.
  });

  it('a LARGE but COMMITTED change → no clause (a commit is a review checkpoint)', () => {
    const line = renderOutcomeLine(reportWith({ added: 900, filesChanged: 12, committed: true }));
    expect(line).not.toContain('worth a skim');
    expect(line).toContain('committed');
  });

  it('changeSize no-signal → no clause; everything-empty still renders "" (never fabricate)', () => {
    const noChange = renderOutcomeLine(reportWith({ changeMeasured: false, committed: true }));
    expect(noChange).not.toContain('worth a skim');
    expect(renderOutcomeLine(reportWith({ changeMeasured: false }))).toBe('');
  });

  it('boundaries: exactly at the floor → clause; one under on either axis → none', () => {
    expect(
      renderOutcomeLine(reportWith({ added: PRUNE_RECAP_MIN_ADDED, filesChanged: PRUNE_RECAP_MIN_FILES })),
    ).toContain('worth a skim');
    expect(
      renderOutcomeLine(reportWith({ added: PRUNE_RECAP_MIN_ADDED - 1, filesChanged: PRUNE_RECAP_MIN_FILES })),
    ).not.toContain('worth a skim');
    expect(
      renderOutcomeLine(reportWith({ added: PRUNE_RECAP_MIN_ADDED, filesChanged: PRUNE_RECAP_MIN_FILES - 1 })),
    ).not.toContain('worth a skim');
  });
});

// ── 6. A note on the real-session shape (documents the empirical contract) ────

describe('W2-OUTCOME — real-session field shape (the contract this reader depends on)', () => {
  it('reads stdout / gitOperation / structuredPatch off toolUseResult exactly as Claude Code writes them', () => {
    // This mirrors the verified-on-disk shape (2026-06-30): a Bash result carries
    // { stdout, stderr, interrupted }, a commit carries gitOperation.commit.{sha,kind}, an
    // Edit carries { filePath, structuredPatch }. If Claude Code changes these keys, THIS
    // test is the canary.
    const ev: ToolEvent[] = scanToolEvents(
      [
        bashPair('npm test', { stdout: '      Tests  53 passed (53)', stderr: '', interrupted: false }),
        editPair('/x.ts', [{ lines: ['+one', '-two'] }]),
      ].join('\n'),
    );
    expect(ev.find((e) => e.toolName === 'Bash')?.stdout).toContain('passed');
    expect(ev.find((e) => e.toolName === 'Edit')?.patch).toEqual({ added: 1, removed: 1 });
  });
});
