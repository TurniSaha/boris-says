/**
 * src/capability/skill-index-matcher.ts — M4 external-skill PRE-MATCHER (the precision
 * wall). PURE: no LLM, no fs, no clock. Deterministic for a given (prompt, index).
 *
 * The full index NEVER rides the judge prompt: this narrows it to AT MOST `k` (≤ 5)
 * one-line candidates, floor-gated — below the floor it returns `[]`, because no
 * candidates beats weak candidates (precision over recall).
 *
 * INSTALLED-CATALOG-WINS happens HERE, at match time: the caller passes
 * `excludedNames` = the fold of every installed/curated skill id PLUS every capability
 * id/trigger, so an external entry that shadows something the dev already has (or a
 * real capability like `code-review`) is dropped before the judge ever sees it — which
 * also pre-empts the §5.5.5f backtick fail-closed landmine.
 */
import type { ExternalCandidate, SkillIndex } from './skill-index.js';

/** Default + hard maximum candidates surfaced to the judge. */
const MAX_CANDIDATES = 5;

/** Score weights: a name hit is the strongest signal, then keyword, then category. */
const NAME_WEIGHT = 3;
const KEYWORD_WEIGHT = 2;
const CATEGORY_WEIGHT = 1;

/** Firing floor: total score ≥ 4 AND ≥ 2 distinct matching tokens (or an exact MULTI-token name). */
const SCORE_FLOOR = 4;
const DISTINCT_FLOOR = 2;

/**
 * G-M4b: NON-official (community) entries pay a +2 floor surcharge on BOTH floors —
 * the upstream catalog is largely bulk AI-generated with broad keyword lists, so its
 * keyword noise is structurally higher than the official set's. The multi-token
 * exactNameMatch shortcut still applies (names are shape-validated + deduped vs
 * official, so an exact typed name is unambiguous intent).
 */
export const COMMUNITY_FLOOR_BONUS = 2;

/**
 * Keyword-only matches (no name-token hit) need MORE corroboration: description-derived
 * keywords are broad, so two incidental hits ("data model" → xlsx) must stay silent while
 * three concordant signals may fire.
 */
const KEYWORD_ONLY_SCORE_FLOOR = 6;

/**
 * Near-token match: equal, or sharing a common prefix ≥ 6 chars — catches morphology
 * ("extraction"/"extracting") without letting short overlaps collide (plan≠plane,
 * data≠database, both prefix 4).
 */
const NEAR_PREFIX_MIN = 6;

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function nearMatch(a: string, b: string): boolean {
  return a === b || commonPrefixLen(a, b) >= NEAR_PREFIX_MIN;
}

function hasNearMatch(token: string, pool: readonly string[]): boolean {
  for (const p of pool) if (nearMatch(token, p)) return true;
  return false;
}

/** Minimal English stopword set — enough to kill glue-word noise, never load-bearing. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'into',
  'onto', 'over', 'under', 'about', 'after', 'before', 'then', 'than', 'them',
  'they', 'their', 'there', 'here', 'have', 'has', 'had', 'was', 'were', 'are',
  'been', 'being', 'will', 'would', 'should', 'could', 'can', 'may', 'might',
  'you', 'your', 'our', 'its', 'his', 'her', 'him', 'she', 'who', 'what', 'when',
  'where', 'why', 'how', 'all', 'any', 'each', 'not', 'now', 'out', 'off', 'per',
  'via', 'just', 'also', 'some', 'more', 'most', 'other', 'such', 'only', 'own',
  'same', 'too', 'very', 'but', 'nor', 'yet', 'does', 'did', 'doing', 'make',
  'want', 'need', 'please', 'use', 'using', 'get', 'add', 'new', 'one', 'two',
]);

const fold = (s: string): string => s.trim().toLowerCase();

/** Fold-tokenize: lowercase, split on non-alnum, drop stopwords + tokens < 3 chars. */
function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Normalize a phrase for whole-name containment ('webapp-testing' → 'webapp testing'). */
function normPhrase(text: string): string {
  return fold(text).replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Match a prompt against the external-skill index. Returns the top-K (≤ 5) candidates
 * ABOVE the precision floor, best-score-first with a deterministic id-ascending
 * tiebreak — or `[]` when nothing clears the floor. Never throws.
 *
 * @param excludedNames folded names to drop (installed skills, curated skills,
 *   capability ids/triggers) — installed-catalog-wins at match time.
 * @param opts.userInitiated the TYPED `/coach find` path (never the judge). On this path
 *   the precision wall is relaxed to a RECALL floor so the box behaves like a search box:
 *   one strong name-token hit (or a ≥2-token keyword hit) surfaces. Results stay bounded
 *   (top-K) and ranked. The judge path (userInitiated omitted/false) is unchanged.
 */
export function matchExternalSkills(
  prompt: string,
  index: SkillIndex,
  excludedNames: ReadonlySet<string>,
  k = MAX_CANDIDATES,
  opts: { userInitiated?: boolean } = {},
): ExternalCandidate[] {
  // A typed /coach find query IS intent — community entries keep the official floors
  // there. The strict community floors below exist for the UNPROMPTED judge path,
  // where an ordinary-phrase community name must never fire on prose.
  const userInitiated = opts.userInitiated === true;
  const cap = Math.max(0, Math.min(k, MAX_CANDIDATES));
  if (cap === 0) return [];

  const promptTokens = new Set(tokenize(prompt));
  const promptPhrase = ` ${normPhrase(prompt)} `;
  if (promptTokens.size === 0 && promptPhrase.trim().length === 0) return [];

  const scored: { entry: (typeof index.entries)[number]; score: number }[] = [];

  for (const entry of index.entries) {
    if (excludedNames.has(fold(entry.name))) continue; // installed-catalog-wins.

    const nameTokens = tokenize(entry.name);
    const keywordTokens = [...new Set(entry.keywords.flatMap((kw) => tokenize(kw)))];
    const categoryTokens = entry.category !== null ? tokenize(entry.category) : [];

    let score = 0;
    let distinct = 0;
    let nameHit = false;
    for (const token of promptTokens) {
      if (hasNearMatch(token, nameTokens)) {
        score += NAME_WEIGHT;
        distinct += 1;
        nameHit = true;
      } else if (hasNearMatch(token, keywordTokens)) {
        score += KEYWORD_WEIGHT;
        distinct += 1;
      } else if (hasNearMatch(token, categoryTokens)) {
        score += CATEGORY_WEIGHT;
        distinct += 1;
      }
    }

    // The exact-full-name shortcut applies ONLY to multi-token names ('webapp-testing'):
    // the real index carries ~115 single-token names including generic English nouns
    // (data, remember, confidence, playground), so a bare word in prose is NOISE, not a
    // request for that skill. A single-token name must clear the normal floor — a name
    // hit (3) plus at least one keyword/category corroboration — never the name alone.
    // On the judge path this shortcut is OFFICIAL-only: community names are
    // attacker-chosen, so a multi-token name that reads as an ordinary phrase
    // ("review helper") would fire on normal prose with zero corroboration.
    const namePhrase = normPhrase(entry.name);
    const exactNameMatch =
      (entry.trust === 'official' || userInitiated) &&
      nameTokens.length >= 2 &&
      namePhrase.length >= 3 &&
      promptPhrase.includes(` ${namePhrase} `);

    // Keyword-only matches carry the broadest (description-derived) tokens, so they
    // need three concordant signals, not two incidental ones. G-M4b: community entries
    // pay COMMUNITY_FLOOR_BONUS on top of both floors (precision over recall).
    const communityStrict = entry.trust !== 'official' && !userInitiated;
    const scoreFloor =
      (nameHit ? SCORE_FLOOR : KEYWORD_ONLY_SCORE_FLOOR) +
      (communityStrict ? COMMUNITY_FLOOR_BONUS : 0);
    // Unprompted community also needs a THIRD distinct signal: two name tokens alone
    // (an ordinary two-word phrase) score exactly the surcharged floor and must not fire.
    const distinctFloor = communityStrict ? DISTINCT_FLOOR + 1 : DISTINCT_FLOOR;
    const aboveFloor = (score >= scoreFloor && distinct >= distinctFloor) || exactNameMatch;

    // RECALL FLOOR for the typed /coach find box ONLY (userInitiated). A newcomer is
    // literally told on the tour to "/coach find <task>", so the box must behave like a
    // search box: ONE concordant signal (a name, keyword, or category token hit) surfaces
    // the skill. This is well below the judge's SCORE_FLOOR/DISTINCT_FLOOR precision wall,
    // which is UNTOUCHED here — this branch never runs on the judge path, so there is no
    // over-fire regression. Results stay bounded by the top-K cap and ranked
    // score-desc/official-first below, so a broad query never floods the terminal.
    const recallHit = userInitiated && distinct >= 1;

    if (!aboveFloor && !recallHit) continue;

    scored.push({ entry, score });
  }

  // Score desc → OFFICIAL before community at equal score (G-M4b trust tiebreak) →
  // deterministic id-ascending tiebreak.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aOfficial = a.entry.trust === 'official' ? 0 : 1;
    const bOfficial = b.entry.trust === 'official' ? 0 : 1;
    if (aOfficial !== bOfficial) return aOfficial - bOfficial;
    return a.entry.id < b.entry.id ? -1 : 1;
  });

  return scored.slice(0, cap).map(({ entry }) => ({
    name: entry.name,
    description: entry.description,
    install: entry.install,
    sourceUrl: entry.sourceUrl,
    trust: entry.trust,
    repoStars: entry.repoStars,
  }));
}
