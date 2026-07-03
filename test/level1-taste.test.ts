/**
 * level1-taste.test.ts — W2-LEVEL1 taste-conditioning (the live judge learns the owner's
 * 👍/👎 phrasings via in-context few-shot examples; NO model training).
 *
 * The load-bearing guards (docs/DESIGN-level1-taste-conditioning.md §6):
 *   1. COLD START: below the floor → buildJudgeUser output is byte-identical to pre-Level-1.
 *   2. SELECTION purity: deterministic, dedups, consistency-filters, polarity-balances, caps.
 *   3. The section RENDERS with the right examples + the advisory framing.
 *   4. DANGEROUS-PROMPT FLOOR (CRITICAL): a heavy all-👎 history must NOT suppress a fire on a
 *      genuinely destructive prompt — the precision wall holds for safety-critical levers.
 *   5. κ ISOLATION: the offline κ-calibration path never reads the live feedback corpus.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFeedbackAnchors,
  selectTasteExamples,
  renderTasteSection,
  DEFAULT_TASTE_OPTIONS,
  type TasteExample,
} from '../src/brain/taste.js';
import { buildJudgeUser } from '../src/brain/prompt-coach-skill.js';
import { runQualityCascade, type QualityCascadeInput, type MergedSkillCatalog } from '../src/brain/judge-cascade.js';
import { PROMPT_COACH_SKILL } from '../src/brain/prompt-coach-skill.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';
import type { FeedbackAnchor } from '../src/coach-cmd.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let clock = 1_000_000;
function anchor(over: Partial<FeedbackAnchor> = {}): FeedbackAnchor {
  clock += 1000;
  return {
    lever: 'process_fit',
    prompt: 'implement the new semver parser from scratch',
    sessionId: 's1',
    rating: 'bad',
    goldVerdict: 'SILENT',
    at: clock,
    ...over,
  };
}

/** N anchors on one lever (so it passes the consistency filter), all same polarity. */
function nAnchors(n: number, over: Partial<FeedbackAnchor> = {}): FeedbackAnchor[] {
  return Array.from({ length: n }, (_, i) =>
    anchor({ ...over, prompt: `${over.prompt ?? 'prompt'} variant ${i}` }),
  );
}

// ── 1. COLD START — byte-identical parity ────────────────────────────────────

describe('W2-LEVEL1 — cold-start parity', () => {
  const args = [
    'their LATEST prompt verbatim',
    ['earlier prompt'],
    'a rolling summary',
    ['skill-a', 'skill-b'],
    ['--effort xhigh (cli_flag, launch): raise effort'],
  ] as const;

  it('buildJudgeUser with NO taste section == buildJudgeUser with empty taste section (default param)', () => {
    const withoutParam = buildJudgeUser(...args);
    const withEmpty = buildJudgeUser(...args, '');
    expect(withEmpty).toBe(withoutParam);
  });

  it('selectTasteExamples returns [] below the cold-start floor → renderTasteSection is "" → omitted', () => {
    const few = nAnchors(DEFAULT_TASTE_OPTIONS.minAnchors - 1, { lever: 'a' });
    const examples = selectTasteExamples(few, clock);
    expect(examples).toEqual([]);
    expect(renderTasteSection(examples)).toBe('');
    // And the built prompt is byte-identical to the no-taste form.
    expect(buildJudgeUser(...args, renderTasteSection(examples))).toBe(buildJudgeUser(...args));
  });
});

// ── 2. SELECTION purity ──────────────────────────────────────────────────────

describe('W2-LEVEL1 — selectTasteExamples purity', () => {
  it('is deterministic (same input → same output)', () => {
    const anchors = [...nAnchors(4, { lever: 'x', rating: 'bad', goldVerdict: 'SILENT' })];
    const a = selectTasteExamples(anchors, 5_000_000);
    const b = selectTasteExamples(anchors, 5_000_000);
    expect(a).toEqual(b);
  });

  it('does NOT mutate the input array', () => {
    const anchors = [...nAnchors(6, { lever: 'x' })];
    const snapshot = anchors.map((a) => ({ ...a }));
    selectTasteExamples(anchors, 9_000_000);
    expect(anchors).toEqual(snapshot);
  });

  it('consistency filter: drops anchors whose lever has < minLeverRatings ratings', () => {
    // 5 anchors total (passes the floor), but lever "rare" has only 1 rating (< 3) → dropped;
    // lever "steady" has 4 → kept.
    const anchors = [
      ...nAnchors(4, { lever: 'steady', rating: 'bad', goldVerdict: 'SILENT' }),
      anchor({ lever: 'rare', prompt: 'a one-off rare-lever prompt', rating: 'bad', goldVerdict: 'SILENT' }),
    ];
    const picked = selectTasteExamples(anchors, clock);
    expect(picked.every((e) => e.lever === 'steady')).toBe(true);
    expect(picked.some((e) => e.lever === 'rare')).toBe(false);
  });

  it('dedups near-identical prompts (same normalized prefix → one example)', () => {
    const dupPrompt = 'Refactor   the   AUTH   module';
    const anchors = [
      anchor({ lever: 'x', prompt: dupPrompt, at: 100 }),
      anchor({ lever: 'x', prompt: 'refactor the auth module', at: 200 }), // same key (folded)
      anchor({ lever: 'x', prompt: 'refactor the auth module ', at: 300 }),
      ...nAnchors(2, { lever: 'x' }), // pad to pass floor + lever-count
    ];
    const picked = selectTasteExamples(anchors, clock);
    const authCount = picked.filter((e) => e.prompt.toLowerCase().includes('refactor the auth module')).length;
    expect(authCount).toBe(1);
  });

  it('caps example count at maxExamples', () => {
    const anchors = nAnchors(40, { lever: 'x', rating: 'bad', goldVerdict: 'SILENT' });
    const picked = selectTasteExamples(anchors, clock);
    expect(picked.length).toBeLessThanOrEqual(DEFAULT_TASTE_OPTIONS.maxExamples);
  });

  it('caps each prompt at maxPromptChars (with an ellipsis)', () => {
    const long = 'x'.repeat(500);
    const anchors = nAnchors(5, { lever: 'x', prompt: long });
    const picked = selectTasteExamples(anchors, clock);
    for (const e of picked) {
      expect(e.prompt.length).toBeLessThanOrEqual(DEFAULT_TASTE_OPTIONS.maxPromptChars + 1); // +1 for the ellipsis char
      expect(e.prompt.endsWith('…')).toBe(true);
    }
  });

  it('polarity balance: a lopsided 👎 history cannot fill the WHOLE budget when 👍 exist', () => {
    const anchors = [
      ...nAnchors(20, { lever: 'sil', rating: 'bad', goldVerdict: 'SILENT' }),
      ...nAnchors(4, { lever: 'nud', rating: 'good', goldVerdict: 'NUDGE' }),
    ];
    const picked = selectTasteExamples(anchors, clock);
    const nudges = picked.filter((e) => e.goldVerdict === 'NUDGE').length;
    expect(nudges).toBeGreaterThan(0); // the 👍 side is represented, not crowded out.
  });

  it('newest-first ordering within a polarity', () => {
    const anchors = [
      anchor({ lever: 'x', prompt: 'OLD one', at: 1 }),
      anchor({ lever: 'x', prompt: 'NEW one', at: 9_999_999 }),
      ...nAnchors(3, { lever: 'x' }),
    ];
    const picked = selectTasteExamples(anchors, clock);
    const newIdx = picked.findIndex((e) => e.prompt.includes('NEW one'));
    const oldIdx = picked.findIndex((e) => e.prompt.includes('OLD one'));
    expect(newIdx).toBeGreaterThanOrEqual(0);
    if (oldIdx >= 0) expect(newIdx).toBeLessThan(oldIdx);
  });
});

// ── 3. The section RENDERS ───────────────────────────────────────────────────

describe('W2-LEVEL1 — renderTasteSection', () => {
  const examples: TasteExample[] = [
    { prompt: 'fix the typo in the header', goldVerdict: 'SILENT', lever: 'process_fit' },
    { prompt: 'rewrite the auth flow', goldVerdict: 'NUDGE', lever: 'risk_awareness' },
  ];

  it('renders both polarities with the lever attribution', () => {
    const s = renderTasteSection(examples);
    expect(s).toContain('did NOT want coaching');
    expect(s).toContain('fix the typo in the header');
    expect(s).toContain('process_fit');
    expect(s).toContain('DID want coaching');
    expect(s).toContain('rewrite the auth flow');
    expect(s).toContain('risk_awareness');
  });

  it('carries the ADVISORY framing + the never-suppress-risky guard (the precision-wall guarantee in prose)', () => {
    const s = renderTasteSection(examples).toLowerCase();
    expect(s).toContain('advisory');
    expect(s).toMatch(/never|not let them suppress/);
    expect(s).toMatch(/risky|destructive/);
  });

  it('empty examples → "" (so the section is omitted)', () => {
    expect(renderTasteSection([])).toBe('');
  });
});

// ── 4. DANGEROUS-PROMPT FLOOR (CRITICAL) ─────────────────────────────────────

describe('W2-LEVEL1 — the dangerous-prompt floor (precision wall holds)', () => {
  const emptyCatalog: MergedSkillCatalog = { all: [], resolveAction: () => ({ kind: 'none' }) };

  function fireVerdict(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      phase: 'new-task',
      dimension_scores: { risk_awareness: 0.1 },
      missing_piece: 'no reversibility plan for a destructive op',
      risk_level: 'high',
      skill_fit: { candidate_skill: null, confidence: 0 },
      capability_fit: { candidate_capability: null, confidence: 0 },
      interrupt: true,
      confidence: 0.9,
      primary_lever: 'risk_awareness',
      nudge: 'this force-push rewrites shared history — branch first / confirm the blast radius',
      ...over,
    });
  }

  function backend(judge: string, capture?: { judgeUser?: string }): LlmBackend {
    return {
      configured: true,
      async complete(opts: LlmCompleteOptions): Promise<string | null> {
        if (opts.model === 'haiku') return '0.9'; // prospector escalates.
        if (capture) capture.judgeUser = opts.user;
        return judge;
      },
    };
  }

  let sid = 0;
  function input(over: Partial<QualityCascadeInput> = {}): QualityCascadeInput {
    sid += 1;
    const state: CoachState = defaultState();
    return {
      prompt: 'force push to main',
      transcript: ['earlier prompt'],
      backend: backend(fireVerdict()),
      skill: PROMPT_COACH_SKILL,
      state,
      catalog: emptyCatalog,
      capabilities: [],
      sessionId: `taste-${sid}`,
      now: () => 2_000_000,
      ...over,
    };
  }

  it('a heavy all-👎 taste history is rendered into the judge input AS ADVISORY, not as a suppressor', async () => {
    const sessionId = `taste-prime-${sid}`;
    // prime away the first-seen ping.
    await runQualityCascade(input({ prompt: 'prime', sessionId }));
    const capture: { judgeUser?: string } = {};
    const heavyBad: TasteExample[] = nAnchors(12, { lever: 'process_fit', rating: 'bad', goldVerdict: 'SILENT' })
      .map((a) => ({ prompt: a.prompt, goldVerdict: 'SILENT' as const, lever: a.lever }));
    await runQualityCascade(
      input({ sessionId, transcript: ['prime'], backend: backend(fireVerdict(), capture), tasteExamples: heavyBad }),
    );
    // The section is present AND carries the explicit guard the judge reads.
    expect(capture.judgeUser).toBeDefined();
    expect(capture.judgeUser!.toLowerCase()).toContain('advisory');
    expect(capture.judgeUser!.toLowerCase()).toMatch(/risky|destructive/);
  });

  it('with a heavy 👎 history present, a HIGH-risk fire verdict STILL deposits a tip (taste does not gate the cascade)', async () => {
    const sessionId = `taste-fire-${sid}`;
    await runQualityCascade(input({ prompt: 'prime', sessionId }));
    const heavyBad: TasteExample[] = nAnchors(12, { lever: 'process_fit', goldVerdict: 'SILENT' })
      .map((a) => ({ prompt: a.prompt, goldVerdict: 'SILENT' as const, lever: a.lever }));
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'force push to main and delete the backup branch',
        backend: backend(fireVerdict()),
        tasteExamples: heavyBad,
      }),
    );
    // The fire survives: taste examples are advisory context, NOT a firing gate. The cascade
    // still deposits the high-risk tip exactly as it would with no taste history.
    expect(res).not.toBeNull();
    expect(res?.lever).toBe('risk_awareness');
  });

  it('the SAME fire deposits identically with NO taste history (control) — taste did not change the deposit', async () => {
    const sessionId = `taste-control-${sid}`;
    await runQualityCascade(input({ prompt: 'prime', sessionId }));
    const res = await runQualityCascade(
      input({
        sessionId,
        transcript: ['prime'],
        prompt: 'force push to main and delete the backup branch',
        backend: backend(fireVerdict()),
        // no tasteExamples
      }),
    );
    expect(res).not.toBeNull();
    expect(res?.lever).toBe('risk_awareness');
  });
});

// ── 5. κ ISOLATION ───────────────────────────────────────────────────────────

describe('W2-LEVEL1 — κ isolation (the offline judge never reads the live taste corpus)', () => {
  it('no file anywhere under eval/ imports taste.js or reads feedback-anchors.jsonl', () => {
    // The guarantee names the WHOLE eval/ tree — the κ-calibration runners
    // (eval/calibrate-kappa.mjs, eval/run-matrix.mjs, eval/tune-loop.mjs) live in eval/ ROOT,
    // not eval/harness/. Walking only eval/harness/ would give false assurance: a
    // teach-to-the-test import added to the ROOT runner would pass undetected. So walk eval/.
    //
    // PUBLIC-EXPORT NOTE: the offline eval/ harness is a dev-only tree that is NOT
    // shipped in the public repo. When it is absent there is nothing to guard, so the
    // check is a no-op here; it stays active in the development repo where eval/ exists.
    const dir = join(process.cwd(), 'eval');
    if (!existsSync(dir)) {
      // The dev-only eval/ tree is not shipped in the public export — nothing to guard.
      expect(existsSync(dir)).toBe(false);
      return;
    }
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(mjs|js|ts)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        if (text.includes('feedback-anchors') || /from ['"].*\/taste(\.js)?['"]/.test(text)) {
          offenders.push(full);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});

// ── 6. parseFeedbackAnchors tolerance ────────────────────────────────────────

describe('W2-LEVEL1 — parseFeedbackAnchors (tolerant, never throws)', () => {
  it('parses well-formed lines, skips blanks + corrupt lines + wrong-shaped objects', () => {
    const good = JSON.stringify(anchor({ lever: 'a' }));
    const text = [
      good,
      '',
      '   ',
      'not json at all {',
      JSON.stringify({ lever: 'b' }), // missing required fields → dropped
      JSON.stringify({ ...anchor({ lever: 'c' }), rating: 'maybe' }), // bad rating → dropped
    ].join('\n');
    const parsed = parseFeedbackAnchors(text);
    expect(parsed.length).toBe(1);
    expect(parsed[0].lever).toBe('a');
  });

  it('empty / null / undefined → []', () => {
    expect(parseFeedbackAnchors('')).toEqual([]);
    expect(parseFeedbackAnchors(null)).toEqual([]);
    expect(parseFeedbackAnchors(undefined)).toEqual([]);
  });

  it('a bare `null` / number / string / array JSONL line is skipped, NEVER throws (the contract)', () => {
    // JSON.parse('null') returns null — without the object guard this threw a TypeError on
    // the field access (the adversarial-verifier finding). Same for other non-object literals.
    const good = JSON.stringify(anchor({ lever: 'a' }));
    const text = ['null', '42', '"a string"', '[1,2,3]', 'true', good].join('\n');
    expect(() => parseFeedbackAnchors(text)).not.toThrow();
    const parsed = parseFeedbackAnchors(text);
    expect(parsed.length).toBe(1);
    expect(parsed[0].lever).toBe('a');
  });
});

describe('W2-LEVEL1 — dedup keeps opposite-polarity prompts that share a long prefix', () => {
  it('two prompts with the same 60+ char opening but OPPOSITE verdicts are BOTH kept', () => {
    const shared = 'Implement the authentication middleware for the admin dashboard using ';
    const anchors = [
      anchor({ lever: 'x', prompt: `${shared}JWT`, rating: 'bad', goldVerdict: 'SILENT', at: 100 }),
      anchor({ lever: 'x', prompt: `${shared}sessions`, rating: 'good', goldVerdict: 'NUDGE', at: 200 }),
      ...nAnchors(3, { lever: 'x' }), // pad past the floor + lever-count.
    ];
    const picked = selectTasteExamples(anchors, clock);
    const hasSilent = picked.some((e) => e.goldVerdict === 'SILENT' && e.prompt.includes('authentication middleware'));
    const hasNudge = picked.some((e) => e.goldVerdict === 'NUDGE' && e.prompt.includes('authentication middleware'));
    expect(hasSilent).toBe(true);
    expect(hasNudge).toBe(true); // the opposite-polarity counterexample is NOT dropped.
  });
});
