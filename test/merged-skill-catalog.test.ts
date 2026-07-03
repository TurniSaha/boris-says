import { describe, it, expect } from 'vitest';
import { createMergedSkillCatalog } from '../src/capability/merged-skill-catalog.js';
import { CURATED_SKILLS } from '../src/capability/scan-skills.js';
import {
  runQualityCascade,
  type MergedSkillCatalog,
  type QualityCascadeInput,
} from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL } from '../src/brain/prompt-coach-skill.js';
import { defaultState } from '../src/state/store.js';
import type { LlmBackend } from '../src/llm/backend.js';

describe('createMergedSkillCatalog — resolveAction', () => {
  it('installed skill -> { kind: "run" }', () => {
    const cat = createMergedSkillCatalog(['my-installed-skill'], ['curated-only']);
    expect(cat.resolveAction('my-installed-skill')).toEqual({
      kind: 'run',
      skillId: 'my-installed-skill',
    });
  });

  it('curated-but-not-installed skill -> { kind: "install_run" }', () => {
    const cat = createMergedSkillCatalog([], ['database-migrations']);
    expect(cat.resolveAction('database-migrations')).toEqual({
      kind: 'install_run',
      skillId: 'database-migrations',
    });
  });

  it('unknown skill (neither installed nor curated) -> { kind: "none" }', () => {
    const cat = createMergedSkillCatalog(['a'], ['b']);
    expect(cat.resolveAction('c')).toEqual({ kind: 'none' });
  });

  it('installed wins over curated for the same id (run, not install_run)', () => {
    const cat = createMergedSkillCatalog(['database-migrations'], ['database-migrations']);
    expect(cat.resolveAction('database-migrations')).toEqual({
      kind: 'run',
      skillId: 'database-migrations',
    });
  });

  it('resolveAction is case-folded', () => {
    const cat = createMergedSkillCatalog(['Grill-Me'], []);
    expect(cat.resolveAction('grill-me').kind).toBe('run');
  });

  it('empty id -> none', () => {
    const cat = createMergedSkillCatalog(['x'], ['y']);
    expect(cat.resolveAction('   ').kind).toBe('none');
  });

  it('database-migrations from the real CURATED_SKILLS resolves install_run when not installed', () => {
    const cat = createMergedSkillCatalog([]); // defaults to CURATED_SKILLS
    expect(CURATED_SKILLS).toContain('database-migrations');
    expect(cat.resolveAction('database-migrations')).toEqual({
      kind: 'install_run',
      skillId: 'database-migrations',
    });
  });
});

describe('createMergedSkillCatalog — all (rendered list)', () => {
  it('is the deduped, sorted union of installed + curated', () => {
    const cat = createMergedSkillCatalog(['zeta', 'alpha'], ['alpha', 'beta']);
    expect(cat.all).toEqual(['alpha', 'beta', 'zeta']);
  });
});

describe('createMergedSkillCatalog — satisfies the cascade seam', () => {
  // A tiny compile/usage test: the returned object is assignable to MergedSkillCatalog
  // and runQualityCascade accepts it with no change.
  it('is a valid MergedSkillCatalog the cascade compiles + runs against', async () => {
    const cat: MergedSkillCatalog = createMergedSkillCatalog(['grill-me']);
    // A null backend short-circuits the LLM tiers; we only prove the seam type-checks
    // and the cascade runs without complaint.
    const nullBackend: LlmBackend = {
      configured: false,
      async complete() {
        return null;
      },
    };
    const input: QualityCascadeInput = {
      prompt: 'build a whole dashboard from scratch please',
      transcript: [],
      backend: nullBackend,
      skill: PROMPT_COACH_SKILL,
      state: defaultState(),
      catalog: cat,
      capabilities: [],
      sessionId: 'sess-seam',
      now: () => 1,
    };
    const res = await runQualityCascade(input);
    // null backend -> prospector unavailable -> no COACHING tip fires (the only surface
    // is the additive first-prompt liveness ping). The point is the seam type-checks and
    // the cascade runs cleanly against it; a fired coaching tip would carry a `lever`.
    expect(res === null || res.lever === undefined).toBe(true);
  });
});
