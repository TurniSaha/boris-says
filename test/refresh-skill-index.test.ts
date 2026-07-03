import { describe, it, expect } from 'vitest';
// Pure exports from the scraper script (no network, no gh — fixture strings only).
// @ts-expect-error — plain .mjs module (scripts/ are stdlib-only, untyped by design).
import {
  parseSkillFrontmatter,
  marketplaceToEntries,
  skillsToEntries,
  buildIndex,
  assertIndexValid,
  sanitizeText,
  skillLicenseClass,
  ALLOWED_SOURCES,
  MAX_ENTRIES,
  MAX_BYTES,
  MAX_DESCRIPTION_CHARS,
} from '../scripts/refresh-skill-index.mjs';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SKILL_MD = [
  '---',
  'name: pdf',
  'description: Comprehensive PDF manipulation toolkit for extracting text and tables.',
  'license: See LICENSE.txt',
  '---',
  '',
  '# PDF skill body',
].join('\n');

const MARKETPLACE_JSON = {
  name: 'claude-plugins-official',
  plugins: [
    {
      name: 'aikido',
      description: 'Aikido Security scanning for Claude Code.',
      category: 'security',
      source: {
        source: 'url',
        url: 'https://github.com/AikidoSec/aikido-claude-plugin.git',
        sha: 'fbe11e287175e5eda448516dd2f741a63b276514',
      },
      homepage: 'https://www.aikido.dev',
    },
    {
      name: 'agent-sdk-dev',
      description: 'Development kit for working with the Claude Agent SDK',
      source: './plugins/agent-sdk-dev',
      // no category, no homepage, no source.sha → falls back to head sha + repo URL.
    },
  ],
};

const SOURCE_META = {
  repo: 'anthropics/claude-plugins-official',
  marketplace: 'claude-plugins-official',
  headSha: 'abc123headsha',
  stars: 31449,
};

function validEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'official-marketplace/aikido',
    name: 'aikido',
    kind: 'plugin',
    description: 'Aikido Security scanning.',
    keywords: ['aikido', 'security'],
    category: 'security',
    install: '/plugin install aikido@claude-plugins-official',
    sourceUrl: 'https://www.aikido.dev',
    trust: 'official',
    pinnedSha: 'fbe11e',
    repoStars: 31449,
    ...over,
  };
}

// ── parseSkillFrontmatter ────────────────────────────────────────────────────

describe('parseSkillFrontmatter', () => {
  it('extracts name and description from ----delimited frontmatter', () => {
    const fm = parseSkillFrontmatter(SKILL_MD);
    expect(fm.name).toBe('pdf');
    expect(fm.description).toBe(
      'Comprehensive PDF manipulation toolkit for extracting text and tables.',
    );
  });

  it('throws when name is missing (fail-loud)', () => {
    const md = '---\ndescription: something\n---\nbody';
    expect(() => parseSkillFrontmatter(md)).toThrow(/name/i);
  });

  it('throws when description is missing (fail-loud)', () => {
    const md = '---\nname: pdf\n---\nbody';
    expect(() => parseSkillFrontmatter(md)).toThrow(/description/i);
  });

  it('throws when there is no frontmatter block at all', () => {
    expect(() => parseSkillFrontmatter('# just a heading')).toThrow();
  });

  it('handles YAML block-scalar indicators |- >- |+ >+ like their bare forms', () => {
    // The shipped anthropic-skills/claude-api description literally began "|- Reference...".
    for (const indicator of ['|-', '>-', '|+', '>+', '|', '>']) {
      const md = [
        '---',
        'name: claude-api',
        `description: ${indicator}`,
        '  Reference for building with the Claude API.',
        '  Covers streaming and tools.',
        '---',
        'body',
      ].join('\n');
      const fm = parseSkillFrontmatter(md);
      expect(fm.description).toBe(
        'Reference for building with the Claude API. Covers streaming and tools.',
      );
      expect(fm.description.startsWith('|')).toBe(false);
      expect(fm.description.startsWith('>')).toBe(false);
    }
  });
});

// ── sanitizeText (scraped-text control-char/ANSI hardening) ──────────────────

describe('sanitizeText', () => {
  // eslint-disable-next-line no-control-regex
  const CTRL_OR_ESC = /[\x00-\x1f\x7f]/;

  it('strips ANSI escape sequences and control chars to a single space', () => {
    const dirty = 'red\x1b[31malert\x1b[0m\x00\x07 done\ttab\x7f end';
    const clean = sanitizeText(dirty);
    expect(clean).not.toMatch(CTRL_OR_ESC);
    expect(clean).not.toContain('[31m'); // the CSI payload goes too, not just the ESC byte.
    expect(clean).not.toContain('[0m');
    expect(clean).toContain('red');
    expect(clean).toContain('done');
    expect(clean).toContain('tab end'); // a control run collapses to ONE space.
  });

  it('marketplaceToEntries descriptions come out sanitized', () => {
    const dirty = {
      plugins: [{ name: 'x', description: 'evil\x1b[2J\x1b[31m red\x07 text' }],
    };
    const entries = marketplaceToEntries(dirty, SOURCE_META);
    expect(entries[0].description).not.toMatch(CTRL_OR_ESC);
    expect(entries[0].description).not.toContain('[31m');
    expect(entries[0].description).toContain('red text');
  });

  it('skillsToEntries names/descriptions come out sanitized', () => {
    const md = '---\nname: sneaky\x07-skill\ndescription: hides\x1b[8m secrets\n---\n';
    const meta = { repo: 'anthropics/skills', marketplace: 'anthropic-agent-skills', headSha: 'ffff', stars: 1 };
    const entries = skillsToEntries([{ dir: 'sneaky', md }], null, meta);
    expect(entries[0].name).not.toMatch(CTRL_OR_ESC);
    expect(entries[0].description).not.toMatch(CTRL_OR_ESC);
    expect(entries[0].description).not.toContain('[8m');
  });
});

// ── marketplaceToEntries ─────────────────────────────────────────────────────

describe('marketplaceToEntries', () => {
  it('maps the official marketplace.json shape to index entries', () => {
    const entries = marketplaceToEntries(MARKETPLACE_JSON, SOURCE_META);
    expect(entries).toHaveLength(2);
    const aikido = entries.find((e: any) => e.name === 'aikido');
    expect(aikido.id).toBe('official-marketplace/aikido');
    expect(aikido.kind).toBe('plugin');
    expect(aikido.install).toBe('/plugin install aikido@claude-plugins-official');
    expect(aikido.sourceUrl).toBe('https://www.aikido.dev');
    expect(aikido.trust).toBe('official');
    expect(aikido.pinnedSha).toBe('fbe11e287175e5eda448516dd2f741a63b276514');
    expect(aikido.repoStars).toBe(31449);
    // Derived keywords: category + name tokens.
    expect(aikido.keywords).toContain('security');
    expect(aikido.keywords).toContain('aikido');
  });

  it('falls back to the repo head sha + repo URL when a plugin has no source.sha/homepage', () => {
    const entries = marketplaceToEntries(MARKETPLACE_JSON, SOURCE_META);
    const sdk = entries.find((e: any) => e.name === 'agent-sdk-dev');
    expect(sdk.pinnedSha).toBe('abc123headsha');
    expect(sdk.sourceUrl).toBe('https://github.com/anthropics/claude-plugins-official');
    expect(sdk.category).toBeNull();
  });

  it('truncates descriptions at the cap', () => {
    const long = { plugins: [{ name: 'x', description: 'd'.repeat(1000) }] };
    const entries = marketplaceToEntries(long, SOURCE_META);
    expect(entries[0].description.length).toBe(MAX_DESCRIPTION_CHARS);
  });

  it('throws on a plugin with no name or no description (fail-loud, never a gutted index)', () => {
    expect(() =>
      marketplaceToEntries({ plugins: [{ description: 'no name' }] }, SOURCE_META),
    ).toThrow();
    expect(() => marketplaceToEntries({ plugins: [{ name: 'no-desc' }] }, SOURCE_META)).toThrow();
    expect(() => marketplaceToEntries({ nope: true }, SOURCE_META)).toThrow();
  });
});

// ── skillsToEntries ──────────────────────────────────────────────────────────

describe('skillsToEntries', () => {
  const skillsMarketplace = {
    name: 'anthropic-agent-skills',
    plugins: [
      { name: 'document-skills', source: './', skills: ['./skills/pdf', './skills/pptx'] },
    ],
  };
  const meta = { repo: 'anthropics/skills', marketplace: 'anthropic-agent-skills', headSha: 'ffff', stars: 157657 };

  it('maps a SKILL.md to an entry with the containing plugin install command', () => {
    const entries = skillsToEntries([{ dir: 'pdf', md: SKILL_MD }], skillsMarketplace, meta);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.id).toBe('anthropic-skills/pdf');
    expect(e.name).toBe('pdf');
    expect(e.kind).toBe('skill');
    expect(e.install).toBe('/plugin install document-skills@anthropic-agent-skills');
    expect(e.sourceUrl).toBe('https://github.com/anthropics/skills/tree/main/skills/pdf');
    expect(e.trust).toBe('official');
    expect(e.pinnedSha).toBe('ffff');
    expect(e.repoStars).toBe(157657);
  });

  it('derives keywords from the description so single-token names stay reachable (post-HIGH-fix)', () => {
    const entries = skillsToEntries([{ dir: 'pdf', md: SKILL_MD }], skillsMarketplace, meta);
    expect(entries[0].keywords).toContain('pdf');
    expect(entries[0].keywords).toContain('extracting');
    expect(entries[0].keywords).toContain('text');
    expect(entries[0].keywords).toContain('tables');
  });

  it('keyword derivation drops stopwords — generic glue words never become match tokens', () => {
    const md = '---\nname: widget\ndescription: Use this skill whenever the user wants to do anything with the widget files.\n---\n';
    const entries = skillsToEntries([{ dir: 'widget', md }], skillsMarketplace, meta);
    for (const stop of ['use', 'this', 'the', 'wants', 'anything', 'with', 'whenever', 'user', 'skill', 'files']) {
      expect(entries[0].keywords).not.toContain(stop);
    }
    expect(entries[0].keywords).toContain('widget');
  });

  it('a skill outside any marketplace plugin installs by its own name', () => {
    const md = '---\nname: loose-skill\ndescription: not in any plugin\n---\n';
    const entries = skillsToEntries([{ dir: 'loose-skill', md }], skillsMarketplace, meta);
    expect(entries[0].install).toBe('/plugin install loose-skill@anthropic-agent-skills');
  });

  // ── LICENSE FIX (publish blocker): non-permissive descriptions are NOT shipped verbatim.
  // anthropics/skills is a MIXED-license repo: most skills are Apache-2.0 (verbatim OK),
  // but docx/pdf/pptx/xlsx are marked "Proprietary. LICENSE.txt has complete terms".
  it('a PROPRIETARY-licensed skill does NOT ship its upstream description verbatim', () => {
    const proprietaryMd = [
      '---',
      'name: docx',
      'description: Comprehensive Word document toolkit for creating and editing .docx files with tracked changes.',
      'license: Proprietary. LICENSE.txt has complete terms',
      '---',
      'body',
    ].join('\n');
    const entries = skillsToEntries([{ dir: 'docx', md: proprietaryMd }], skillsMarketplace, meta);
    const e = entries[0];
    // The verbatim upstream sentence must NOT appear (all-rights-reserved text excluded).
    expect(e.description).not.toContain('Comprehensive Word document toolkit');
    expect(e.description).not.toContain('tracked changes');
    // A short factual, name-derived phrase rides instead (non-empty, references the name).
    expect(e.description.length).toBeGreaterThan(0);
    expect(e.description.toLowerCase()).toContain('docx');
    // The entry is flagged so the NOTICE/provenance can be audited.
    expect(e.licenseClass).toBe('restricted');
    // Keywords (individual word-facts, NOT the copyrighted sentence) are KEPT for
    // discoverability — only the verbatim DESCRIPTION prose is withheld.
    expect(e.keywords).toContain('docx');
    expect(e.keywords).toContain('tracked');
  });

  it('a PERMISSIVE (Apache) skill keeps its verbatim upstream description', () => {
    // The anthropics/skills Apache convention marker.
    const apacheMd = [
      '---',
      'name: mcp-builder',
      'description: Scaffolds an MCP server with tools and resources using the TypeScript SDK.',
      'license: Complete terms in LICENSE.txt',
      '---',
      'body',
    ].join('\n');
    const entries = skillsToEntries([{ dir: 'mcp-builder', md: apacheMd }], skillsMarketplace, meta);
    const e = entries[0];
    expect(e.description).toBe(
      'Scaffolds an MCP server with tools and resources using the TypeScript SDK.',
    );
    expect(e.licenseClass).toBe('permissive');
    expect(e.keywords).toContain('scaffolds');
  });

  it('a skill with NO license field is treated as UNKNOWN → paraphrased (fail-safe)', () => {
    const noLicenseMd = [
      '---',
      'name: doc-coauthoring',
      'description: Real-time collaborative document authoring with change proposals.',
      '---',
      'body',
    ].join('\n');
    const entries = skillsToEntries([{ dir: 'doc-coauthoring', md: noLicenseMd }], skillsMarketplace, meta);
    const e = entries[0];
    expect(e.description).not.toContain('change proposals');
    expect(e.licenseClass).toBe('unknown');
    expect(e.description.toLowerCase()).toContain('doc-coauthoring');
  });
});

// ── skillLicenseClass (the license classifier — the LICENSE-FIX core) ─────────

describe('skillLicenseClass', () => {
  it('classifies an explicit Proprietary marker as restricted', () => {
    expect(skillLicenseClass('Proprietary. LICENSE.txt has complete terms')).toBe('restricted');
    expect(skillLicenseClass('All rights reserved')).toBe('restricted');
  });

  it('classifies the anthropic "Complete terms in LICENSE.txt" convention as permissive', () => {
    expect(skillLicenseClass('Complete terms in LICENSE.txt')).toBe('permissive');
    expect(skillLicenseClass('See LICENSE.txt')).toBe('permissive');
  });

  it('classifies an explicit permissive SPDX name as permissive', () => {
    for (const p of ['Apache-2.0', 'MIT', 'apache license 2.0', 'BSD-3-Clause', 'ISC']) {
      expect(skillLicenseClass(p)).toBe('permissive');
    }
  });

  it('classifies a missing/empty license field as unknown (fail-safe → paraphrase)', () => {
    expect(skillLicenseClass('')).toBe('unknown');
    expect(skillLicenseClass(undefined)).toBe('unknown');
    expect(skillLicenseClass('some bespoke terms nobody recognizes')).toBe('unknown');
  });
});

// ── buildIndex ───────────────────────────────────────────────────────────────

describe('buildIndex', () => {
  it('sorts entries by id (deterministic) and stamps schemaVersion/generatedAt', () => {
    const a = validEntry({ id: 'zzz/last', name: 'zzz' });
    const b = validEntry({ id: 'aaa/first', name: 'aaa' });
    const index = buildIndex([a, b], [{ repo: 'r', sha: 's', stars: 1 }], 1_700_000_000_000);
    expect(index.schemaVersion).toBe(1);
    expect(index.generatedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(index.entries.map((e: any) => e.id)).toEqual(['aaa/first', 'zzz/last']);
    expect(index.sources).toHaveLength(1);
  });
});

// ── assertIndexValid ─────────────────────────────────────────────────────────

describe('assertIndexValid', () => {
  function indexWith(entries: unknown[]): unknown {
    return {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      sources: [],
      entries,
    };
  }

  it('accepts a small valid index', () => {
    expect(() => assertIndexValid(indexWith([validEntry()]))).not.toThrow();
  });

  it('throws on 0 entries (a broken scrape never writes a gutted index)', () => {
    expect(() => assertIndexValid(indexWith([]))).toThrow();
  });

  it('throws on more than the entry cap', () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) =>
      validEntry({ id: `official-marketplace/p${i}`, name: `p${i}` }),
    );
    expect(() => assertIndexValid(indexWith(many))).toThrow();
  });

  it('throws when the serialized index exceeds the byte cap', () => {
    const fat = Array.from({ length: 300 }, (_, i) =>
      validEntry({
        id: `official-marketplace/p${i}`,
        name: `p${i}`,
        // description within the per-entry cap, but 300 × ~1.4KB of keywords blows 300KB.
        keywords: Array.from({ length: 100 }, (_, j) => `keyword-${i}-${j}`),
      }),
    );
    expect(() => assertIndexValid(indexWith(fat))).toThrow(/byte|KB|size/i);
    expect(MAX_BYTES).toBe(300 * 1024);
  });

  it('throws on an entry missing a required string field', () => {
    for (const field of ['name', 'description', 'install', 'sourceUrl']) {
      expect(() => assertIndexValid(indexWith([validEntry({ [field]: undefined })]))).toThrow();
      expect(() => assertIndexValid(indexWith([validEntry({ [field]: '' })]))).toThrow();
    }
  });
});

// ── allowlist pin ────────────────────────────────────────────────────────────

describe('ALLOWED_SOURCES allowlist', () => {
  it('is pinned to exactly the two official Anthropic repos', () => {
    expect(ALLOWED_SOURCES.map((s: any) => s.repo).sort()).toEqual([
      'anthropics/claude-plugins-official',
      'anthropics/skills',
    ]);
  });
});

// ── G-M4b: community merge + carry-forward policy ─────────────────────────────

import { mergeWithCarryForward, buildIndex as buildIdx } from '../scripts/refresh-skill-index.mjs';

describe('mergeWithCarryForward — community failure never guts the index', () => {
  const official = [
    { id: 'anthropic-skills/pdf', name: 'pdf', trust: 'official' },
    { id: 'official-marketplace/x', name: 'x', trust: 'official' },
  ];
  const freshCommunity = [
    { id: 'community-marketplace/tool-a', name: 'tool-a', trust: 'community' },
  ];
  const previousIndex = {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    sources: [],
    entries: [
      { id: 'anthropic-skills/OLD', name: 'old', trust: 'official' },
      { id: 'community-marketplace/tool-b', name: 'tool-b', trust: 'community' },
      { id: 'community-marketplace/tool-c', name: 'tool-c', trust: 'community' },
    ],
  };

  it('fresh community present → official + fresh (previous ignored)', () => {
    const out = mergeWithCarryForward(official, freshCommunity, previousIndex);
    expect(out.map((e) => e.id).sort()).toEqual([
      'anthropic-skills/pdf',
      'community-marketplace/tool-a',
      'official-marketplace/x',
    ]);
  });

  it('community fetch failed (null) → carries forward the PREVIOUS community slice', () => {
    const out = mergeWithCarryForward(official, null, previousIndex);
    expect(out.filter((e) => e.trust === 'community').map((e) => e.name).sort()).toEqual([
      'tool-b',
      'tool-c',
    ]);
    // Official slice is the FRESH one, never the previous file's.
    expect(out.filter((e) => e.trust === 'official').map((e) => e.name).sort()).toEqual(['pdf', 'x']);
  });

  it('community failed AND no previous index → official-only', () => {
    expect(mergeWithCarryForward(official, null, null)).toEqual(official);
  });

  it('merged output is deterministic through buildIndex (id-sorted)', () => {
    const merged = mergeWithCarryForward(official, freshCommunity, null);
    const index = buildIdx(merged, [], Date.parse('2026-07-02T00:00:00.000Z'));
    const ids = index.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });
});
