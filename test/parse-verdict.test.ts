/**
 * parse-verdict (brain/parse-verdict.ts): the pure defensive parsers ported from
 * the upstream coach service judge-dispatch.ts. parseJudgeVerdict is fail-CLOSED (null on malformed);
 * parseProspectorScore is fail-OPEN (escalate on unparseable).
 */
import { describe, expect, it } from 'vitest';
import { parseJudgeVerdict, parseProspectorScore } from '../src/brain/parse-verdict.js';

describe('parseProspectorScore — fail-OPEN', () => {
  it('parses a bare number', () => {
    expect(parseProspectorScore('0.7')).toEqual({ score: 0.7, failOpen: false });
    expect(parseProspectorScore('0')).toEqual({ score: 0, failOpen: false });
  });

  it('extracts the first number from stray prose', () => {
    expect(parseProspectorScore('score: 0.42 (clear)').score).toBeCloseTo(0.42);
  });

  it('clamps out-of-range numbers to [0,1]', () => {
    expect(parseProspectorScore('1.5').score).toBe(1);
    expect(parseProspectorScore('-0.2').score).toBe(0);
  });

  it('fails OPEN (score 1) when no number is present', () => {
    expect(parseProspectorScore('not sure')).toEqual({ score: 1, failOpen: true });
    expect(parseProspectorScore('')).toEqual({ score: 1, failOpen: true });
  });
});

describe('parseJudgeVerdict — fail-CLOSED', () => {
  const valid = JSON.stringify({
    phase: 'new-task',
    dimension_scores: { goal_clarity: 0.2, scope_boundaries: 0.3 },
    missing_piece: 'no definition of done',
    risk_level: 'medium',
    skill_fit: { candidate_skill: 'security-review', confidence: 0.8 },
    capability_fit: { candidate_capability: '/design-sync', confidence: 0.6 },
    interrupt: true,
    confidence: 0.75,
    primary_lever: 'goal_clarity',
    nudge: 'what is the one concrete outcome here?',
  });

  it('parses a valid verdict', () => {
    const v = parseJudgeVerdict(valid);
    expect(v).not.toBeNull();
    expect(v!.phase).toBe('new-task');
    expect(v!.interrupt).toBe(true);
    expect(v!.confidence).toBe(0.75);
    expect(v!.primary_lever).toBe('goal_clarity');
    expect(v!.missing_piece).toBe('no definition of done');
    expect(v!.dimension_scores.goal_clarity).toBe(0.2);
    expect(v!.skill_fit.candidate_skill).toBe('security-review');
    expect(v!.capability_fit.candidate_capability).toBe('/design-sync');
  });

  it('extracts the first {...} block from surrounding prose', () => {
    const v = parseJudgeVerdict('Here is the verdict:\n' + valid + '\nThanks!');
    expect(v).not.toBeNull();
    expect(v!.phase).toBe('new-task');
  });

  it('returns null for an empty string', () => {
    expect(parseJudgeVerdict('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseJudgeVerdict('{ not valid json ]')).toBeNull();
    expect(parseJudgeVerdict('no braces at all')).toBeNull();
  });

  it('returns null when phase is missing/invalid (fail-closed)', () => {
    expect(parseJudgeVerdict(JSON.stringify({ interrupt: true }))).toBeNull();
    expect(parseJudgeVerdict(JSON.stringify({ phase: 'banana', interrupt: true }))).toBeNull();
  });

  it('coerces a missing nudge / empty missing_piece to null (the firing guards)', () => {
    const v = parseJudgeVerdict(
      JSON.stringify({ phase: 'ambiguous', missing_piece: '', nudge: '   ', interrupt: false, confidence: 0.1 }),
    );
    expect(v).not.toBeNull();
    expect(v!.missing_piece).toBeNull();
    expect(v!.nudge).toBeNull();
  });

  it('defaults a missing/malformed capability_fit + skill_fit to null/0', () => {
    const v = parseJudgeVerdict(JSON.stringify({ phase: 'new-task', interrupt: false }));
    expect(v!.skill_fit).toEqual({ candidate_skill: null, confidence: 0 });
    expect(v!.capability_fit).toEqual({ candidate_capability: null, confidence: 0 });
    expect(v!.risk_level).toBe('low');
  });
});
