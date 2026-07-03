import { describe, it, expect } from 'vitest';
import { matchExternalSkills } from '../src/capability/skill-index-matcher.js';
import { loadSkillIndex, type SkillIndex, type SkillIndexEntry } from '../src/capability/skill-index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function entry(over: Partial<SkillIndexEntry> & { name: string }): SkillIndexEntry {
  return {
    id: `fixture/${over.name.trim().toLowerCase()}`,
    kind: 'skill',
    description: `${over.name} description`,
    keywords: [],
    category: null,
    install: `/plugin install ${over.name.trim()}@fixture`,
    sourceUrl: 'https://github.com/anthropics/skills',
    trust: 'official',
    pinnedSha: null,
    repoStars: 100,
    ...over,
  };
}

function indexOf(entries: readonly SkillIndexEntry[]): SkillIndex {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-01T00:00:00.000Z',
    sources: [],
    entries,
  };
}

const FIXTURE_INDEX = indexOf([
  entry({ name: 'pdf', keywords: ['pdf', 'extraction', 'tables', 'forms'] }),
  entry({ name: 'xlsx', keywords: ['excel', 'spreadsheet', 'xlsx'] }),
  entry({ name: 'webapp-testing', keywords: ['playwright', 'browser', 'testing'], category: 'testing' }),
]);

const NONE: ReadonlySet<string> = new Set();

// ── Tests ────────────────────────────────────────────────────────────────────

describe('matchExternalSkills — the precision wall', () => {
  it('no genuine need → zero candidates (no candidates beats weak candidates)', () => {
    expect(matchExternalSkills('fix the typo in README', FIXTURE_INDEX, NONE)).toEqual([]);
  });

  it('installed wins: an excluded name is dropped despite strong overlap', () => {
    const prompt = 'extract the tables from this pdf report';
    const excluded = new Set(['pdf']);
    expect(matchExternalSkills(prompt, FIXTURE_INDEX, excluded)).toEqual([]);
    // Control: with empty exclusions the same prompt returns pdf.
    const hits = matchExternalSkills(prompt, FIXTURE_INDEX, NONE);
    expect(hits.map((h) => h.name)).toEqual(['pdf']);
    expect(hits[0].install).toContain('/plugin install');
    expect(hits[0].repoStars).toBe(100);
  });

  it('capability-collision drop: an entry shadowing a capability id is excluded', () => {
    const index = indexOf([
      entry({ name: 'code-review', keywords: ['review', 'quality', 'code'] }),
    ]);
    const excluded = new Set(['code-review']);
    expect(matchExternalSkills('run a code review on this diff', index, excluded)).toEqual([]);
  });

  it('floor: a single weak keyword hit (score < 4) → []', () => {
    // 'spreadsheet' hits ONE xlsx keyword (2 points, 1 distinct token) — below the floor.
    expect(matchExternalSkills('open the spreadsheet thing', FIXTURE_INDEX, NONE)).toEqual([]);
  });

  it('k-cap: 8 relevant entries → exactly 5, best-score-first, deterministic id tiebreak', () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry({
        name: `deploy-helper-${i}`,
        id: `fixture/deploy-helper-${i}`,
        keywords: ['deploy', 'kubernetes', 'helm'],
      }),
    );
    const hits = matchExternalSkills('deploy the app to kubernetes with helm', indexOf(entries), NONE);
    expect(hits).toHaveLength(5);
    // Equal scores → id ascending.
    expect(hits.map((h) => h.name)).toEqual([
      'deploy-helper-0',
      'deploy-helper-1',
      'deploy-helper-2',
      'deploy-helper-3',
      'deploy-helper-4',
    ]);
  });

  it('best score first: a name hit outranks keyword-only hits', () => {
    const index = indexOf([
      entry({ name: 'terraform', keywords: ['terraform', 'infrastructure', 'provision'] }),
      // Keyword-only entries need >= 3 concordant hits (score 6) to appear at all.
      entry({ name: 'infra-tools', keywords: ['terraform', 'infrastructure', 'stack'] }),
    ]);
    const hits = matchExternalSkills('provision the terraform infrastructure stack', index, NONE);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].name).toBe('terraform'); // 3-point name hit wins.
  });

  it('fold-normalization: entry "PDF " matches excluded "pdf"', () => {
    const index = indexOf([entry({ name: 'PDF ', keywords: ['pdf', 'extraction', 'tables'] })]);
    const excluded = new Set(['pdf']);
    expect(
      matchExternalSkills('extract the tables from this pdf report', index, excluded),
    ).toEqual([]);
  });

  it('empty/garbage prompt → [], no throw', () => {
    expect(matchExternalSkills('', FIXTURE_INDEX, NONE)).toEqual([]);
    expect(matchExternalSkills('∆∆∆ !!!', FIXTURE_INDEX, NONE)).toEqual([]);
    expect(matchExternalSkills('   ', FIXTURE_INDEX, NONE)).toEqual([]);
  });

  it('an exact full-name match passes the floor even with one token', () => {
    // 'webapp-testing' as a full phrase in the prompt (multi-token entry name).
    const hits = matchExternalSkills(
      'set up webapp-testing for the login flow',
      FIXTURE_INDEX,
      NONE,
    );
    expect(hits.map((h) => h.name)).toContain('webapp-testing');
  });

  it('single-token exact-name bypass is CLOSED: bare generic nouns in prose → []', () => {
    // Mirrors the real index derivation: single-token plugin names whose keywords are
    // just their own name tokens (+ category). Before the fix, the exact-full-name
    // shortcut fired on ANY prompt containing one of these words.
    const genericIndex = indexOf([
      entry({ name: 'data', keywords: ['data', 'development'], category: 'development' }),
      entry({ name: 'remember', keywords: ['remember'] }),
      entry({ name: 'confidence', keywords: ['confidence', 'development'], category: 'development' }),
      entry({ name: 'playground', keywords: ['development', 'playground'], category: 'development' }),
    ]);
    // The three reproduced prompts — all MUST return zero candidates.
    expect(
      matchExternalSkills('remember to update the data model before you fix the bug', genericIndex, NONE),
    ).toEqual([]);
    expect(
      matchExternalSkills('I have low confidence in this fix', genericIndex, NONE),
    ).toEqual([]);
    expect(
      matchExternalSkills('spin up a quick playground so I can test the parser', genericIndex, NONE),
    ).toEqual([]);
  });

  it('the SHIPPED real index: the reproduced prompts return zero candidates', () => {
    const real = loadSkillIndex();
    expect(real).not.toBeNull();
    const repros = [
      'remember to update the data model before you fix the bug',
      'I have low confidence in this fix',
      'spin up a quick playground so I can test the parser',
    ];
    for (const prompt of repros) {
      expect(matchExternalSkills(prompt, real as SkillIndex, NONE)).toEqual([]);
    }
  });

  it('near-token morphology: "pdf extraction" matches a keyword "extracting" (common prefix ≥ 6)', () => {
    const idx = indexOf([entry({ name: 'pdf', keywords: ['pdf', 'extracting', 'tables'] })]);
    expect(matchExternalSkills('pdf extraction', idx, NONE).map((h) => h.name)).toEqual(['pdf']);
  });

  it('near-token guard: short overlaps never near-match (plan≠plane, data≠database)', () => {
    const idx = indexOf([
      entry({ name: 'data', keywords: ['plane', 'database'] }),
    ]);
    // 'plan the data flow': name hit 'data' (3) + no near-match from plan→plane
    // (common prefix 4 < 6) or data→database (4 < 6) → below floor.
    expect(matchExternalSkills('plan the data flow', idx, NONE)).toEqual([]);
  });

  it('keyword-only floor: two keyword hits (score 4) without a name hit stay silent; three fire', () => {
    const idx = indexOf([entry({ name: 'xlsx', keywords: ['spreadsheet', 'charts', 'formulas'] })]);
    // Two keyword hits, no name token in the prompt → score 4 but keyword-only → silent.
    expect(matchExternalSkills('build the charts from this spreadsheet', idx, NONE)).toEqual([]);
    // Three keyword hits (score 6) → genuine multi-signal corroboration → fires.
    expect(
      matchExternalSkills('spreadsheet charts and formulas please', idx, NONE).map((h) => h.name),
    ).toEqual(['xlsx']);
  });

  it('the SHIPPED real index: "pdf extraction" reaches the pdf skill (regression pin)', () => {
    const real = loadSkillIndex();
    expect(real).not.toBeNull();
    const hits = matchExternalSkills('pdf extraction', real as SkillIndex, NONE);
    expect(hits.map((h) => h.name)).toContain('pdf');
  });

  it('legit single-token case: name hit + keyword corroboration still matches', () => {
    // A single-token name never fires on the name alone, but a corroborating keyword
    // (2 distinct tokens, score 3+2=5 ≥ 4) clears the normal floor.
    const idx = indexOf([entry({ name: 'pdf', keywords: ['pdf', 'text', 'extraction', 'forms'] })]);
    const hits = matchExternalSkills('extract text from this pdf report', idx, NONE);
    expect(hits.map((h) => h.name)).toEqual(['pdf']);
  });

  it('single-token name with NO corroboration → [] even as an exact word in the prompt', () => {
    const idx = indexOf([entry({ name: 'pdf', keywords: ['pdf'] })]);
    expect(matchExternalSkills('please open the pdf now', idx, NONE)).toEqual([]);
  });

  it('multi-token (≥ 2 tokens) exact full-name shortcut still applies', () => {
    const hits = matchExternalSkills(
      'set up webapp-testing for the login flow',
      FIXTURE_INDEX,
      NONE,
    );
    expect(hits.map((h) => h.name)).toContain('webapp-testing');
  });

  it('k parameter is clamped to 5 (the judge never sees more)', () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry({
        name: `deploy-helper-${i}`,
        id: `fixture/deploy-helper-${i}`,
        keywords: ['deploy', 'kubernetes'],
      }),
    );
    const hits = matchExternalSkills(
      'deploy the app to kubernetes now',
      indexOf(entries),
      NONE,
      99,
    );
    expect(hits.length).toBeLessThanOrEqual(5);
  });
});

// ── G-M4b: community trust floor (+2) + official-wins tiebreak ────────────────

describe('matchExternalSkills — community trust floor + tiebreak (G-M4b)', () => {
  it('a community entry at name-hit score 5 stays SILENT while the identical official entry fires', () => {
    const officialIdx = indexOf([
      entry({ name: 'pdf', keywords: ['extraction'], trust: 'official' }),
    ]);
    const communityIdx = indexOf([
      entry({ name: 'pdf', keywords: ['extraction'], trust: 'community' }),
    ]);
    // "pdf extraction" → name hit (3) + keyword (2) = 5, distinct 2.
    expect(matchExternalSkills('pdf extraction', officialIdx, NONE)).toHaveLength(1);
    expect(matchExternalSkills('pdf extraction', communityIdx, NONE)).toHaveLength(0);
  });

  it('a community entry clears the raised floor with more corroboration (score ≥ 6 with a name hit)', () => {
    const communityIdx = indexOf([
      entry({ name: 'pdf', keywords: ['extraction', 'tables'], trust: 'community' }),
    ]);
    // name (3) + keyword (2) + keyword (2) = 7 ≥ 6 → fires.
    expect(matchExternalSkills('pdf extraction tables', communityIdx, NONE)).toHaveLength(1);
  });

  it('keyword-only community floor is 8: three keyword hits (6) silent, four (8) fire', () => {
    const three = indexOf([
      entry({ name: 'zzz', keywords: ['alpha', 'beta', 'gamma'], trust: 'community' }),
    ]);
    const four = indexOf([
      entry({ name: 'zzz', keywords: ['alpha', 'beta', 'gamma', 'delta'], trust: 'community' }),
    ]);
    expect(matchExternalSkills('alpha beta gamma', three, NONE)).toHaveLength(0);
    expect(matchExternalSkills('alpha beta gamma delta', four, NONE)).toHaveLength(1);
  });

  it('equal score → official sorts BEFORE community regardless of id order', () => {
    const idx = indexOf([
      { ...entry({ name: 'pdf-tool', keywords: ['extraction', 'tables', 'forms'] }), id: 'a-community', trust: 'community' },
      { ...entry({ name: 'pdf-tool', keywords: ['extraction', 'tables', 'forms'] }), id: 'z-official', trust: 'official' },
    ]);
    const hits = matchExternalSkills('pdf tool extraction tables forms', idx, NONE);
    expect(hits.length).toBe(2);
    expect(hits[0].trust).toBe('official');
    expect(hits[1].trust).toBe('community');
  });

  it('returned candidates expose trust', () => {
    const hits = matchExternalSkills('pdf extraction', FIXTURE_INDEX, NONE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].trust).toBe('official');
  });

  it('the community exact-name shortcut applies ONLY user-initiated (adversarial fix superseded the old typed-name=intent pin)', () => {
    const idx = indexOf([entry({ name: 'webapp-testing', trust: 'community' })]);
    // JUDGE path: attacker-chosen phrase names must not fire on prose.
    expect(matchExternalSkills('set up webapp testing for me', idx, NONE)).toEqual([]);
    // /coach find: the user typed it — intent holds.
    const hits = matchExternalSkills('set up webapp testing for me', idx, NONE, undefined, {
      userInitiated: true,
    });
    expect(hits).toHaveLength(1);
  });
});

describe('community strict floors on the JUDGE path; relaxed for user-initiated find (M4b adversarial fix)', () => {
  const proseIdx = () =>
    indexOf([entry({ name: 'review-helper', trust: 'community', keywords: ['review', 'helper'] })]);

  it('JUDGE path: a community multi-token name reading as ordinary prose never fires', () => {
    // "review helper" appears verbatim AND both name tokens hit (score 6 = surcharged
    // floor) — but unprompted community needs a 3rd distinct signal. Silence.
    expect(matchExternalSkills('can you review helper functions in utils', proseIdx(), NONE)).toEqual([]);
  });

  it('JUDGE path: the same exact name still fires for an OFFICIAL entry', () => {
    const idx = indexOf([entry({ name: 'review-helper', trust: 'official', keywords: ['review', 'helper'] })]);
    expect(
      matchExternalSkills('can you review helper functions in utils', idx, NONE).map((h) => h.name),
    ).toEqual(['review-helper']);
  });

  it('JUDGE path: a community entry fires with a 3rd distinct corroborating signal', () => {
    const idx = indexOf([
      entry({
        name: 'yaml-master',
        trust: 'community',
        keywords: ['yaml', 'master', 'schema', 'lint', 'validate'],
      }),
    ]);
    const hits = matchExternalSkills('yaml master to lint and validate the schema', idx, NONE);
    expect(hits.map((h) => h.name)).toEqual(['yaml-master']);
  });

  it('user-initiated find: a typed query IS intent — community keeps the official floors', () => {
    const hits = matchExternalSkills(
      'review helper',
      proseIdx(),
      NONE,
      undefined,
      { userInitiated: true },
    );
    expect(hits.map((h) => h.name)).toEqual(['review-helper']);
  });
});
