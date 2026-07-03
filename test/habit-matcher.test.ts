/**
 * habit/matcher.ts — the deterministic §7.4 trigger matcher + composeHabitTip + the
 * optional §5.5.6c fuzzy fallback. The core matcher is pure/no-LLM; the fallback is
 * tested with a mocked LlmBackend.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  matchHabit,
  composeHabitTip,
  fuzzyFallback,
  looksHandoffish,
  normalize,
  anchorTokens,
} from '../src/habit/matcher.js';
import type { Pattern } from '../src/habit/patterns-store.js';
import type { LlmBackend } from '../src/llm/backend.js';

function mkPattern(over: Partial<Pattern> = {}): Pattern {
  return {
    habit_key: 'context-handoff:next-session-prompt',
    trigger: 'prompt_recurring:context-handoff:next-session-prompt',
    match_phrases: ['give me the prompt for the next session'],
    anchorSignature: ['give', 'me', 'the', 'prompt', 'for', 'next', 'session'],
    habit: 'asked for a next-session prompt',
    fix: 'bake a prompt-handoff into your /context-handoff command',
    why_inefficient: 'retypes a handoff every session',
    occurrences: [
      { sessionId: 'a', ts: 1, evidence: 'give me the prompt for the next session' },
      { sessionId: 'b', ts: 2, evidence: 'give me the prompt for the next session please' },
      { sessionId: 'c', ts: 3, evidence: 'can you give me the prompt for the next session' },
    ],
    occurrenceCount: 3,
    confidence: 0.8,
    status: 'open',
    createdAt: 100,
    surfacedAt: null,
    ...over,
  };
}

function mockBackend(answers: (string | null)[], configured = true): LlmBackend {
  let i = 0;
  return {
    configured,
    complete: vi.fn(async () => answers[i++] ?? null),
  };
}

describe('normalize + anchorTokens mirror coach-liveness', () => {
  it('normalize trims, collapses whitespace, lowercases', () => {
    expect(normalize('  Give  Me\tThe  PROMPT ')).toBe('give me the prompt');
  });
  it('anchorTokens splits on non-word chars into whole-word tokens', () => {
    expect(anchorTokens('next-session prompt!')).toEqual(['next', 'session', 'prompt']);
  });
});

describe('matchHabit — §7.4 exact equality (rule i)', () => {
  it('fires on exact equality modulo whitespace/case', () => {
    const p = mkPattern();
    expect(matchHabit('  Give me the prompt for the NEXT session  ', [p])).toBe(p);
  });
  it('fires by exact equality even for a short (<4-token) phrase', () => {
    const p = mkPattern({ match_phrases: ['ship it'] });
    expect(matchHabit('Ship it', [p])).toBe(p);
  });
});

describe('matchHabit — §7.4 whole-word containment (rule ii, >=4 tokens)', () => {
  it('fires when a >=4-token phrase anchor tokens all appear as whole words', () => {
    const p = mkPattern({ match_phrases: ['next session prompt handoff'] });
    // All four tokens present as whole words, embedded in a longer prompt.
    expect(
      matchHabit('hey can you write the next session prompt handoff for me', [p]),
    ).toBe(p);
  });

  it('does NOT fire on a short raw-substring coincidence (short phrase needs exact equality)', () => {
    // 3-token phrase "add the index" appears as a substring of a longer prompt, but
    // a <4-token phrase requires EXACT equality — must NOT fire.
    const p = mkPattern({ match_phrases: ['add the index'] });
    expect(matchHabit('please add the index to the orders table now', [p])).toBeNull();
  });

  it('does NOT fire when a >=4-token phrase is only a raw substring, not whole words', () => {
    // "session" token absent as a whole word: "sessions" must not satisfy "session".
    const p = mkPattern({ match_phrases: ['the next session prompt'] });
    expect(matchHabit('the next sessions prompt list', [p])).toBeNull();
  });

  it('does NOT fire when not all anchor tokens are present', () => {
    const p = mkPattern({ match_phrases: ['next session prompt handoff'] });
    expect(matchHabit('give me the next session summary', [p])).toBeNull();
  });
});

describe('matchHabit — negatives + status gating', () => {
  it('does NOT fire on an unrelated prompt', () => {
    expect(matchHabit('refactor the auth module', [mkPattern()])).toBeNull();
  });
  it('skips non-open patterns (surfaced/dismissed never re-fire)', () => {
    expect(
      matchHabit('give me the prompt for the next session', [mkPattern({ status: 'surfaced' })]),
    ).toBeNull();
    expect(
      matchHabit('give me the prompt for the next session', [mkPattern({ status: 'dismissed' })]),
    ).toBeNull();
  });
  it('returns null on an empty prompt', () => {
    expect(matchHabit('   ', [mkPattern()])).toBeNull();
  });
});

describe('matchHabit — the canonical golden case (§5.5.8 #17)', () => {
  it('the canonical "give me the prompt for the next session" fires on the stored phrase', () => {
    const p = mkPattern();
    expect(matchHabit('give me the prompt for the next session', [p])).toBe(p);
  });
});

describe('composeHabitTip — cites the count + fix (§7.4/§7.5 #2)', () => {
  it('names WHEN (the count) and the concrete fix', () => {
    const tip = composeHabitTip(mkPattern(), 3);
    expect(tip).toContain('in your last 3 sessions');
    expect(tip).toContain('bake a prompt-handoff into your /context-handoff command');
    expect(tip).toContain('asked for a next-session prompt');
  });
  it('singularizes "session" for a count of 1', () => {
    expect(composeHabitTip(mkPattern(), 1)).toContain('in your last 1 session —');
  });

  it('a draft-less pattern tip is byte-identical to the pre-M3 format (no /coach build)', () => {
    const tip = composeHabitTip(mkPattern(), 3);
    expect(tip).toBe(
      "🐾 PM: you've asked for a next-session prompt in your last 3 sessions — " +
        'bake a prompt-handoff into your /context-handoff command.',
    );
    expect(tip).not.toContain('/coach build');
  });

  it('a draft-bearing pattern tip offers /coach build with the kind label (M3)', () => {
    const p = mkPattern({
      draft: { kind: 'skill', name: 'context-handoff', content: '---\nname: x\ndescription: d\n---\nbody', createdAt: 1 },
    });
    const tip = composeHabitTip(p, 3);
    // The relevance invariant: still opens with the habit + session count.
    expect(tip).toContain('asked for a next-session prompt');
    expect(tip).toContain('in your last 3 sessions');
    expect(tip).toContain('a draft skill is ready: run /coach build to write it for review (or /coach dismiss to reject)');
  });

  it('labels a claude_md_rule draft as a CLAUDE.md rule and a hook draft as a hook', () => {
    const rule = mkPattern({ draft: { kind: 'claude_md_rule', name: 'r', content: '## x\n- y', createdAt: 1 } });
    expect(composeHabitTip(rule, 3)).toContain('a draft CLAUDE.md rule is ready');
    const hook = mkPattern({ draft: { kind: 'hook', name: 'h', content: '#!/bin/sh\ntrue', createdAt: 1 } });
    expect(composeHabitTip(hook, 3)).toContain('a draft hook is ready');
  });
});

describe('looksHandoffish — cheap pre-filter for the fuzzy fallback', () => {
  it('true for handoff-ish prompts', () => {
    expect(looksHandoffish('what should I do in the next session?')).toBe(true);
    expect(looksHandoffish('give me a handoff summary')).toBe(true);
  });
  it('false for an ordinary task prompt', () => {
    expect(looksHandoffish('refactor the auth module')).toBe(false);
  });
});

describe('fuzzyFallback — §5.5.6c, behind the lexical matcher', () => {
  it('does NOT call the backend when the lexical matcher already matches', async () => {
    const backend = mockBackend(['yes']);
    const p = mkPattern();
    const result = await fuzzyFallback('give me the prompt for the next session', [p], backend);
    expect(result).toBeNull(); // lexical already matched -> fallback no-ops
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('does NOT call the backend when the prompt is not handoff-ish', async () => {
    const backend = mockBackend(['yes']);
    const result = await fuzzyFallback('refactor the auth module', [mkPattern()], backend);
    expect(result).toBeNull();
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('does NOT call the backend when unconfigured', async () => {
    const backend = mockBackend(['yes'], false);
    const result = await fuzzyFallback('wrap up the next session for me first', [mkPattern()], backend);
    expect(result).toBeNull();
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('fires ONE Haiku call on a handoff-ish novel phrasing and returns the affirmed pattern', async () => {
    const backend = mockBackend(['yes']);
    const p = mkPattern();
    // Handoff-ish, but NOT a lexical match (no shared >=4-token whole-word set / not exact).
    const result = await fuzzyFallback('can you wrap up where we left off for tomorrow', [p], backend);
    expect(result).toBe(p);
    expect(backend.complete).toHaveBeenCalledTimes(1);
    expect((backend.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].model).toBe('haiku');
  });

  it('returns null when the model answers no', async () => {
    const backend = mockBackend(['no']);
    const result = await fuzzyFallback('wrap up where we left off for the next session', [mkPattern()], backend);
    expect(result).toBeNull();
  });
});
