import { describe, expect, it } from 'vitest';
import {
  PROMPT_COACH_SKILL,
  RUBRIC_DIMENSIONS,
  INTERRUPT_ELIGIBLE_PHASES,
  PROSPECTOR_SYSTEM,
  JUDGE_SYSTEM,
  PROSPECTOR_ESCALATE_BAND,
  FIRING,
  buildProspectorUser,
  buildJudgeUser,
} from '../src/brain/prompt-coach-skill.js';

/**
 * THE RUBRIC IS A VERSIONED SKILL ARTIFACT — rubric data + system prompts, editable
 * without a redeploy. Ported from the upstream coach service pm-service/test/prompt-coach-skill.test.ts,
 * plus the §5.5 DATA-presence assertions (the §5.5 prompt edits are wording, so we assert
 * the load-bearing phrases are PRESENT in the system prompts).
 */
describe('prompt-coach skill artifact (versioned rubric)', () => {
  it('is a versioned bundle of rubric + system prompts + firing bar', () => {
    expect(PROMPT_COACH_SKILL.version).toMatch(/^prompt-coach@/);
    expect(PROMPT_COACH_SKILL.dimensions.length).toBeGreaterThan(0);
    expect(PROMPT_COACH_SKILL.prospectorSystem.length).toBeGreaterThan(0);
    expect(PROMPT_COACH_SKILL.judgeSystem.length).toBeGreaterThan(0);
    expect(PROMPT_COACH_SKILL.preRunConfidence).toBeGreaterThan(0);
    expect(PROMPT_COACH_SKILL.preRunConfidence).toBeLessThanOrEqual(1);
    expect(PROMPT_COACH_SKILL.postMinConfidence).toBeLessThan(PROMPT_COACH_SKILL.preRunConfidence);
  });

  it('exposes the exact BALANCED firing constants (0.8 / 0.45 / 0.35)', () => {
    expect(FIRING.PRE_RUN_CONFIDENCE).toBe(0.8);
    expect(FIRING.POST_MIN_CONFIDENCE).toBe(0.45);
    expect(PROSPECTOR_ESCALATE_BAND).toBe(0.35);
    expect(PROMPT_COACH_SKILL.preRunConfidence).toBe(FIRING.PRE_RUN_CONFIDENCE);
    expect(PROMPT_COACH_SKILL.postMinConfidence).toBe(FIRING.POST_MIN_CONFIDENCE);
    expect(PROMPT_COACH_SKILL.prospectorEscalateBand).toBe(PROSPECTOR_ESCALATE_BAND);
  });

  it('has exactly the 9 rubric dimensions in order', () => {
    expect(RUBRIC_DIMENSIONS.map((d) => d.id)).toEqual([
      'goal_clarity',
      'scope_boundaries',
      'context_sufficiency',
      'process_fit',
      'acceptance_criteria',
      'risk_awareness',
      'verification_path',
      'effort_level_fit',
      'skill_fit',
    ]);
  });

  it('effort-level-fit probe names xhigh + aligns to the gated family set, no GPT-5.5/Codex leftover', () => {
    const effort = RUBRIC_DIMENSIONS.find((d) => d.id === 'effort_level_fit');
    expect(effort).toBeDefined();
    expect(effort!.probe).toMatch(/effort/i);
    expect(effort!.probe).toMatch(/xhigh/i);
    // Item 4: the "for GPT-5.5 Codex use medium/high" leftover is DELETED, and the family
    // list matches the capability catalog's gated set (no Codex — it lacks xhigh).
    expect(effort!.probe).not.toMatch(/gpt-?5\.5/i);
    expect(effort!.probe).not.toMatch(/codex/i);
    expect(effort!.probe).toMatch(/fable|sonnet 5|mythos/i);
  });

  it('includes the transcript-aware context-sufficiency dimension (terse+anchored = fine)', () => {
    const ctx = RUBRIC_DIMENSIONS.find((d) => d.id === 'context_sufficiency');
    expect(ctx).toBeDefined();
    expect(ctx!.probe.toLowerCase()).toContain('transcript');
  });

  it('marks ONLY new-task/escalation/ambiguous as interrupt-eligible (THE precision lever)', () => {
    expect(INTERRUPT_ELIGIBLE_PHASES.has('new-task')).toBe(true);
    expect(INTERRUPT_ELIGIBLE_PHASES.has('escalation')).toBe(true);
    expect(INTERRUPT_ELIGIBLE_PHASES.has('ambiguous')).toBe(true);
    expect(INTERRUPT_ELIGIBLE_PHASES.has('continuation')).toBe(false);
    expect(INTERRUPT_ELIGIBLE_PHASES.has('correction')).toBe(false);
  });

  it('the prospector system prompt is suppress-only (no decision authority)', () => {
    const sys = PROMPT_COACH_SKILL.prospectorSystem.toLowerCase();
    expect(sys).toContain('not deciding whether to interrupt');
  });
});

/**
 * §5.5 DATA-PRESENCE: the §5.5 behavioral edits are PROMPT text (cannot be unit-asserted
 * against a real model here), so assert the load-bearing phrases are PRESENT in the
 * ported+edited system prompts.
 */
describe('§5.5 quality edits are present in the system prompts (DATA presence)', () => {
  it('bumps the version past @1 so outcomes attribute to the revised rubric', () => {
    expect(PROMPT_COACH_SKILL.version).not.toBe('prompt-coach@1');
    expect(PROMPT_COACH_SKILL.version).toBe('prompt-coach@2');
  });

  it('the STEP-7 characterization-test clause is scoped to EXISTING behavior (greenfield excluded)', () => {
    // Item 4: a "build X from scratch" prompt has no current behavior to pin.
    expect(JUDGE_SYSTEM).toMatch(/pin current behavior/i);
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('greenfield');
    expect(JUDGE_SYSTEM).toMatch(/nothing to characterize|no current behavior/i);
  });

  it('§5.5.1 JUDGE_SYSTEM has the escalation tie-break (higher-stakes phase wins)', () => {
    expect(JUDGE_SYSTEM).toContain('the higher-stakes phase always wins the tie');
    expect(JUDGE_SYSTEM).toContain('classify by the STAKES of the NEW work, not by the connective phrase');
    expect(JUDGE_SYSTEM).toContain('Ignore the opening connective');
  });

  it('§5.5.2 JUDGE_SYSTEM has the external-referent anchoring clause', () => {
    expect(JUDGE_SYSTEM).toContain('resolvable external referent');
    expect(JUDGE_SYSTEM).toContain('treat that context as ANCHORED, not missing');
    // mirrored in the rubric probe
    const ctx = RUBRIC_DIMENSIONS.find((d) => d.id === 'context_sufficiency')!;
    expect(ctx.probe).toContain('fetchable external artifact');
  });

  it('§5.5.3 JUDGE_SYSTEM has the banned-phrase bank and the risk-surface override', () => {
    expect(JUDGE_SYSTEM).toContain('BANNED phrasings');
    expect(JUDGE_SYSTEM).toContain('"scope it down"');
    expect(JUDGE_SYSTEM).toContain('"add more detail"');
    expect(JUDGE_SYSTEM).toContain('"decide what it shows"');
    expect(JUDGE_SYSTEM).toContain('RISK-SURFACE OVERRIDE');
    expect(JUDGE_SYSTEM).toContain('characterization test');
  });

  it('§5.5.4 JUDGE_SYSTEM has the expertise/pre-emption guard + named-method anchor', () => {
    expect(JUDGE_SYSTEM).toContain('EXPERTISE / PRE-EMPTION CHECK');
    expect(JUDGE_SYSTEM).toContain('git bisect');
    expect(JUDGE_SYSTEM).toContain('bump lodash to 4.17.21 and rerun the failing test');
    expect(JUDGE_SYSTEM).toContain('never second-guess a normal debug loop');
  });

  it('§5.5.4 PROSPECTOR_SYSTEM has the justified-hand-roll LOW clause', () => {
    expect(PROSPECTOR_SYSTEM).toContain('that is sound engineering, not blind reinvention');
    expect(PROSPECTOR_SYSTEM).toContain('SOUND PROCESS');
    expect(PROSPECTOR_SYSTEM).toContain('hand-write a small debounce');
    // the original no-rationale HIGH example MUST still be present (must still escalate)
    expect(PROSPECTOR_SYSTEM).toContain('hand-code all our design tokens');
  });

  it('§5.5.5 JUDGE_SYSTEM has the capability-fitness prompt rules', () => {
    expect(JUDGE_SYSTEM).toContain('do NOT recommend a launch-only capability');
    expect(JUDGE_SYSTEM).toContain('Never recommend an expensive multi-agent capability for an unbounded task');
    expect(JUDGE_SYSTEM).toContain('NEVER substitute a code-review capability');
    expect(JUDGE_SYSTEM).toContain('Shift+Tab');
    // the harmful "relaunch with --effort xhigh" steer was REMOVED from the example list
    expect(JUDGE_SYSTEM).not.toContain('relaunch with `--effort xhigh`');
  });
});

describe('prospector/judge user builders render the prompt + transcript', () => {
  it('buildProspectorUser puts the verbatim under "Latest prompt:" and lists the transcript', () => {
    const out = buildProspectorUser('make it faster', ['add caching', 'profile the loop']);
    expect(out).toContain('Latest prompt:\nmake it faster');
    expect(out).toContain('- add caching');
    expect(out).toContain('- profile the loop');
  });

  it('buildProspectorUser handles an empty transcript with "(none)"', () => {
    expect(buildProspectorUser('build a dashboard', [])).toContain('(none)');
  });

  it('buildJudgeUser renders profile/transcript/skills/capabilities/verbatim', () => {
    const out = buildJudgeUser('add auth', ['prior turn'], '', ['security-review'], ['/design-sync (slash): sync design [free]']);
    expect(out).toContain('Their LATEST prompt');
    expect(out).toContain('add auth');
    expect(out).toContain('- security-review');
    expect(out).toContain('- /design-sync (slash): sync design [free]');
    expect(out).toContain('- prior turn');
  });

  it('buildJudgeUser falls back when skills/capabilities/transcript are empty', () => {
    const out = buildJudgeUser('hi', [], '', [], []);
    expect(out).toContain('(none captured)');
    expect(out).toContain('(none available on this build)');
    expect(out).toContain('(none yet)');
  });
});

// ── M4 external-skill index — judge-prompt section (parity first) ─────────────

import { renderExternalSection } from '../src/brain/prompt-coach-skill.js';
import type { ExternalCandidate } from '../src/capability/skill-index.js';

function candidate(name: string, description = `${name} does things`): ExternalCandidate {
  return {
    name,
    description,
    install: `/plugin install ${name}@fixture`,
    sourceUrl: 'https://github.com/anthropics/skills',
    trust: 'official',
    repoStars: 100,
  };
}

describe('M4 buildJudgeUser external section (byte-parity + placement)', () => {
  const args = [
    'convert this report to a pptx deck',
    ['prior turn'],
    '',
    ['security-review'],
    ['/design-sync (slash): sync design [free]'],
    'taste section text',
  ] as const;

  it('BYTE-PARITY: omitting the param === passing empty string (index absent ⇒ unchanged input)', () => {
    const without = buildJudgeUser(args[0], args[1], args[2], args[3], args[4], args[5]);
    const withEmpty = buildJudgeUser(args[0], args[1], args[2], args[3], args[4], args[5], '');
    expect(withEmpty).toBe(without);
  });

  it('renders a non-empty external section BETWEEN capabilities and taste', () => {
    const section = renderExternalSection([candidate('pptx')]);
    const out = buildJudgeUser(args[0], args[1], args[2], args[3], args[4], args[5], section);
    const capIdx = out.indexOf('/design-sync');
    const extIdx = out.indexOf('- pptx:');
    const tasteIdx = out.indexOf('taste section text');
    expect(capIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeGreaterThan(capIdx);
    expect(tasteIdx).toBeGreaterThan(extIdx);
  });

  it('the external section header warns AT MOST ONE and NOT installed', () => {
    const section = renderExternalSection([candidate('pptx')]);
    expect(section).toContain('AT MOST ONE');
    expect(section).toContain('NOT installed');
  });
});

describe('M4 renderExternalSection', () => {
  it('[] → empty string (byte-parity guarantee flows from here)', () => {
    expect(renderExternalSection([])).toBe('');
  });

  it('5 candidates → 5 lines, each ≤ 160 chars', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate(`skill-${i}`, 'd'.repeat(500)),
    );
    const section = renderExternalSection(candidates);
    const lines = section.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(160);
  });

  it('6 in → 5 out (defensive re-clamp)', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => candidate(`skill-${i}`));
    const lines = renderExternalSection(candidates)
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(5);
  });

  it('defense-in-depth: control chars / ANSI escapes in candidate text never reach the judge', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const section = renderExternalSection([
      candidate(`evil${ESC}[31m-skill`, `wipes${ESC}[2J the${BEL} screen`),
    ]);
    expect(section).not.toContain(ESC);
    expect(section).not.toContain(BEL);
    expect(section).not.toContain('[31m'); // the CSI payload goes with the ESC.
    expect(section).not.toContain('[2J');
    expect(section).toContain('the screen'); // a control run collapses to ONE space.
  });
});

describe('M4 JUDGE_SYSTEM STEP-4b external clause (DATA presence)', () => {
  it('carries the load-bearing STEP-4b pins', () => {
    expect(JUDGE_SYSTEM).toContain('STEP 4b');
    expect(JUDGE_SYSTEM.toLowerCase()).toContain('external');
    expect(JUDGE_SYSTEM).toContain('AT MOST ONE');
    expect(JUDGE_SYSTEM).toContain('materially help');
    expect(JUDGE_SYSTEM).toContain('before this runs');
    expect(JUDGE_SYSTEM).toContain('prefer an installed skill or capability');
  });
});

import { resolveJudgeModel, DEFAULT_JUDGE_MODEL } from '../src/brain/prompt-coach-skill.js';

describe('judge model config (Opus default, env-overridable)', () => {
  it('defaults the judge to opus (sharpest advice)', () => {
    expect(DEFAULT_JUDGE_MODEL).toBe('opus');
    expect(PROMPT_COACH_SKILL.judgeModel).toBe('opus');
    expect(resolveJudgeModel({})).toBe('opus');
    expect(resolveJudgeModel({ PROMPT_COACH_JUDGE_MODEL: '' })).toBe('opus');
  });
  it('honors PROMPT_COACH_JUDGE_MODEL=sonnet (dial back subscription usage)', () => {
    expect(resolveJudgeModel({ PROMPT_COACH_JUDGE_MODEL: 'sonnet' })).toBe('sonnet');
    expect(resolveJudgeModel({ PROMPT_COACH_JUDGE_MODEL: 'SONNET' })).toBe('sonnet');
    expect(resolveJudgeModel({ PROMPT_COACH_JUDGE_MODEL: '  opus ' })).toBe('opus');
  });
  it('falls back to the default on an unrecognized value (a typo never breaks the cascade)', () => {
    expect(resolveJudgeModel({ PROMPT_COACH_JUDGE_MODEL: 'gpt-5' })).toBe('opus');
    expect(resolveJudgeModel({ PROMPT_COACH_JUDGE_MODEL: 'haiku' })).toBe('opus'); // judge is never haiku.
  });
});


// ── G-M4b: community trust labeling in the judge section ─────────────────────

describe('G-M4b renderExternalSection community labeling', () => {
  it('a community candidate is labeled `name (community):`; official is not', () => {
    const community = renderExternalSection([{ ...candidate('deck-tool'), trust: 'community' }]);
    expect(community).toContain('- deck-tool (community):');
    const official = renderExternalSection([candidate('deck-tool')]);
    expect(official).toContain('- deck-tool:');
    expect(official).not.toContain('(community)');
  });

  it('the header explains community = unverified third-party', () => {
    const section = renderExternalSection([{ ...candidate('deck-tool'), trust: 'community' }]);
    expect(section).toContain('community = unverified third-party');
    // The load-bearing pins survive the header change.
    expect(section).toContain('AT MOST ONE');
    expect(section).toContain('NOT installed');
  });

  it('official-only rendering keeps the parity `[]` → empty string', () => {
    expect(renderExternalSection([])).toBe('');
  });
});
