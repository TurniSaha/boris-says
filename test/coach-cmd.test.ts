import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, defaultState, type Store } from '../src/state/store.js';
import { createPatternsStore, type PatternsStore, type Pattern, type PatternDraft } from '../src/habit/patterns-store.js';
import { runCoachCmd, resolveBackendName, type CoachCmdDeps } from '../src/coach-cmd.js';

let baseDir: string;
let home: string;
let store: Store;
let patterns: PatternsStore;
let lines: string[];

function makeDeps(partial: Partial<CoachCmdDeps> = {}): CoachCmdDeps {
  return {
    store,
    patterns,
    // PROMPT_COACH_DIR pins the default draft-writer's drafts dir to the tmp baseDir.
    env: { PROMPT_COACH_DIR: baseDir },
    now: 1_000_000,
    claudeOnPath: () => false,
    out: (l) => lines.push(l),
    homeDir: home,
    ...partial,
  };
}

function makePattern(key: string): Pattern {
  return {
    habit_key: key,
    trigger: `prompt_recurring:${key}`,
    match_phrases: ['a', 'b', 'c'],
    habit: 'asks for X',
    fix: 'do Y',
    why_inefficient: 'wastes a turn',
    occurrences: [
      { sessionId: 's1', ts: 1, evidence: 'e' },
      { sessionId: 's2', ts: 2, evidence: 'e' },
      { sessionId: 's3', ts: 3, evidence: 'e' },
    ],
    occurrenceCount: 3,
    confidence: 0.8,
    status: 'surfaced',
    createdAt: 1,
    surfacedAt: 2,
  };
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-cmd-'));
  home = mkdtempSync(join(tmpdir(), 'coach-cmd-home-'));
  store = createStore(baseDir);
  patterns = createPatternsStore(baseDir);
  lines = [];
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('runCoachCmd off/on', () => {
  it('off sets enabled false', () => {
    runCoachCmd('off', makeDeps());
    expect(store.getState().enabled).toBe(false);
    expect(lines.join('\n')).toMatch(/off/i);
  });

  it('on sets enabled true (after off)', () => {
    runCoachCmd('off', makeDeps());
    runCoachCmd('on', makeDeps());
    expect(store.getState().enabled).toBe(true);
    expect(lines.join('\n')).toMatch(/on/i);
  });

  it('is case/space insensitive on the subcommand', () => {
    runCoachCmd('  OFF  ', makeDeps());
    expect(store.getState().enabled).toBe(false);
  });
});

describe('runCoachCmd status', () => {
  it('prints enabled, backend, and pattern count', () => {
    patterns.upsertPatterns([makePattern('k:1'), makePattern('k:2')]);
    runCoachCmd('status', makeDeps({ claudeOnPath: () => true }));
    const text = lines.join('\n');
    expect(text).toMatch(/enabled=true/);
    expect(text).toMatch(/backend: cli/);
    expect(text).toMatch(/discovered patterns: 2/);
    expect(text).toMatch(/quality cooldown:/);
    expect(text).toMatch(/habit cooldown:/);
    expect(text).toMatch(/last tip:/);
  });

  it('reports api-metered backend when opted in with a key', () => {
    runCoachCmd(
      'status',
      makeDeps({ env: { PROMPT_COACH_USE_API: '1', ANTHROPIC_API_KEY: 'sk-x' } }),
    );
    expect(lines.join('\n')).toMatch(/backend: api-metered \(metered API billing active\)/);
  });

  it('reports a friendly "none" backend when no API opt-in and claude not on PATH', () => {
    runCoachCmd('status', makeDeps({ claudeOnPath: () => false }));
    // The human status line must NOT print the bare internal `null` token.
    expect(lines.join('\n')).not.toMatch(/backend: null\b/);
    expect(lines.join('\n')).toMatch(/backend: none \(claude CLI not found and no API key — coaching paused\)/);
  });

  it('reports cooldown remaining when a quality tip was recent', () => {
    store.markQualityTip(1_000_000);
    runCoachCmd('status', makeDeps({ now: 1_000_000 + 60_000 }));
    expect(lines.join('\n')).toMatch(/quality cooldown: \d+m \d+s left/);
  });
});

describe('runCoachCmd dismiss', () => {
  it('marks the lastSurfacedPatternKey pattern dismissed', () => {
    patterns.upsertPatterns([makePattern('context-handoff:next')]);
    store.markHabitNudge(Date.now(), 'context-handoff:next');
    runCoachCmd('dismiss', makeDeps());
    const p = patterns.readPatterns().find((x) => x.habit_key === 'context-handoff:next');
    expect(p?.status).toBe('dismissed');
    expect(lines.join('\n')).toMatch(/dismissed/);
  });

  it('is a no-op when no pattern was surfaced', () => {
    patterns.upsertPatterns([makePattern('k:1')]);
    runCoachCmd('dismiss', makeDeps());
    expect(patterns.readPatterns()[0].status).toBe('surfaced');
    expect(lines.join('\n')).toMatch(/nothing to dismiss/i);
  });
});

describe('runCoachCmd build (M3 — writes REVIEW files, never activates)', () => {
  const KEY = 'context-handoff:next-session-prompt';

  function mkDraft(over: Partial<PatternDraft> = {}): PatternDraft {
    return {
      kind: 'skill',
      name: 'context-handoff',
      content: '---\nname: context-handoff\ndescription: d\n---\nbody\n',
      createdAt: 1,
      ...over,
    };
  }

  function seed(draft: PatternDraft | undefined, surfaced = true): void {
    const p: Pattern = { ...makePattern(KEY), ...(draft ? { draft } : {}) };
    patterns.upsertPatterns([p]);
    if (surfaced) store.markHabitNudge(999, KEY);
  }

  it('no surfaced key and no arg → safe message-only no-op, writes nothing', () => {
    expect(() => runCoachCmd('build', makeDeps())).not.toThrow();
    expect(lines.join('\n')).toMatch(/nothing to build/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('a dismissed pattern → refuses, writes nothing (dismiss-then-build race)', () => {
    seed(mkDraft());
    patterns.markDismissed(KEY);
    runCoachCmd('build', makeDeps());
    expect(lines.join('\n')).toMatch(/dismissed/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('a surfaced draft-less pattern → "no draft" no-op', () => {
    seed(undefined);
    runCoachCmd('build', makeDeps());
    expect(lines.join('\n')).toMatch(/no draft/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('a skill draft → SKILL.md.draft under the tmp home, byte-equal content, mv instruction + key named', () => {
    seed(mkDraft());
    runCoachCmd('build', makeDeps());
    const path = join(home, '.claude', 'skills', 'context-handoff', 'SKILL.md.draft');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(mkDraft().content);
    const text = lines.join('\n');
    expect(text).toContain(path);
    expect(text).toContain(`mv '${path}'`);
    expect(text).toContain(KEY);
  });

  it('build twice → second run says already written, content untouched (idempotent)', () => {
    seed(mkDraft());
    runCoachCmd('build', makeDeps());
    lines = [];
    runCoachCmd('build', makeDeps());
    expect(lines.join('\n')).toMatch(/already written/i);
    const path = join(home, '.claude', 'skills', 'context-handoff', 'SKILL.md.draft');
    expect(readFileSync(path, 'utf8')).toBe(mkDraft().content);
  });

  it('an explicit habit_key arg overrides lastSurfacedPatternKey', () => {
    const other: Pattern = { ...makePattern('other:habit'), draft: mkDraft({ name: 'other-skill' }) };
    patterns.upsertPatterns([other]);
    seed(mkDraft()); // sets lastSurfacedPatternKey = KEY
    runCoachCmd('build', makeDeps(), 'other:habit');
    expect(existsSync(join(home, '.claude', 'skills', 'other-skill', 'SKILL.md.draft'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'context-handoff', 'SKILL.md.draft'))).toBe(false);
  });

  it('a stale/unknown habit_key arg → safe no-op', () => {
    seed(mkDraft());
    runCoachCmd('build', makeDeps(), 'gone:key');
    expect(lines.join('\n')).toMatch(/unknown habit/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('a hook draft → script under drafts/, output says the coach never edits settings, and NO settings.json appears', () => {
    seed(mkDraft({ kind: 'hook', name: 'handoff-hook', content: '#!/bin/sh\n# snippet: {...}\ntrue\n' }));
    runCoachCmd('build', makeDeps());
    const path = join(baseDir, 'drafts', 'hook-context-handoff_next-session-prompt.sh');
    expect(existsSync(path)).toBe(true);
    expect(lines.join('\n')).toContain('never edits settings');
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('status shows drafts pending with the key', () => {
    seed(mkDraft(), false);
    runCoachCmd('status', makeDeps());
    expect(lines.join('\n')).toMatch(/drafts pending: 1 \(context-handoff:next-session-prompt\)/);
  });

  it('status counts only NON-dismissed draft-bearing patterns', () => {
    seed(mkDraft(), false);
    patterns.markDismissed(KEY);
    runCoachCmd('status', makeDeps());
    expect(lines.join('\n')).not.toMatch(/drafts pending/);
  });
});

describe('runCoachCmd robustness', () => {
  it('prints usage on unknown/empty subcommand and never throws', () => {
    expect(() => runCoachCmd(undefined, makeDeps())).not.toThrow();
    expect(() => runCoachCmd('bogus', makeDeps())).not.toThrow();
    expect(lines.join('\n')).toMatch(/usage/i);
  });

  it('never throws on a fresh tmpdir with no files present', () => {
    expect(() => runCoachCmd('status', makeDeps())).not.toThrow();
    expect(() => runCoachCmd('dismiss', makeDeps())).not.toThrow();
    expect(() => runCoachCmd('off', makeDeps())).not.toThrow();
  });
});

describe('runCoachCmd find + status external-index (M4)', () => {
  function fixtureIndex(entryCount = 2, generatedAt = '2026-07-02T10:00:00.000Z') {
    const entries = [
      {
        id: 'anthropic-skills/pdf',
        name: 'pdf',
        kind: 'skill',
        description: 'PDF manipulation toolkit for extraction and forms',
        keywords: ['pdf', 'extraction', 'tables'],
        category: null,
        install: '/plugin install document-skills@anthropic-agent-skills',
        sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
        trust: 'official',
        pinnedSha: null,
        repoStars: 157657,
      },
      {
        id: 'official-marketplace/pdf-extractor',
        name: 'pdf-extractor',
        kind: 'plugin',
        description: 'Extracts structured data from PDFs',
        keywords: ['pdf', 'extraction'],
        category: 'productivity',
        install: '/plugin install pdf-extractor@claude-plugins-official',
        sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
        trust: 'official',
        pinnedSha: null,
        repoStars: 31449,
      },
    ].slice(0, entryCount);
    // Pad to entryCount with filler entries when more are requested.
    while (entries.length < entryCount) {
      const i = entries.length;
      entries.push({
        id: `official-marketplace/filler-${i}`,
        name: `filler-${i}`,
        kind: 'plugin',
        description: 'filler',
        keywords: [],
        category: null,
        install: `/plugin install filler-${i}@claude-plugins-official`,
        sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
        trust: 'official',
        pinnedSha: null,
        repoStars: null,
      });
    }
    return { schemaVersion: 1 as const, generatedAt, sources: [], entries };
  }

  it('find with empty query → usage line, nothing else, no throw', () => {
    expect(() =>
      runCoachCmd('find', makeDeps({ loadSkillIndex: () => fixtureIndex() }), ''),
    ).not.toThrow();
    expect(lines).toEqual(['usage: /coach find <query>']);
  });

  it('find with a garbage query → friendly no-match line, no throw', () => {
    expect(() =>
      runCoachCmd('find', makeDeps({ loadSkillIndex: () => fixtureIndex() }), '∆∆∆'),
    ).not.toThrow();
    expect(lines.join('\n')).toContain('coach: no matching external skills for "∆∆∆"');
  });

  it('find with a multi-word query → blocks with name, description, review + install lines', () => {
    runCoachCmd(
      'find',
      makeDeps({ loadSkillIndex: () => fixtureIndex(), installedSkillIds: () => [] }),
      'pdf extraction',
    );
    const text = lines.join('\n');
    expect(text).toContain('pdf');
    expect(text).toContain('PDF manipulation toolkit');
    expect(text).toContain('review: https://github.com/anthropics/skills/tree/main/skills/pdf');
    expect(text).toContain('install: /plugin install document-skills@anthropic-agent-skills');
    expect(text).toContain('★ 157657');
    // Never more than 5 result blocks.
    expect(lines.filter((l) => l.startsWith('  install: ')).length).toBeLessThanOrEqual(5);
  });

  it('find excludes INSTALLED skill ids (installed-catalog-wins) but keeps the rest', () => {
    runCoachCmd(
      'find',
      makeDeps({
        loadSkillIndex: () => fixtureIndex(),
        installedSkillIds: () => ['pdf'], // the dev already has pdf.
      }),
      'pdf extraction',
    );
    const text = lines.join('\n');
    expect(text).not.toContain('install: /plugin install document-skills@anthropic-agent-skills');
    expect(text).toContain('pdf-extractor'); // the non-installed match still shows.
  });

  it('find with a missing index → friendly not-available line', () => {
    runCoachCmd('find', makeDeps({ loadSkillIndex: () => null }), 'pdf extraction');
    expect(lines.join('\n')).toContain(
      'coach: external skill index not available (reinstall the plugin to restore it)',
    );
  });

  it('status shows the external index line split by trust (G-M4b)', () => {
    runCoachCmd('status', makeDeps({ loadSkillIndex: () => fixtureIndex(272) }));
    expect(lines.join('\n')).toContain(
      'external index: 272 entries (272 official, 0 community), refreshed 2026-07-02',
    );
    // Injected via the plain loader → provenance unknown → never labeled runtime.
    expect(lines.join('\n')).not.toContain('(runtime copy)');
  });

  it('status shows not-available when the index is missing', () => {
    runCoachCmd('status', makeDeps({ loadSkillIndex: () => null }));
    expect(lines.join('\n')).toContain('external index: not available');
  });

  it('installedSkillIds throwing degrades to no exclusions (never throws)', () => {
    expect(() =>
      runCoachCmd(
        'find',
        makeDeps({
          loadSkillIndex: () => fixtureIndex(),
          installedSkillIds: () => {
            throw new Error('scan boom');
          },
        }),
        'pdf extraction',
      ),
    ).not.toThrow();
    expect(lines.join('\n')).toContain('pdf'); // results still print.
  });

  it('find printing sanitizes control chars / ANSI escapes (defense-in-depth)', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const dirtyIndex = {
      schemaVersion: 1 as const,
      generatedAt: '2026-07-02T10:00:00.000Z',
      sources: [],
      entries: [
        {
          id: 'x/evil',
          name: 'pdf-tools',
          kind: 'plugin',
          description: `PDF extraction${ESC}[2J and${BEL} forms`,
          keywords: ['pdf', 'extraction'],
          category: null,
          install: `/plugin install pdf-tools@m${ESC}[8m`,
          sourceUrl: `https://example.com/${BEL}evil`,
          trust: 'official',
          pinnedSha: null,
          repoStars: 10,
        },
      ],
    };
    runCoachCmd(
      'find',
      makeDeps({ loadSkillIndex: () => dirtyIndex, installedSkillIds: () => [] }),
      'pdf extraction',
    );
    const text = lines.join('\n');
    expect(text).toContain('pdf-tools');
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BEL);
    expect(text).not.toContain('[2J'); // the CSI payload goes with the ESC.
    expect(text).not.toContain('[8m');
  });
});

describe('runCoachCmd status — M5 watch-first critique mode', () => {
  const stateFile = () => join(baseDir, 'state.json');

  it('an OPEN window shows watching progress + the withheld peek (last 3)', () => {
    store.saveState({
      ...defaultState(),
      watch: {
        sessionsObserved: ['a', 'b'],
        promptsObserved: 12,
        closedAt: null,
        announced: false,
        withheldCount: 5,
        withheld: [
          { lever: 'goal_clarity', tip: 'tip one', prompt: 'p1', at: 1 },
          { lever: 'process_fit', tip: 'tip two', prompt: 'p2', at: 2 },
          { lever: 'risk_awareness', tip: 'tip three', prompt: 'p3', at: 3 },
          { lever: 'verification_path', tip: 'tip four', prompt: 'p4', at: 4 },
        ],
      },
    });
    runCoachCmd('status', makeDeps());
    const text = lines.join('\n');
    expect(text).toContain(
      'critique mode: watching (12/30 prompts, 2/3 sessions) — opportunity tips active, critiques observing',
    );
    expect(text).toContain('withheld critiques: 5 total; last 3:');
    expect(text).toContain('process_fit: "tip two"');
    expect(text).toContain('verification_path: "tip four"');
    expect(text).not.toContain('goal_clarity: "tip one"'); // only the last 3 print.
  });

  it('a CLOSED (watched) window shows on + the close date', () => {
    store.saveState({
      ...defaultState(),
      watch: {
        sessionsObserved: ['a', 'b', 'c'],
        promptsObserved: 30,
        closedAt: Date.UTC(2026, 5, 30),
        announced: true,
        withheldCount: 0,
        withheld: [],
      },
    });
    runCoachCmd('status', makeDeps());
    expect(lines.join('\n')).toContain('critique mode: on (window closed 2026-06-30)');
  });

  it('a legacy engaged install (null watch) shows the pre-existing-install line', () => {
    store.saveState({
      ...defaultState(),
      greetedSessions: ['old-sess'],
      feedbackByLever: { process_fit: { good: 2, bad: 1 } },
    });
    runCoachCmd('status', makeDeps());
    expect(lines.join('\n')).toContain(
      'critique mode: on (pre-existing install — watch window skipped)',
    );
  });

  it('a fresh install (no state at all) shows 0/30 watching and never creates/mutates state', () => {
    expect(existsSync(stateFile())).toBe(false);
    runCoachCmd('status', makeDeps());
    expect(lines.join('\n')).toContain('critique mode: watching (0/30 prompts, 0/3 sessions)');
    expect(existsSync(stateFile())).toBe(false); // status is read-only.
  });

  it('status never mutates persisted state (byte-identical file)', () => {
    store.saveState({ ...defaultState(), greetedSessions: ['s1'] });
    const before = readFileSync(stateFile(), 'utf8');
    runCoachCmd('status', makeDeps());
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
  });
});

describe('coach-cmd cwd invariant (M4 find-exclusion scoping)', () => {
  it('the header scopes the cwd exception: state/index never cwd-relative, find scan may include cwd', () => {
    const src = readFileSync(new URL('../src/coach-cmd.ts', import.meta.url), 'utf8');
    const header = src.slice(0, src.indexOf('import '));
    // The honest invariant: state/index resolution is NEVER cwd-relative...
    expect(header).toMatch(/[Ss]tate\/index resolution is never cwd-relative/);
    // ...and the ONE documented exception is the find exclusion scan.
    expect(header).toMatch(/`?find`? exclusion scan may best-effort include cwd/);
    // The blanket claim the code violated must be gone.
    expect(header).not.toContain('No cwd-relative paths.');
    // process.cwd() appears ONLY inside defaultInstalledSkillIds (the documented exception).
    const uses = src.split('process.cwd()').length - 1;
    expect(uses).toBe(1);
    const fnStart = src.indexOf('function defaultInstalledSkillIds');
    const fnEnd = src.indexOf('\n}', fnStart);
    const cwdAt = src.indexOf('process.cwd()');
    expect(cwdAt).toBeGreaterThan(fnStart);
    expect(cwdAt).toBeLessThan(fnEnd);
  });
});

describe('main argv threading (M4)', () => {
  async function captureMain(argv: string[]): Promise<string> {
    const { main } = await import('../src/coach-cmd.js');
    const written: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };
    try {
      main(['node', 'coach-cmd.js', ...argv], { PROMPT_COACH_DIR: baseDir });
    } finally {
      (process.stdout as any).write = orig;
    }
    return written.join('');
  }

  it('find joins argv[3..] into ONE query string', async () => {
    // An unmatched query proves the join: the echo shows both words.
    const out = await captureMain(['find', 'zzqx', 'yyqx']);
    expect(out).toContain('"zzqx yyqx"');
  });

  it('build still receives its single key unchanged', async () => {
    const out = await captureMain(['build', 'some-unknown-key']);
    expect(out).toContain('coach: unknown habit "some-unknown-key" (nothing built)');
  });

  // ARGUMENTS HARDENING: the bang-line single-quotes '$ARGUMENTS', so the whole thing
  // arrives as ONE space-joined argv element. main() must split it into subcommand + extra.
  it('splits a single space-joined argv element into subcommand + extra (find case)', async () => {
    // Unmatchable tokens prove the join+split: the echoed query shows both words.
    const out = await captureMain(['find zzqx yyqx']);
    expect(out).toContain('"zzqx yyqx"');
  });

  it('splits a single space-joined argv element for a single-token subcommand (build case)', async () => {
    const out = await captureMain(['build some-unknown-key']);
    expect(out).toContain('coach: unknown habit "some-unknown-key" (nothing built)');
  });

  it('a bare single-token argv element (no extra) still routes to its subcommand', async () => {
    const out = await captureMain(['status']);
    // status always prints its header line — proves the bare token routed.
    expect(out.toLowerCase()).toContain('coach');
  });

  it('collapses internal whitespace runs when splitting the joined element', async () => {
    const out = await captureMain(['find   zzqx   yyqx']);
    expect(out).toContain('"zzqx yyqx"');
  });
});

describe('resolveBackendName precedence (§6.3)', () => {
  it('api-metered only when opt-in AND key set', () => {
    expect(resolveBackendName({ PROMPT_COACH_USE_API: '1', ANTHROPIC_API_KEY: 'k' }, () => true)).toBe(
      'api-metered',
    );
    expect(resolveBackendName({ PROMPT_COACH_USE_API: '1' }, () => true)).toBe('cli');
    expect(resolveBackendName({ ANTHROPIC_API_KEY: 'k' }, () => true)).toBe('cli');
  });

  it('cli when claude on PATH and no API opt-in', () => {
    expect(resolveBackendName({}, () => true)).toBe('cli');
  });

  it('null when no API opt-in and claude not on PATH', () => {
    expect(resolveBackendName({}, () => false)).toBe('null');
  });
});


// ── G-M4b: trust labels in find + the status auto-refresh lines ───────────────

describe('runCoachCmd find/status — community trust surfacing (G-M4b)', () => {
  function mixedIndex(generatedAt = '2026-07-02T10:00:00.000Z') {
    return {
      schemaVersion: 1 as const,
      generatedAt,
      sources: [],
      entries: [
        {
          id: 'anthropic-skills/pdf',
          name: 'pdf',
          kind: 'skill',
          description: 'PDF manipulation toolkit for extraction and forms',
          keywords: ['pdf', 'extraction'],
          category: null,
          install: '/plugin install document-skills@anthropic-agent-skills',
          sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
          trust: 'official',
          pinnedSha: null,
          repoStars: 157657,
        },
        {
          id: 'community-marketplace/pdf-extraction-helper',
          name: 'pdf-extraction-helper',
          kind: 'plugin',
          description: 'Community helper that extracts structured data from PDFs',
          keywords: ['pdf', 'extraction'],
          category: 'productivity',
          install: '/plugin install pdf-extraction-helper@claude-code-plugins-plus',
          sourceUrl: 'https://github.com/jeremylongshore/claude-code-plugins-plus-skills',
          trust: 'community',
          pinnedSha: null,
          repoStars: 2467,
        },
      ],
    };
  }

  it('find labels BOTH trusts on the review line', () => {
    runCoachCmd(
      'find',
      makeDeps({ loadSkillIndex: () => mixedIndex(), installedSkillIds: () => [] }),
      'pdf extraction',
    );
    const text = lines.join('\n');
    // (Official-before-community at EQUAL score is pinned in the matcher suite; here the
    // community entry legitimately outscores on a double name hit — both must be labeled.)
    expect(text).toContain('(official · ★ 157657)');
    expect(text).toContain('(community · ★ 2467)');
  });

  it('find prints a community desc with control chars SANITIZED', () => {
    const idx = mixedIndex();
    const evil = {
      ...idx,
      entries: [
        {
          ...idx.entries[1],
          description: 'extracts' + String.fromCharCode(27) + '[2J structured pdf extraction data',
        },
      ],
    };
    runCoachCmd(
      'find',
      makeDeps({ loadSkillIndex: () => evil, installedSkillIds: () => [] }),
      'pdf extraction helper',
    );
    const text = lines.join('\n');
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text).not.toContain('[2J');
  });

  it('status splits the counts by trust', () => {
    runCoachCmd('status', makeDeps({ loadSkillIndex: () => mixedIndex() }));
    expect(lines.join('\n')).toContain(
      'external index: 2 entries (1 official, 1 community), refreshed 2026-07-02',
    );
  });

  it('status labels the runtime copy when the prefer-runtime loader chose it', () => {
    runCoachCmd(
      'status',
      makeDeps({
        loadSkillIndexWithProvenance: () => ({ index: mixedIndex(), source: 'runtime' as const }),
      }),
    );
    expect(lines.join('\n')).toContain(
      'external index: 2 entries (1 official, 1 community), refreshed 2026-07-02 (runtime copy)',
    );
  });

  it('status shows the auto-refresh line: on + never on a fresh state', () => {
    runCoachCmd('status', makeDeps({ loadSkillIndex: () => null }));
    expect(lines.join('\n')).toContain('index auto-refresh: on, last attempt never');
  });

  it('status shows the last attempt date once one is recorded', () => {
    store.saveState({ ...store.getState(), lastIndexRefreshAt: Date.parse('2026-07-01T00:00:00.000Z') });
    runCoachCmd('status', makeDeps({ loadSkillIndex: () => null }));
    expect(lines.join('\n')).toContain(
      'index auto-refresh: on, last attempt 2026-07-01T00:00:00.000Z',
    );
  });

  it('status shows off + the kill-switch name when disabled', () => {
    runCoachCmd(
      'status',
      makeDeps({
        loadSkillIndex: () => null,
        env: { PROMPT_COACH_DIR: baseDir, PROMPT_COACH_NO_INDEX_REFRESH: '1' },
      }),
    );
    expect(lines.join('\n')).toContain('index auto-refresh: off (PROMPT_COACH_NO_INDEX_REFRESH)');
  });
});
