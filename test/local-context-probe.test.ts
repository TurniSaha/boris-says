import { describe, it, expect } from 'vitest';
import {
  gatherLocalContext,
  modelStringToFamily,
  type ProbeDeps,
} from '../src/brain/local-context-probe.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Build a stub readFile from a path→content map. Any path not in the map (or whose
 * value is null) reads as null (the real fs.readFileSync would throw → null).
 */
function fakeReadFile(files: Record<string, string | null>): (p: string) => string | null {
  return (p: string): string | null => {
    const v = files[p];
    return typeof v === 'string' ? v : null;
  };
}

/**
 * Build a stub runGit. Keyed by the FIRST git arg ('rev-parse' / 'status'); any
 * unmapped command reads as null (git missing / no repo).
 */
function fakeRunGit(
  byCommand: Record<string, string | null>,
): (args: string[], cwd: string) => string | null {
  return (args: string[]): string | null => {
    const key = args[0] ?? '';
    const v = byCommand[key];
    return typeof v === 'string' ? v : null;
  };
}

const NO_GIT = (): string | null => null;
const NO_FILES = (): string | null => null;

function jsonlLines(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

function probeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    transcriptPath: '/proj/.session.jsonl',
    cwd: '/proj',
    homeDir: '/home/dev',
    readFile: NO_FILES,
    runGit: NO_GIT,
    ...over,
  };
}

// ── modelStringToFamily ───────────────────────────────────────────────────────

describe('modelStringToFamily', () => {
  it('maps Opus 4.7/4.8 → opus (the xhigh-capable Opus family)', () => {
    expect(modelStringToFamily('claude-opus-4-8')).toBe('opus');
    expect(modelStringToFamily('claude-opus-4-8-20260101')).toBe('opus');
    expect(modelStringToFamily('claude-opus-4-7')).toBe('opus');
  });

  it('W2-MODELGATE: maps Opus 4.5/4.6 → opus46 (max-only, NOT xhigh — the xhigh split)', () => {
    // Opus 4.6/4.5 support `max` but NOT `xhigh` (xhigh silently falls back to high), so they
    // map to the known out-of-scope `opus46` family and the gate hides xhigh from them.
    expect(modelStringToFamily('CLAUDE-OPUS-4-5')).toBe('opus46');
    expect(modelStringToFamily('claude-opus-4-6')).toBe('opus46');
    expect(modelStringToFamily('claude-opus-4-6-20260101')).toBe('opus46');
  });

  it('maps a gpt / codex model → codex', () => {
    expect(modelStringToFamily('gpt-5.5-codex')).toBe('codex');
    expect(modelStringToFamily('gpt-5-codex')).toBe('codex');
    expect(modelStringToFamily('o4-codex')).toBe('codex');
    expect(modelStringToFamily('gpt-5.5')).toBe('codex');
  });

  it('maps claude-fable-* / claude-mythos-* → fable / mythos', () => {
    expect(modelStringToFamily('claude-fable-5')).toBe('fable');
    expect(modelStringToFamily('claude-mythos-5')).toBe('mythos');
  });

  it('W2-MODELGATE: maps Sonnet 5 → sonnet5, Sonnet 4.x → sonnet (the xhigh split)', () => {
    // Sonnet 5 IS xhigh-capable → its own family; Sonnet 4.x is NOT → the `sonnet` family
    // (known, out of xhigh scope) so the gate actively excludes it. The discriminator is the
    // major version digit right after `sonnet`.
    expect(modelStringToFamily('claude-sonnet-5')).toBe('sonnet5');
    expect(modelStringToFamily('claude-sonnet-5-20260630')).toBe('sonnet5');
    expect(modelStringToFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelStringToFamily('claude-sonnet-4-5')).toBe('sonnet');
  });

  it('maps haiku / unknown / null / undefined → undefined (genuinely unknown families fail open)', () => {
    expect(modelStringToFamily('claude-haiku-4-5')).toBeUndefined();
    expect(modelStringToFamily('some-other-model')).toBeUndefined();
    expect(modelStringToFamily('')).toBeUndefined();
    expect(modelStringToFamily(null)).toBeUndefined();
    expect(modelStringToFamily(undefined)).toBeUndefined();
  });
});

// ── JSONL lift ────────────────────────────────────────────────────────────────

describe('gatherLocalContext — JSONL lift', () => {
  it('lifts the LAST assistant model, last mode, last effort', () => {
    const jsonl = jsonlLines([
      { type: 'assistant', message: { model: 'claude-opus-4-5' } },
      { type: 'user', mode: 'normal' },
      { type: 'assistant', message: { model: 'claude-opus-4-8' } },
      { type: 'user', permissionMode: 'plan', effort: 'high' },
    ]);
    const ctx = gatherLocalContext(
      probeDeps({ readFile: fakeReadFile({ '/proj/.session.jsonl': jsonl }) }),
    );
    expect(ctx.activeModel).toBe('claude-opus-4-8'); // LAST assistant model wins.
    expect(ctx.mode).toBe('plan'); // permissionMode counts as a mode source.
    expect(ctx.effort).toBe('high');
  });

  it('top-level mode wins as a source alongside permissionMode (last seen)', () => {
    const jsonl = jsonlLines([
      { type: 'user', mode: 'plan' },
      { type: 'user', permissionMode: 'normal' },
    ]);
    const ctx = gatherLocalContext(
      probeDeps({ readFile: fakeReadFile({ '/proj/.session.jsonl': jsonl }) }),
    );
    expect(ctx.mode).toBe('normal'); // last seen, regardless of key name.
  });

  it('skips malformed lines without failing', () => {
    const jsonl = [
      '{ this is not json',
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } }),
      'half-written-line',
      JSON.stringify({ type: 'user', mode: 'plan' }),
      '',
    ].join('\n');
    const ctx = gatherLocalContext(
      probeDeps({ readFile: fakeReadFile({ '/proj/.session.jsonl': jsonl }) }),
    );
    expect(ctx.activeModel).toBe('claude-opus-4-8');
    expect(ctx.mode).toBe('plan');
    expect(ctx.effort).toBeNull();
  });

  it('empty / missing transcript file → activeModel/mode/effort all null', () => {
    const ctx = gatherLocalContext(probeDeps({ readFile: NO_FILES }));
    expect(ctx.activeModel).toBeNull();
    expect(ctx.mode).toBeNull();
    expect(ctx.effort).toBeNull();
  });
});

// ── git probe ─────────────────────────────────────────────────────────────────

describe('gatherLocalContext — git', () => {
  it('clean branch → onBranch true, dirty false', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        runGit: fakeRunGit({ 'rev-parse': 'feature/x\n', status: '' }),
      }),
    );
    expect(ctx.git).not.toBeNull();
    expect(ctx.git!.onBranch).toBe(true);
    expect(ctx.git!.branch).toBe('feature/x');
    expect(ctx.git!.dirty).toBe(false);
  });

  it('dirty main → onBranch true, dirty true', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        runGit: fakeRunGit({ 'rev-parse': 'main\n', status: ' M src/a.ts\n?? b.ts\n' }),
      }),
    );
    expect(ctx.git!.onBranch).toBe(true);
    expect(ctx.git!.branch).toBe('main');
    expect(ctx.git!.dirty).toBe(true);
  });

  it('detached HEAD → onBranch false, branch HEAD', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        runGit: fakeRunGit({ 'rev-parse': 'HEAD\n', status: '' }),
      }),
    );
    expect(ctx.git!.onBranch).toBe(false);
    expect(ctx.git!.branch).toBe('HEAD');
    expect(ctx.git!.dirty).toBe(false);
  });

  it('no repo / git missing (rev-parse null) → git is null entirely (UNKNOWN)', () => {
    const ctx = gatherLocalContext(probeDeps({ runGit: NO_GIT }));
    expect(ctx.git).toBeNull();
  });

  it('branch known but status null → dirty null (still a git object)', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        runGit: fakeRunGit({ 'rev-parse': 'main\n' }), // status unmapped → null
      }),
    );
    expect(ctx.git).not.toBeNull();
    expect(ctx.git!.onBranch).toBe(true);
    expect(ctx.git!.dirty).toBeNull();
  });
});

// ── project probe ─────────────────────────────────────────────────────────────

describe('gatherLocalContext — project', () => {
  it('testCmdDocumented true on `npm test` in CLAUDE.md', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({
          '/proj/CLAUDE.md': 'Run the suite with `npm test` before committing.',
        }),
      }),
    );
    expect(ctx.project).not.toBeNull();
    expect(ctx.project!.claudeMdPresent).toBe(true);
    expect(ctx.project!.testCmdDocumented).toBe(true);
  });

  it('testCmdDocumented true on `vitest` mention', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({ '/proj/CLAUDE.md': 'We use vitest for unit tests.' }),
      }),
    );
    expect(ctx.project!.testCmdDocumented).toBe(true);
  });

  it('testCmdDocumented NULL (not false) when CLAUDE.md present but no test evidence', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({ '/proj/CLAUDE.md': 'This project does cool things.' }),
      }),
    );
    expect(ctx.project!.claudeMdPresent).toBe(true);
    expect(ctx.project!.testCmdDocumented).toBeNull(); // positive-only.
  });

  it('claudeMdPresent false when CLAUDE.md unreadable', () => {
    const ctx = gatherLocalContext(probeDeps({ readFile: NO_FILES }));
    expect(ctx.project!.claudeMdPresent).toBe(false);
    expect(ctx.project!.testCmdDocumented).toBeNull();
  });

  it('planModeMandated true when CLAUDE.md mandates plan mode', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({
          '/proj/CLAUDE.md': 'You MUST always enter plan mode for any non-trivial task.',
        }),
      }),
    );
    expect(ctx.project!.planModeMandated).toBe(true);
  });

  it('planModeMandated null when plan mode merely mentioned without a mandate', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({ '/proj/CLAUDE.md': 'Plan mode is sometimes useful.' }),
      }),
    );
    expect(ctx.project!.planModeMandated).toBeNull();
  });

  it('hooksConfigured true when .claude/settings.json has a non-empty hooks key', () => {
    const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } });
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({ '/proj/.claude/settings.json': settings }),
      }),
    );
    expect(ctx.project!.hooksConfigured).toBe(true);
  });

  it('hooksConfigured reads the HOME settings.json as a fallback source', () => {
    const settings = JSON.stringify({ hooks: { Stop: [{ command: 'x' }] } });
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({ '/home/dev/.claude/settings.json': settings }),
      }),
    );
    expect(ctx.project!.hooksConfigured).toBe(true);
  });

  it('hooksConfigured null when settings.json has an EMPTY hooks key', () => {
    const settings = JSON.stringify({ hooks: {} });
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: fakeReadFile({ '/proj/.claude/settings.json': settings }),
      }),
    );
    expect(ctx.project!.hooksConfigured).toBeNull();
  });

  it('all-unreadable project files → claudeMdPresent false, the rest null', () => {
    const ctx = gatherLocalContext(probeDeps({ readFile: NO_FILES }));
    expect(ctx.project!.claudeMdPresent).toBe(false);
    expect(ctx.project!.testCmdDocumented).toBeNull();
    expect(ctx.project!.planModeMandated).toBeNull();
    expect(ctx.project!.hooksConfigured).toBeNull();
  });
});

// ── never-throws contract ──────────────────────────────────────────────────────

describe('gatherLocalContext — never throws', () => {
  it('a readFile that THROWS for every path degrades to nulls, never throws', () => {
    const ctx = gatherLocalContext(
      probeDeps({
        readFile: () => {
          throw new Error('fs boom');
        },
        runGit: () => {
          throw new Error('git boom');
        },
      }),
    );
    expect(ctx.activeModel).toBeNull();
    expect(ctx.mode).toBeNull();
    expect(ctx.effort).toBeNull();
    expect(ctx.git).toBeNull();
    expect(ctx.project!.claudeMdPresent).toBe(false);
  });

  it('works with default (real) seams against a non-existent path — no throw, all degraded', () => {
    const ctx = gatherLocalContext({
      transcriptPath: '/definitely/not/a/real/path-xyz.jsonl',
      cwd: '/definitely/not/a/real/dir-xyz',
    });
    expect(ctx.activeModel).toBeNull();
    expect(ctx.git).toBeNull();
    expect(ctx.project!.claudeMdPresent).toBe(false);
  });
});
