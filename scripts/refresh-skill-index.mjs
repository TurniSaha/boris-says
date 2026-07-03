#!/usr/bin/env node
/**
 * scripts/refresh-skill-index.mjs — M4 external-skill index scraper (`npm run refresh-index`).
 *
 * Generates data/skill-index.json from EXACTLY the two allowlisted official Anthropic
 * sources (ALLOWED_SOURCES below). Node stdlib + the `gh` CLI only — zero runtime deps.
 *
 * FAIL-LOUD CONTRACT: any fetch/parse/validation failure exits 1 WITHOUT writing, so a
 * broken scrape can never replace a good index with a gutted one. Hard caps are asserted
 * at scrape time (assertIndexValid): >0 and <= MAX_ENTRIES entries, serialized
 * <= MAX_BYTES, every entry carries non-empty name/description/install/sourceUrl.
 * Entries are sorted by id (deterministic output for a given upstream state).
 *
 * The pure transformation functions are exported for the unit test
 * (test/refresh-skill-index.test.ts); main() only runs when invoked directly
 * (coach-cmd entry-point pattern).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Pinned allowlist + caps ──────────────────────────────────────────────────

/** The ONLY official sources scraped. Community rides the separate gated path below. */
export const ALLOWED_SOURCES = Object.freeze([
  Object.freeze({
    repo: 'anthropics/skills',
    marketplace: 'anthropic-agent-skills',
    kind: 'skills',
  }),
  Object.freeze({
    repo: 'anthropics/claude-plugins-official',
    marketplace: 'claude-plugins-official',
    kind: 'marketplace',
  }),
]);

/** G-M4b: how many attempts the community fetch gets before carry-forward kicks in. */
const COMMUNITY_FETCH_TRIES = 2;

export const MAX_ENTRIES = 400;
export const MAX_BYTES = 300 * 1024;
export const MAX_DESCRIPTION_CHARS = 400;

// ── Pure helpers ─────────────────────────────────────────────────────────────

// ANSI CSI escape sequences stripped WHOLE (the printable '[31m' payload must never
// survive its ESC), then any remaining C0/DEL control-char run collapses to ONE space.
// Scraped upstream text must never carry terminal control bytes into the index.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g;

/** Strip ANSI escapes + control chars to a single space (exported for the unit test). */
export function sanitizeText(text) {
  return String(text).replace(ANSI_CSI_RE, ' ').replace(CTRL_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Sanitize + truncate a description at the cap (never throws on a long upstream blob). */
function truncate(text, cap = MAX_DESCRIPTION_CHARS) {
  const clean = sanitizeText(text);
  return clean.length > cap ? clean.slice(0, cap) : clean;
}

// ── LICENSE FIX (publish blocker) ────────────────────────────────────────────
//
// anthropics/skills is a MIXED-license repo shipped WITHOUT a top-level LICENSE: each
// skill carries its own per-skill LICENSE.txt. VERIFIED 2026-07-02 against the live repo
// (gh api repos/anthropics/skills/contents/skills/<dir>/LICENSE.txt + the SKILL.md
// frontmatter `license:` field):
//   - docx / pdf / pptx / xlsx  → "© 2025 Anthropic, PBC. All rights reserved."
//                                  (frontmatter: "Proprietary. LICENSE.txt has complete terms")
//   - the other 12 skills       → Apache License 2.0
//                                  (frontmatter: "Complete terms in LICENSE.txt")
//   - doc-coauthoring           → NO LICENSE.txt, NO license field (unknown)
// The claude-plugins-official marketplace is Apache-2.0 (repo-level), and the community
// source is MIT (repo-level) — both permissive, so their descriptions stay verbatim.
//
// Shipping an all-rights-reserved description VERBATIM inside this MIT repo is the license
// blocker. RULE (precision-over-recall for legal safety): ship a description verbatim ONLY
// when the license is POSITIVELY permissive; otherwise (restricted OR unknown) replace it
// with a short factual, name-derived phrase — a fact (the skill exists, its name), never
// the upstream author's copyrighted prose.

/** Positive permissive markers (SPDX names + the anthropics/skills "complete terms" convention). */
const PERMISSIVE_LICENSE_RE =
  /\b(apache|mit\b|bsd|isc\b|cc0|unlicense|mpl|mozilla public|complete terms in license\.txt|see license\.txt)\b/i;
/** Explicit restriction markers. */
const RESTRICTED_LICENSE_RE = /\b(proprietary|all rights reserved|no license|copyright ©|©\s*\d{4})\b/i;

/**
 * Classify a skill's frontmatter `license:` field into a shipping decision.
 *   'restricted' — an explicit proprietary/all-rights-reserved marker → PARAPHRASE.
 *   'permissive' — an explicit permissive license (Apache/MIT/…) or the anthropic
 *                  "Complete terms in LICENSE.txt" convention → ship VERBATIM.
 *   'unknown'    — absent/empty/unrecognized → PARAPHRASE (fail-safe: never ship prose we
 *                  cannot prove is permissively licensed).
 * Exported for the unit test.
 */
export function skillLicenseClass(licenseField) {
  const s = sanitizeText(licenseField ?? '');
  if (s.length === 0) return 'unknown';
  if (RESTRICTED_LICENSE_RE.test(s)) return 'restricted';
  if (PERMISSIVE_LICENSE_RE.test(s)) return 'permissive';
  return 'unknown';
}

/**
 * A short, factual, NAME-DERIVED description used when the upstream description cannot be
 * shipped (restricted/unknown license). No copyrighted prose — just the skill name + a
 * neutral factual frame. The name folds to a readable phrase (hyphens → spaces).
 */
function nameDerivedDescription(name) {
  const readable = String(name).replace(/[-_]+/g, ' ').trim();
  return `${name} — a Claude skill (${readable}); description omitted (source not permissively licensed).`;
}

/**
 * Glue words that carry no matching signal — without this filter,
 * description-derived keywords would let "use this file" corroborate anything.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'use', 'uses', 'using', 'used',
  'when', 'whenever', 'you', 'your', 'yours', 'all', 'any', 'are', 'can', 'could', 'from', 'into',
  'its', 'not', 'our', 'out', 'per', 'via', 'want', 'wants', 'user', 'users', 'skill', 'skills',
  'file', 'files', 'new', 'one', 'two', 'how', 'what', 'which', 'will', 'would', 'should', 'then',
  'them', 'they', 'their', 'has', 'have', 'had', 'also', 'more', 'most', 'other', 'such', 'some',
  'like', 'just', 'only', 'over', 'under', 'each', 'every', 'etc', 'both', 'being', 'been', 'was',
  'were', 'does', 'doing', 'done', 'get', 'gets', 'getting', 'make', 'makes', 'making', 'made',
  'see', 'set', 'run', 'runs', 'running', 'add', 'adds', 'adding', 'lets', 'let', 'help', 'helps',
  'work', 'works', 'working', 'need', 'needs', 'way', 'ways', 'tool', 'tools', 'anything',
]);

/** Fold-tokenize a phrase into keyword tokens (lowercase alnum runs, >= 3 chars, no stopwords). */
function tokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Derived keywords: category + name tokens + any upstream keyword/tag arrays. */
function deriveKeywords(name, category, ...upstreamLists) {
  const out = new Set();
  for (const t of tokens(name)) out.add(t);
  if (typeof category === 'string') for (const t of tokens(category)) out.add(t);
  for (const list of upstreamLists) {
    if (!Array.isArray(list)) continue;
    for (const kw of list) if (typeof kw === 'string') for (const t of tokens(kw)) out.add(t);
  }
  return [...out].sort();
}

/**
 * Extract `name` and `description` from a SKILL.md's `---`-delimited frontmatter.
 * Missing either field THROWS (fail-loud per the input-validation rule) — a skill
 * without a name/description must abort the scrape, not silently degrade the index.
 * Handles a single-line value plus YAML indented continuations.
 */
export function parseSkillFrontmatter(md) {
  if (typeof md !== 'string' || md.length === 0) {
    throw new Error('SKILL.md is empty or not a string');
  }
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('SKILL.md has no ----delimited frontmatter block');
  const fm = m[1];
  const name = frontmatterField(fm, 'name');
  const description = frontmatterField(fm, 'description');
  // `license:` is OPTIONAL (some skills omit it) — absent → '' → classified 'unknown'.
  const license = frontmatterField(fm, 'license');
  if (!name) throw new Error('SKILL.md frontmatter is missing `name:`');
  if (!description) throw new Error('SKILL.md frontmatter is missing `description:`');
  return { name, description, license };
}

/** Read one frontmatter field: the line value plus any indented continuation lines. */
function frontmatterField(fm, field) {
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(new RegExp(`^${field}:\\s*(.*)$`));
    if (!m) continue;
    const parts = [];
    const head = m[1].trim();
    // A YAML block-scalar indicator (|, >, and the chomping forms |-, >-, |+, >+) is
    // NOT content — the value is the indented continuation lines below it.
    if (head.length > 0 && !/^[|>][+-]?$/.test(head)) parts.push(head);
    // YAML continuation: subsequent indented lines belong to this scalar.
    for (let j = i + 1; j < lines.length; j += 1) {
      const cont = lines[j];
      if (!/^\s+\S/.test(cont)) break;
      parts.push(cont.trim());
    }
    const value = parts.join(' ').replace(/^["']|["']$/g, '').trim();
    return value;
  }
  return '';
}

/**
 * Map the official claude-plugins-official marketplace.json shape -> index entries.
 * THROWS on a missing plugins array or a plugin missing name/description (fail-loud).
 */
export function marketplaceToEntries(json, sourceMeta) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.plugins)) {
    throw new Error(`${sourceMeta.repo}: marketplace.json has no plugins array`);
  }
  return json.plugins.map((p) => {
    if (!p || typeof p.name !== 'string' || p.name.length === 0) {
      throw new Error(`${sourceMeta.repo}: a marketplace plugin has no name`);
    }
    if (typeof p.description !== 'string' || p.description.length === 0) {
      throw new Error(`${sourceMeta.repo}: plugin "${p.name}" has no description`);
    }
    const name = sanitizeText(p.name);
    const category = typeof p.category === 'string' && p.category.length > 0 ? p.category : null;
    const pinnedSha =
      p.source && typeof p.source === 'object' && typeof p.source.sha === 'string'
        ? p.source.sha
        : (sourceMeta.headSha ?? null);
    const sourceUrl =
      typeof p.homepage === 'string' && p.homepage.startsWith('http')
        ? p.homepage
        : `https://github.com/${sourceMeta.repo}`;
    return {
      id: `official-marketplace/${name}`,
      name,
      kind: 'plugin',
      description: truncate(p.description),
      keywords: deriveKeywords(name, category, p.keywords, p.tags),
      category,
      install: `/plugin install ${name}@${sourceMeta.marketplace}`,
      sourceUrl,
      trust: 'official',
      // claude-plugins-official is repo-level Apache-2.0 (VERIFIED 2026-07-02:
      // gh api repos/anthropics/claude-plugins-official/license → Apache-2.0) → permissive,
      // so plugin descriptions ship verbatim.
      licenseClass: 'permissive',
      pinnedSha,
      repoStars: typeof sourceMeta.stars === 'number' ? sourceMeta.stars : null,
    };
  });
}

/**
 * Map anthropics/skills SKILL.md docs -> index entries. `skills` is
 * [{ dir, md }]; `marketplace` is that repo's own .claude-plugin/marketplace.json,
 * used to resolve which installable PLUGIN carries each skill (a skill outside any
 * plugin falls back to its own name). Throws on any unparseable SKILL.md.
 */
export function skillsToEntries(skills, marketplace, sourceMeta) {
  // './skills/<dir>' -> containing plugin name.
  const pluginBySkillPath = new Map();
  if (marketplace && Array.isArray(marketplace.plugins)) {
    for (const p of marketplace.plugins) {
      if (!p || typeof p.name !== 'string' || !Array.isArray(p.skills)) continue;
      for (const sp of p.skills) {
        if (typeof sp === 'string') pluginBySkillPath.set(sp.replace(/\/+$/, ''), p.name);
      }
    }
  }
  return skills.map(({ dir, md }) => {
    const fm = parseSkillFrontmatter(md);
    const name = sanitizeText(fm.name);
    const plugin = pluginBySkillPath.get(`./skills/${dir}`) ?? name;
    // LICENSE FIX: only ship the upstream DESCRIPTION prose VERBATIM when the source is
    // positively permissive. A restricted (all-rights-reserved) OR unknown license → a short
    // factual name-derived phrase instead of the copyrighted sentence.
    //
    // Keywords are a DIFFERENT facet: a bag of individual lowercased word tokens (not the
    // author's expressive sentence) — single factual words like "extraction"/"tables" are not
    // the copyrighted work, and they preserve discoverability (`/coach find pdf extraction`).
    // So we KEEP the description-derived keyword tokens even when the prose is excluded — the
    // license fix withholds the SENTENCE, not the searchable word-facts.
    const licenseClass = skillLicenseClass(fm.license);
    const permissive = licenseClass === 'permissive';
    const description = permissive ? truncate(fm.description) : nameDerivedDescription(name);
    const keywords = deriveKeywords(name, null, [fm.description]);
    return {
      id: `anthropic-skills/${name}`,
      name,
      kind: 'skill',
      description,
      // Description tokens keep single-token names (pdf, docx…) reachable now
      // that the matcher requires corroboration beyond a bare name hit — but ONLY when the
      // description is permissively licensed and actually shipped.
      keywords,
      category: null,
      install: `/plugin install ${plugin}@${sourceMeta.marketplace}`,
      sourceUrl: `https://github.com/${sourceMeta.repo}/tree/main/skills/${dir}`,
      trust: 'official',
      // Provenance for the NOTICE / audit: which licensing decision produced this entry.
      licenseClass,
      pinnedSha: sourceMeta.headSha ?? null,
      repoStars: typeof sourceMeta.stars === 'number' ? sourceMeta.stars : null,
    };
  });
}

/**
 * G-M4b FAILURE POLICY (community only — official stays exit-1 fail-loud):
 *   - fresh community entries present → official + fresh,
 *   - community fetch/floor/gate failed (null) → CARRY FORWARD the trust:'community'
 *     slice from the previous index (never partial-ingest, never a gutted index),
 *   - no previous index either → official-only.
 * The official slice is ALWAYS the freshly scraped one. PURE (exported for the test).
 */
export function mergeWithCarryForward(officialEntries, freshCommunity, previousIndex) {
  if (Array.isArray(freshCommunity) && freshCommunity.length > 0) {
    return [...officialEntries, ...freshCommunity];
  }
  const previousCommunity =
    previousIndex && Array.isArray(previousIndex.entries)
      ? previousIndex.entries.filter((e) => e && e.trust === 'community')
      : [];
  return [...officialEntries, ...previousCommunity];
}

/** Assemble the index: deterministic id-sort + schemaVersion/generatedAt stamps. */
export function buildIndex(entries, sources, now) {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    sources,
    entries: sorted,
  };
}

/**
 * Validate the assembled index against the hard caps. THROWS on any violation so a
 * broken scrape never writes: 0 entries, > MAX_ENTRIES, serialized > MAX_BYTES, or
 * any entry missing a non-empty name/description/install/sourceUrl string.
 */
export function assertIndexValid(index) {
  if (!index || !Array.isArray(index.entries)) throw new Error('index has no entries array');
  if (index.entries.length === 0) throw new Error('index has 0 entries — refusing to write a gutted index');
  if (index.entries.length > MAX_ENTRIES) {
    throw new Error(`index has ${index.entries.length} entries (cap ${MAX_ENTRIES})`);
  }
  for (const e of index.entries) {
    for (const field of ['name', 'description', 'install', 'sourceUrl']) {
      if (typeof e[field] !== 'string' || e[field].length === 0) {
        throw new Error(`entry ${JSON.stringify(e.id ?? e.name ?? '?')} is missing required string field "${field}"`);
      }
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(index, null, 2), 'utf8');
  if (bytes > MAX_BYTES) {
    throw new Error(`serialized index is ${bytes} bytes (byte cap ${MAX_BYTES} = 300 KB)`);
  }
}

// ── Network side (gh CLI) — main() only ──────────────────────────────────────

function gh(path) {
  const out = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function ghFileText(repo, path) {
  const meta = gh(`repos/${repo}/contents/${path}`);
  if (!meta || typeof meta.content !== 'string') {
    throw new Error(`${repo}/${path}: no base64 content in the contents API response`);
  }
  return Buffer.from(meta.content, 'base64').toString('utf8');
}

function repoMeta(repo) {
  const r = gh(`repos/${repo}`);
  const branch = typeof r.default_branch === 'string' ? r.default_branch : 'main';
  const head = gh(`repos/${repo}/commits/${branch}`);
  return {
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : null,
    headSha: typeof head.sha === 'string' ? head.sha : null,
  };
}

/**
 * G-M4b: scrape + curate the single community source through the SHARED compiled gate
 * (dist/capability/community-gate.js — one implementation, no drift). Returns the
 * curated entries (repoStars stamped) or THROWS — the caller applies the carry-forward
 * policy. `officialFoldedNames` prevents official-name shadowing at scrape time.
 */
async function scrapeCommunity(officialFoldedNames, sources) {
  const gate = await import('../dist/capability/community-gate.js');
  const { COMMUNITY_SOURCE, repoFloorsOk, curateCommunityEntries } = gate;

  const r = gh(`repos/${COMMUNITY_SOURCE.repo}`);
  const meta = {
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
    pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : '',
    archived: r.archived === true,
  };
  if (!repoFloorsOk(meta, Date.now())) {
    throw new Error(
      `${COMMUNITY_SOURCE.repo} fails the repo floors (stars=${meta.stars}, pushed=${meta.pushedAt}, archived=${meta.archived})`,
    );
  }
  const marketplace = JSON.parse(
    ghFileText(COMMUNITY_SOURCE.repo, '.claude-plugin/marketplace.extended.json'),
  );
  const curated = curateCommunityEntries(marketplace, officialFoldedNames, Date.now());
  if (curated.length === 0) throw new Error(`${COMMUNITY_SOURCE.repo}: 0 entries survived the gate`);
  sources.push({
    repo: COMMUNITY_SOURCE.repo,
    marketplace: COMMUNITY_SOURCE.marketplace,
    sha: null,
    stars: meta.stars,
    trust: 'community',
  });
  // The community source (jeremylongshore/claude-code-plugins-plus-skills) is repo-level
  // MIT (VERIFIED 2026-07-02: gh api …/license → MIT) → permissive; its curated descriptions
  // ride verbatim (behind the trust:'community' label + the injection lint).
  return curated.map((e) => ({ ...e, licenseClass: 'permissive', repoStars: meta.stars }));
}

/** Best-effort read of the previous committed index (for community carry-forward). */
function readPreviousIndex(outPath) {
  try {
    return JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const entries = [];
  const sources = [];

  for (const src of ALLOWED_SOURCES) {
    const meta = repoMeta(src.repo);
    const sourceMeta = { ...src, ...meta };
    if (src.kind === 'marketplace') {
      const marketplace = JSON.parse(ghFileText(src.repo, '.claude-plugin/marketplace.json'));
      entries.push(...marketplaceToEntries(marketplace, sourceMeta));
    } else {
      const marketplace = JSON.parse(ghFileText(src.repo, '.claude-plugin/marketplace.json'));
      const listing = gh(`repos/${src.repo}/contents/skills`);
      if (!Array.isArray(listing)) throw new Error(`${src.repo}/skills: not a directory listing`);
      const dirs = listing.filter((e) => e.type === 'dir').map((e) => e.name);
      const skills = dirs.map((dir) => ({
        dir,
        md: ghFileText(src.repo, `skills/${dir}/SKILL.md`),
      }));
      entries.push(...skillsToEntries(skills, marketplace, sourceMeta));
    }
    sources.push({ repo: src.repo, marketplace: src.marketplace, sha: meta.headSha, stars: meta.stars });
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outPath = join(repoRoot, 'data', 'skill-index.json');

  // G-M4b: the gated community scrape. Official failure above stays exit-1 fail-loud;
  // a community failure (after COMMUNITY_FETCH_TRIES tries) carries the previous
  // community slice forward — never a partial ingest, never a gutted index.
  const officialFoldedNames = new Set(entries.map((e) => e.name.trim().toLowerCase()));
  let freshCommunity = null;
  for (let attempt = 1; attempt <= COMMUNITY_FETCH_TRIES; attempt += 1) {
    try {
      freshCommunity = await scrapeCommunity(officialFoldedNames, sources);
      break;
    } catch (err) {
      process.stderr.write(
        `WARNING: community scrape attempt ${attempt}/${COMMUNITY_FETCH_TRIES} failed: ${err?.message ?? err}\n`,
      );
    }
  }
  if (freshCommunity === null) {
    process.stderr.write(
      'WARNING: community source unavailable — carrying forward the previous community slice (or shipping official-only).\n',
    );
  }
  const merged = mergeWithCarryForward(entries, freshCommunity, readPreviousIndex(outPath));

  const index = buildIndex(merged, sources, Date.now());
  assertIndexValid(index);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

  const perSource = sources
    .map((s) => `${s.repo}: ${index.entries.filter((e) => e.sourceUrl.includes(s.repo) || e.install.endsWith(`@${s.marketplace}`)).length}`)
    .join(', ');
  process.stdout.write(
    `wrote ${outPath} — ${index.entries.length} entries (${perSource}), ${Buffer.byteLength(JSON.stringify(index, null, 2), 'utf8')} bytes\n`,
  );
}

// Only run when invoked directly (`node scripts/refresh-skill-index.mjs`), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`refresh-skill-index FAILED: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
