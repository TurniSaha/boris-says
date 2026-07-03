/**
 * src/capability/community-gate.ts — G-M4b COMMUNITY curation gate (PURE: no fs, no
 * network, no clock reads — `now` is a parameter). Compiled to dist so BOTH consumers
 * (the runtime auto-refresher in index-refresh.ts and the manual
 * scripts/refresh-skill-index.mjs scraper) share ONE implementation of the
 * security-critical filtering — no drift.
 *
 * THREAT MODEL: community entries are UNTRUSTED INPUT. Descriptions ride the judge
 * prompt and the terminal; install commands are shown to humans who may run them.
 * The gate therefore:
 *   - REJECTS (never truncates/sanitizes-and-accepts) any text failing the injection
 *     lint (`isCleanCommunityText`),
 *   - GENERATES the install command from the validated name — upstream install text is
 *     structurally incapable of reaching a human,
 *   - pins sourceUrl to the single allowlisted community repo,
 *   - drops entries that shadow an official name (fold AND alnum-lookalike),
 *   - floors on the maintainer's verification grade/score, and caps the slice.
 *
 * HONESTY: upstream `verification.score` is the maintainer grading his own mostly
 * self-authored catalog. The gate makes entries *safe to display and match*, not
 * *endorsed* — the trust:'community' label + generated install is the real protection.
 */
import type { SkillIndexEntry } from './skill-index.js';

/** A curated community entry is shaped exactly like any other index entry. */
export type CommunityEntry = SkillIndexEntry;

/** The ONLY community source. Adding another is a code change, never data. */
export const COMMUNITY_SOURCE = Object.freeze({
  repo: 'jeremylongshore/claude-code-plugins-plus-skills',
  marketplace: 'claude-code-plugins-plus',
});

// ── Curation floors ───────────────────────────────────────────────────────────
export const COMMUNITY_MAX_ENTRIES = 100;
export const COMMUNITY_DESC_MIN = 20;
export const COMMUNITY_DESC_MAX = 350;
export const MIN_STARS = 1000;
export const MAX_PUSHED_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const MIN_VERIFICATION_SCORE = 80;
/** Grades accepted from the upstream verification block. */
const GRADE_ALLOWLIST: ReadonlySet<string> = new Set(['A', 'B']);
/** How many upstream keywords are kept (and linted) per entry. */
const KEYWORDS_KEPT = 8;

/** Community plugin names: lowercase alnum + dashes, 2–64 chars, no leading dash. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// ── Repo floors ───────────────────────────────────────────────────────────────
export interface CommunityRepoMeta {
  readonly stars: number;
  readonly pushedAt: string;
  readonly archived: boolean;
}

/**
 * Evidence-based repo floors: ≥ MIN_STARS stars, pushed within MAX_PUSHED_AGE_MS,
 * not archived. An unparseable pushedAt fails CLOSED.
 */
export function repoFloorsOk(meta: CommunityRepoMeta, now: number): boolean {
  if (typeof meta.stars !== 'number' || meta.stars < MIN_STARS) return false;
  if (meta.archived === true) return false;
  const pushed = Date.parse(meta.pushedAt);
  if (Number.isNaN(pushed)) return false;
  return now - pushed <= MAX_PUSHED_AGE_MS;
}

// ── Injection lint ────────────────────────────────────────────────────────────
// Ported from scripts/refresh-skill-index.mjs sanitizeText (the gate is pure and must
// not import the script; the loader has its own copy too — three small, pinned regexes).
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g;

/** Strip ANSI escapes + control chars to a single space (for text that PASSED the lint). */
export function sanitizeCommunityText(text: string): string {
  return String(text).replace(ANSI_CSI_RE, ' ').replace(CTRL_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

// Any C0/DEL control byte (includes the ESC that leads every ANSI sequence), plus
// C1 controls and the Unicode line terminators U+2028/U+2029 — the latter render as
// real line breaks in the judge prompt and terminal, the exact newline-injection vector.
// eslint-disable-next-line no-control-regex
const ANY_CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
// Zero-width + bidi-override unicode (invisible-instruction smuggling).
const ZERO_WIDTH_BIDI_RE = /[​-‏‪-‮⁦-⁩﻿]/;
// A base64-looking run long enough to hide a payload.
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{40,}/;
// Prompt-injection phrases (case-insensitive).
const INJECTION_PHRASES_RE = /ignore (all|previous|prior)|system prompt|you are|assistant:/i;
// A backtick adjacent to a shell-execution word.
const BACKTICK_SHELL_RE = /`\s*(curl|sh|bash|eval|exec)\b|\b(curl|sh|bash|eval|exec)\s*`/i;
// Every URL in the text must be a github.com https URL.
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const ALLOWED_URL_PREFIX = 'https://github.com/';

/**
 * The injection lint for untrusted community text. Checks the RAW string (control bytes
 * present at all → reject, never sanitize-and-accept). Pure; never throws.
 */
export function isCleanCommunityText(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (ANY_CTRL_RE.test(s)) return false;
  if (ZERO_WIDTH_BIDI_RE.test(s)) return false;
  if (BASE64_RUN_RE.test(s)) return false;
  if (INJECTION_PHRASES_RE.test(s)) return false;
  if (s.includes('<') || s.includes('>')) return false;
  if (BACKTICK_SHELL_RE.test(s)) return false;
  for (const url of s.match(URL_RE) ?? []) {
    if (!url.startsWith(ALLOWED_URL_PREFIX)) return false;
  }
  return true;
}

// ── The gate ──────────────────────────────────────────────────────────────────

/** Fold a name for shadow comparison. */
const fold = (s: string): string => s.trim().toLowerCase();
/** Alnum-normalize for lookalike shadow detection ('skill–creator'/'skillcreator'). */
const alnum = (s: string): string => fold(s).replace(/[^a-z0-9]/g, '');

interface RankedEntry {
  readonly entry: CommunityEntry;
  readonly score: number;
  readonly selfAuthored: boolean;
}

/**
 * Curate the upstream marketplace.extended.json into ≤ COMMUNITY_MAX_ENTRIES safe
 * entries. Trusts ONLY the `plugins` array (never metadata counts). Per entry: name
 * shape, grade/score floor, description lint + 20–350 window, keyword lint (first 8),
 * GENERATED install command, pinned sourceUrl, official-shadow dedupe (fold + alnum
 * lookalike). Rank: verification.score desc → non-self-authored first → name asc.
 * Never throws; garbage in → [].
 *
 * `_now` is reserved for future recency floors on per-entry metadata (the repo-level
 * recency floor lives in repoFloorsOk).
 */
export function curateCommunityEntries(
  rawMarketplaceJson: unknown,
  officialFoldedNames: ReadonlySet<string>,
  _now: number,
): CommunityEntry[] {
  if (rawMarketplaceJson === null || typeof rawMarketplaceJson !== 'object') return [];
  const plugins = (rawMarketplaceJson as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return [];

  const officialAlnum = new Set<string>();
  for (const n of officialFoldedNames) officialAlnum.add(alnum(n));

  const ranked: RankedEntry[] = [];
  for (const item of plugins) {
    const r = curateOne(item, officialFoldedNames, officialAlnum);
    if (r !== null) ranked.push(r);
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.selfAuthored !== b.selfAuthored) return a.selfAuthored ? 1 : -1;
    return a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0;
  });

  // In-batch dedupe AFTER ranking (the higher-ranked duplicate wins), then cap.
  const seen = new Set<string>();
  const out: CommunityEntry[] = [];
  for (const { entry } of ranked) {
    const key = alnum(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= COMMUNITY_MAX_ENTRIES) break;
  }
  return out;
}

/** The upstream maintainer's author string (self-graded entries rank after others at a tie). */
const SELF_AUTHOR = 'jeremy longshore';

/** Validate + transform ONE upstream plugin record; null = rejected. */
function curateOne(
  item: unknown,
  officialFoldedNames: ReadonlySet<string>,
  officialAlnum: ReadonlySet<string>,
): RankedEntry | null {
  if (item === null || typeof item !== 'object') return null;
  const p = item as Record<string, unknown>;

  // Name: exact shape, no shadowing of official entries (fold OR alnum lookalike).
  if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) return null;
  const name = p.name;
  if (officialFoldedNames.has(fold(name)) || officialAlnum.has(alnum(name))) return null;

  // Verification floor: grade A/B AND score ≥ 80 (absent block → reject).
  const ver = p.verification;
  if (ver === null || typeof ver !== 'object') return null;
  const grade = (ver as Record<string, unknown>).grade;
  const score = (ver as Record<string, unknown>).score;
  if (typeof grade !== 'string' || !GRADE_ALLOWLIST.has(grade)) return null;
  if (typeof score !== 'number' || score < MIN_VERIFICATION_SCORE) return null;

  // Description: lint the RAW text (reject, never truncate), then window the sanitized.
  if (typeof p.description !== 'string' || !isCleanCommunityText(p.description)) return null;
  const description = sanitizeCommunityText(p.description);
  if (description.length < COMMUNITY_DESC_MIN || description.length > COMMUNITY_DESC_MAX) {
    return null;
  }

  // Keywords: keep the first KEYWORDS_KEPT; a poisoned KEPT keyword rejects the entry.
  const rawKeywords = Array.isArray(p.keywords)
    ? p.keywords.filter((k): k is string => typeof k === 'string').slice(0, KEYWORDS_KEPT)
    : [];
  const keywords: string[] = [];
  for (const kw of rawKeywords) {
    if (!isCleanCommunityText(kw)) return null;
    keywords.push(sanitizeCommunityText(kw));
  }

  // Category: optional; a dirty category is NULLED (it never rides a tip verbatim).
  const category =
    typeof p.category === 'string' && isCleanCommunityText(p.category)
      ? sanitizeCommunityText(p.category)
      : null;

  const author =
    p.author !== null && typeof p.author === 'object'
      ? (p.author as Record<string, unknown>).name
      : null;
  const selfAuthored = typeof author === 'string' && fold(author) === SELF_AUTHOR;

  const entry: CommunityEntry = {
    id: `community-marketplace/${name}`,
    name,
    kind: 'plugin',
    description,
    keywords,
    category,
    // GENERATED — upstream install text is ignored by construction.
    install: `/plugin install ${name}@${COMMUNITY_SOURCE.marketplace}`,
    sourceUrl: `https://github.com/${COMMUNITY_SOURCE.repo}`,
    trust: 'community',
    pinnedSha: null,
    repoStars: null,
  };
  return { entry, score, selfAuthored };
}
