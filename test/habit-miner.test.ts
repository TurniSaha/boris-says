/**
 * habit/miner.ts — the throttled cross-session miner (§7.2) + the §5.5.6 quality
 * fixes (desirability/why_inefficient drop, dismissal-similarity Jaccard gate,
 * self-match calibration). The LlmBackend is mocked; the patterns store is a real
 * on-disk store in a tmp dir.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHabitMiner,
  MIN_NEW_EVENTS,
  MINE_COOLDOWN_MS,
  type MinerInput,
} from '../src/habit/miner.js';
import { createPatternsStore, type Pattern } from '../src/habit/patterns-store.js';
import { defaultState, type CoachState } from '../src/state/store.js';
import type { CorpusPrompt } from '../src/jsonl/corpus-reader.js';
import type { LlmBackend } from '../src/llm/backend.js';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-miner-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const NOW = 1_000_000_000_000;

function mockBackend(response: string | null, configured = true): LlmBackend {
  return { configured, complete: vi.fn(async () => response) };
}

/** N corpus prompts, default enough to clear MIN_NEW_EVENTS. */
function corpusOf(count: number, text = 'give me the prompt for the next session'): CorpusPrompt[] {
  return Array.from({ length: count }, (_, i) => ({
    text,
    sessionId: `s${i}`,
    project: 'p',
    ts: i + 1,
  }));
}

/** A valid next-session-handoff mined pattern JSON (3 distinct sessions, self-matching). */
function nextSessionPatternJson(): string {
  return JSON.stringify([
    {
      habit_key: 'context-handoff:next-session-prompt',
      match_phrases: [
        'give me the prompt for the next session',
        'write the next session prompt handoff',
        'prepare the next session handoff prompt',
      ],
      habit: 'asked for a next-session prompt',
      fix: 'bake a prompt-handoff into your /context-handoff command',
      why_inefficient: 'retypes a handoff prose every session instead of templating it',
      occurrences: [
        { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
        { sessionId: 's2', ts: 2, evidence: 'write the next session prompt handoff' },
        { sessionId: 's3', ts: 3, evidence: 'prepare the next session handoff prompt' },
      ],
      confidence: 0.82,
    },
  ]);
}

function baseInput(over: Partial<MinerInput> = {}): MinerInput {
  return {
    state: { ...defaultState(), lastMinedAt: null },
    backend: mockBackend(nextSessionPatternJson()),
    corpus: corpusOf(MIN_NEW_EVENTS),
    store: createPatternsStore(baseDir),
    now: NOW,
    ...over,
  };
}

describe('throttle (§7.2) — both conditions must hold', () => {
  it('below MIN_NEW_EVENTS -> NO LLM call, no-op', async () => {
    const backend = mockBackend(nextSessionPatternJson());
    const result = await runHabitMiner(baseInput({ backend, corpus: corpusOf(MIN_NEW_EVENTS - 1) }));
    expect(result.mined).toBe(false);
    expect(result.skippedReason).toBe('throttle_events');
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('within MINE_COOLDOWN_MS -> NO LLM call, no-op', async () => {
    const backend = mockBackend(nextSessionPatternJson());
    const state: CoachState = { ...defaultState(), lastMinedAt: NOW - (MINE_COOLDOWN_MS - 1) };
    const result = await runHabitMiner(baseInput({ backend, state }));
    expect(result.mined).toBe(false);
    expect(result.skippedReason).toBe('throttle_cooldown');
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('both satisfied -> mines (one Sonnet mine call) and advances state', async () => {
    const backend = mockBackend(nextSessionPatternJson());
    const result = await runHabitMiner(baseInput({ backend }));
    expect(result.mined).toBe(true);
    // M3: the survivor earns ONE extra draft attempt (same mocked response → not a
    // valid draft → non-fatal, pattern stays draft-less). Mine call is [0].
    expect(backend.complete).toHaveBeenCalledTimes(2);
    expect((backend.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].model).toBe('sonnet');
    expect(result.upserted[0].draft).toBeUndefined(); // draft failure never blocks detection
    expect(result.nextState.lastMinedAt).toBe(NOW);
    expect(result.nextState.lastMinedWatermark).toBe(MIN_NEW_EVENTS);
    expect(result.upserted).toHaveLength(1);
  });

  it('cooldown clears once 24h elapses', async () => {
    const state: CoachState = { ...defaultState(), lastMinedAt: NOW - MINE_COOLDOWN_MS };
    const result = await runHabitMiner(baseInput({ state }));
    expect(result.mined).toBe(true);
  });
});

describe('backend guards', () => {
  it('null/unconfigured backend -> no-op (no throw)', async () => {
    const backend = mockBackend(null, false);
    const result = await runHabitMiner(baseInput({ backend }));
    expect(result.mined).toBe(false);
    expect(result.skippedReason).toBe('no_backend');
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('backend returns null text -> no-op, watermark NOT advanced', async () => {
    const backend = mockBackend(null, true);
    const result = await runHabitMiner(baseInput({ backend }));
    expect(result.mined).toBe(false);
    expect(result.nextState.lastMinedWatermark).toBe(0);
  });
});

describe('LLM parse (mirror parseJudgeVerdict)', () => {
  it('valid array -> upserts the pattern', async () => {
    const store = createPatternsStore(baseDir);
    const result = await runHabitMiner(baseInput({ store }));
    expect(result.upserted).toHaveLength(1);
    expect(store.readPatterns()[0].habit_key).toBe('context-handoff:next-session-prompt');
  });

  it('empty array -> mines (throttle ran) but upserts nothing', async () => {
    const result = await runHabitMiner(baseInput({ backend: mockBackend('[]') }));
    expect(result.mined).toBe(true);
    expect(result.upserted).toHaveLength(0);
  });

  it('malformed JSON -> no pattern (fail-closed), still counts as a mine', async () => {
    const result = await runHabitMiner(baseInput({ backend: mockBackend('not json at all') }));
    expect(result.upserted).toHaveLength(0);
  });

  it('tolerates prose around the JSON array', async () => {
    const wrapped = 'Here you go:\n' + nextSessionPatternJson() + '\nThat is all.';
    const result = await runHabitMiner(baseInput({ backend: mockBackend(wrapped) }));
    expect(result.upserted).toHaveLength(1);
  });
});

describe('structural guardrails (§5.5.6a / §7.5)', () => {
  it('drops a pattern with < 3 DISTINCT sessions', async () => {
    const json = JSON.stringify([
      {
        habit_key: 'k:dup-sessions',
        match_phrases: ['give me the prompt for the next session'],
        habit: 'x',
        fix: 'do y',
        why_inefficient: 'wastes time',
        // 3 occurrences but only 2 DISTINCT sessionIds.
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
          { sessionId: 's1', ts: 2, evidence: 'give me the prompt for the next session' },
          { sessionId: 's2', ts: 3, evidence: 'give me the prompt for the next session' },
        ],
        confidence: 0.7,
      },
    ]);
    const result = await runHabitMiner(baseInput({ backend: mockBackend(json) }));
    expect(result.upserted).toHaveLength(0);
  });

  it('drops a pattern with an empty fix', async () => {
    const json = JSON.stringify([
      {
        habit_key: 'k:nofix',
        match_phrases: ['give me the prompt for the next session'],
        habit: 'x',
        fix: '   ',
        why_inefficient: 'wastes time',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
          { sessionId: 's2', ts: 2, evidence: 'give me the prompt for the next session' },
          { sessionId: 's3', ts: 3, evidence: 'give me the prompt for the next session' },
        ],
        confidence: 0.7,
      },
    ]);
    const result = await runHabitMiner(baseInput({ backend: mockBackend(json) }));
    expect(result.upserted).toHaveLength(0);
  });

  it('drops a pattern with an empty why_inefficient (§5.5.6a structural drop)', async () => {
    const json = JSON.stringify([
      {
        habit_key: 'k:nowhy',
        match_phrases: ['give me the prompt for the next session'],
        habit: 'x',
        fix: 'do y',
        why_inefficient: '',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
          { sessionId: 's2', ts: 2, evidence: 'give me the prompt for the next session' },
          { sessionId: 's3', ts: 3, evidence: 'give me the prompt for the next session' },
        ],
        confidence: 0.7,
      },
    ]);
    const result = await runHabitMiner(baseInput({ backend: mockBackend(json) }));
    expect(result.upserted).toHaveLength(0);
  });
});

describe('GOOD-HABIT drop (§5.5.6a)', () => {
  it('a compliant model returns [] for a recurring best practice ("write a test first")', async () => {
    // The model, per the desirability instruction, emits NOTHING for a good habit.
    const result = await runHabitMiner(baseInput({ backend: mockBackend('[]') }));
    expect(result.upserted).toHaveLength(0);
  });

  it('even if the model WRONGLY returns a TDD pattern with no why_inefficient, the structural drop removes it', async () => {
    const json = JSON.stringify([
      {
        habit_key: 'testing:write-test-first',
        match_phrases: ['write a test first', 'write the test first then implement'],
        habit: 'writes tests first',
        fix: 'keep doing TDD',
        why_inefficient: '', // a good habit has no inefficiency -> structural drop
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'write a test first' },
          { sessionId: 's2', ts: 2, evidence: 'write a test first' },
          { sessionId: 's3', ts: 3, evidence: 'write a test first' },
        ],
        confidence: 0.9,
      },
    ]);
    const result = await runHabitMiner(baseInput({ backend: mockBackend(json) }));
    expect(result.upserted).toHaveLength(0);
  });
});

describe('dismissal-similarity gate (§5.5.6b)', () => {
  it('drops a NEW-keyed pattern whose anchor tokens Jaccard-overlap a DISMISSED pattern (>=0.6)', async () => {
    const store = createPatternsStore(baseDir);
    // Seed a dismissed pattern with the next-session-handoff phrasing.
    const dismissed: Pattern = {
      habit_key: 'context-handoff:next-session-prompt',
      trigger: 'prompt_recurring:context-handoff:next-session-prompt',
      match_phrases: ['give me the prompt for the next session'],
      anchorSignature: ['give', 'me', 'the', 'prompt', 'for', 'next', 'session'],
      habit: 'asked for a next-session prompt',
      fix: 'bake a prompt-handoff into your /context-handoff command',
      why_inefficient: 'retypes a handoff every session',
      occurrences: [
        { sessionId: 'a', ts: 1, evidence: 'give me the prompt for the next session' },
        { sessionId: 'b', ts: 2, evidence: 'give me the prompt for the next session' },
        { sessionId: 'c', ts: 3, evidence: 'give me the prompt for the next session' },
      ],
      occurrenceCount: 3,
      confidence: 0.8,
      status: 'dismissed',
      createdAt: 1,
      surfacedAt: null,
    };
    store.upsertPatterns([dismissed]);
    store.markDismissed('context-handoff:next-session-prompt');

    // Re-mine yields a DIFFERENT habit_key but overlapping anchor tokens.
    const drifted = JSON.stringify([
      {
        habit_key: 'session-kickoff:next-prompt', // different key
        match_phrases: [
          'give me the prompt for the next session please',
          'the prompt for the next session',
          'next session prompt for me',
        ],
        habit: 'asks for the next session prompt',
        fix: 'template the handoff in /context-handoff',
        why_inefficient: 'retypes the handoff each time',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session please' },
          { sessionId: 's2', ts: 2, evidence: 'the prompt for the next session' },
          { sessionId: 's3', ts: 3, evidence: 'next session prompt for me' },
        ],
        confidence: 0.8,
      },
    ]);
    const result = await runHabitMiner(baseInput({ store, backend: mockBackend(drifted) }));
    expect(result.upserted).toHaveLength(0); // dropped, does not resurface
    // The dismissed pattern stays dismissed; no new open row appears.
    const all = store.readPatterns();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('dismissed');
  });

  it('an UNRELATED new pattern (low Jaccard vs the dismissed one) survives', async () => {
    const store = createPatternsStore(baseDir);
    const dismissed: Pattern = {
      habit_key: 'context-handoff:next-session-prompt',
      trigger: 'prompt_recurring:context-handoff:next-session-prompt',
      match_phrases: ['give me the prompt for the next session'],
      anchorSignature: ['give', 'me', 'the', 'prompt', 'for', 'next', 'session'],
      habit: 'asked for a next-session prompt',
      fix: 'template it',
      why_inefficient: 'retypes',
      occurrences: [
        { sessionId: 'a', ts: 1, evidence: 'give me the prompt for the next session' },
        { sessionId: 'b', ts: 2, evidence: 'give me the prompt for the next session' },
        { sessionId: 'c', ts: 3, evidence: 'give me the prompt for the next session' },
      ],
      occurrenceCount: 3,
      confidence: 0.8,
      status: 'dismissed',
      createdAt: 1,
      surfacedAt: null,
    };
    store.upsertPatterns([dismissed]);
    store.markDismissed('context-handoff:next-session-prompt');

    const unrelated = JSON.stringify([
      {
        habit_key: 'db:drop-without-backup',
        match_phrases: [
          'drop the legacy orders table directly on prod',
          'truncate the audit log on production now',
          'delete every row in the staging events table',
        ],
        habit: 'runs destructive DDL without a backup',
        fix: 'take a snapshot and run it through the reversible migration pipeline',
        why_inefficient: 'irreversible data loss with no rollback path',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'drop the legacy orders table directly on prod' },
          { sessionId: 's2', ts: 2, evidence: 'truncate the audit log on production now' },
          { sessionId: 's3', ts: 3, evidence: 'delete every row in the staging events table' },
        ],
        confidence: 0.8,
      },
    ]);
    const result = await runHabitMiner(baseInput({ store, backend: mockBackend(unrelated) }));
    expect(result.upserted).toHaveLength(1);
    expect(result.upserted[0].habit_key).toBe('db:drop-without-backup');
  });
});

describe('self-match calibration (§5.5.6c)', () => {
  it('rejects a pattern whose phrases do not self-match >= 3 of its own occurrences', async () => {
    // Evidence texts are unrelated to the stored phrases -> 0 self-matches.
    const json = JSON.stringify([
      {
        habit_key: 'k:non-generalizing',
        match_phrases: [
          'completely different phrasing alpha beta',
          'wholly unrelated gamma delta phrasing',
          'orthogonal epsilon zeta phrasing here',
        ],
        habit: 'does a thing',
        fix: 'do it better',
        why_inefficient: 'wastes time',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
          { sessionId: 's2', ts: 2, evidence: 'refactor the auth module please' },
          { sessionId: 's3', ts: 3, evidence: 'add a database index to orders' },
        ],
        confidence: 0.7,
      },
    ]);
    const result = await runHabitMiner(baseInput({ backend: mockBackend(json) }));
    expect(result.upserted).toHaveLength(0);
  });

  it('keeps a pattern whose phrases self-match its occurrences (the canonical case)', async () => {
    const result = await runHabitMiner(baseInput());
    expect(result.upserted).toHaveLength(1);
    expect(result.upserted[0].anchorSignature).toBeDefined();
  });
});

describe('M3 drafting — survivors only, fail-open to draft-less (D1/D2)', () => {
  /** A backend that answers a SCRIPTED sequence (mine call first, then draft calls). */
  function scriptedBackend(responses: (string | null)[]): LlmBackend {
    let i = 0;
    return { configured: true, complete: vi.fn(async () => responses[i++] ?? null) };
  }

  /** A grounded skill draft for the canonical next-session pattern. */
  const GROUNDED_SKILL_CONTENT =
    '---\nname: context-handoff\ndescription: write the next session handoff prompt\n---\n' +
    'When the session ends, prepare the handoff:\n' +
    '1. Write the prompt for the next session.\n' +
    '2. Bake the prompt-handoff into your /context-handoff command.\n';

  function groundedDraftJson(): string {
    return JSON.stringify({ kind: 'skill', name: 'context-handoff', content: GROUNDED_SKILL_CONTENT });
  }

  /** The canonical stored pattern (matches nextSessionPatternJson's key). */
  function storedPattern(over: Partial<Pattern> = {}): Pattern {
    return {
      habit_key: 'context-handoff:next-session-prompt',
      trigger: 'prompt_recurring:context-handoff:next-session-prompt',
      match_phrases: ['give me the prompt for the next session'],
      habit: 'asked for a next-session prompt',
      fix: 'bake a prompt-handoff into your /context-handoff command',
      why_inefficient: 'retypes a handoff every session',
      occurrences: [
        { sessionId: 'a', ts: 1, evidence: 'give me the prompt for the next session' },
        { sessionId: 'b', ts: 2, evidence: 'give me the prompt for the next session' },
        { sessionId: 'c', ts: 3, evidence: 'give me the prompt for the next session' },
      ],
      occurrenceCount: 3,
      confidence: 0.8,
      status: 'open',
      createdAt: 1,
      surfacedAt: null,
      ...over,
    };
  }

  it('a survivor + a valid grounded draft response → the upserted pattern carries the draft', async () => {
    const store = createPatternsStore(baseDir);
    const backend = scriptedBackend([nextSessionPatternJson(), groundedDraftJson()]);
    const result = await runHabitMiner(baseInput({ store, backend }));
    expect(result.upserted).toHaveLength(1);
    expect(backend.complete).toHaveBeenCalledTimes(2); // mine + ONE draft call
    const p = store.readPatterns()[0];
    expect(p.draft).toEqual({
      kind: 'skill',
      name: 'context-handoff',
      content: GROUNDED_SKILL_CONTENT,
      createdAt: NOW,
    });
  });

  it('a false-positive-shaped repetition (2 distinct sessions) → no pattern, no draft call', async () => {
    const twoSessions = JSON.stringify([
      {
        habit_key: 'k:dup-sessions',
        match_phrases: ['give me the prompt for the next session'],
        habit: 'x',
        fix: 'do y',
        why_inefficient: 'wastes time',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
          { sessionId: 's1', ts: 2, evidence: 'give me the prompt for the next session' },
          { sessionId: 's2', ts: 3, evidence: 'give me the prompt for the next session' },
        ],
        confidence: 0.7,
      },
    ]);
    const backend = scriptedBackend([twoSessions, groundedDraftJson()]);
    const result = await runHabitMiner(baseInput({ backend }));
    expect(result.upserted).toHaveLength(0);
    expect(backend.complete).toHaveBeenCalledTimes(1); // the mine only — never a draft
  });

  it('a self-match-calibration failure → dropped, no draft call', async () => {
    const nonGeneralizing = JSON.stringify([
      {
        habit_key: 'k:non-generalizing',
        match_phrases: ['completely different phrasing alpha beta'],
        habit: 'does a thing',
        fix: 'do it better',
        why_inefficient: 'wastes time',
        occurrences: [
          { sessionId: 's1', ts: 1, evidence: 'give me the prompt for the next session' },
          { sessionId: 's2', ts: 2, evidence: 'refactor the auth module please' },
          { sessionId: 's3', ts: 3, evidence: 'add a database index to orders' },
        ],
        confidence: 0.7,
      },
    ]);
    const backend = scriptedBackend([nonGeneralizing, groundedDraftJson()]);
    const result = await runHabitMiner(baseInput({ backend }));
    expect(result.upserted).toHaveLength(0);
    expect(backend.complete).toHaveBeenCalledTimes(1);
  });

  it('a re-mined key whose store status is dismissed → no draft call, stays dismissed', async () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([storedPattern()]);
    store.markDismissed('context-handoff:next-session-prompt');
    const backend = scriptedBackend([nextSessionPatternJson(), groundedDraftJson()]);
    await runHabitMiner(baseInput({ store, backend }));
    expect(backend.complete).toHaveBeenCalledTimes(1); // never drafts a dismissed habit
    const p = store.readPatterns()[0];
    expect(p.status).toBe('dismissed');
    expect(p.draft).toBeUndefined();
  });

  it('a malformed draft response → pattern still upserted, draft absent (detection unharmed)', async () => {
    const store = createPatternsStore(baseDir);
    const backend = scriptedBackend([nextSessionPatternJson(), 'not json at all']);
    const result = await runHabitMiner(baseInput({ store, backend }));
    expect(result.upserted).toHaveLength(1);
    expect(store.readPatterns()[0].draft).toBeUndefined();
  });

  it('an UNGROUNDED draft (invented steps/tools) → rejected, pattern draft-less', async () => {
    const invented = JSON.stringify({
      kind: 'skill',
      name: 'context-handoff',
      content:
        '---\nname: context-handoff\ndescription: deploy pipeline\n---\n' +
        'Deploy to staging, run terraform apply, rebuild the docker image and push to the registry.',
    });
    const store = createPatternsStore(baseDir);
    const backend = scriptedBackend([nextSessionPatternJson(), invented]);
    const result = await runHabitMiner(baseInput({ store, backend }));
    expect(result.upserted).toHaveLength(1);
    expect(store.readPatterns()[0].draft).toBeUndefined();
  });

  it('a null draft response → pattern still upserted, draft absent', async () => {
    const store = createPatternsStore(baseDir);
    const backend = scriptedBackend([nextSessionPatternJson(), null]);
    const result = await runHabitMiner(baseInput({ store, backend }));
    expect(result.upserted).toHaveLength(1);
    expect(store.readPatterns()[0].draft).toBeUndefined();
  });

  it('an existing key already holding a draft → no second draft call; the stored draft survives', async () => {
    const store = createPatternsStore(baseDir);
    const existingDraft = { kind: 'skill' as const, name: 'context-handoff', content: '---\nname: x\ndescription: d\n---\nkept', createdAt: 42 };
    store.upsertPatterns([storedPattern({ draft: existingDraft })]);
    const backend = scriptedBackend([nextSessionPatternJson(), groundedDraftJson()]);
    await runHabitMiner(baseInput({ store, backend }));
    expect(backend.complete).toHaveBeenCalledTimes(1); // first draft wins — never re-draft
    expect(store.readPatterns()[0].draft).toEqual(existingDraft);
  });

  it('three survivors → at most MAX_DRAFTS_PER_MINE (2) draft calls', async () => {
    const three = JSON.parse(nextSessionPatternJson());
    const variants = ['aa', 'bb', 'cc'].map((suffix, i) => ({
      ...three[0],
      habit_key: `k:multi-${suffix}`,
      match_phrases: three[0].match_phrases.map((m: string) => `${m} ${suffix}`),
      occurrences: three[0].occurrences.map((o: { sessionId: string; ts: number; evidence: string }, j: number) => ({
        ...o,
        sessionId: `s${i}-${j}`,
        evidence: `${o.evidence} ${suffix}`,
      })),
    }));
    const backend = scriptedBackend([JSON.stringify(variants), null, null, null]);
    const result = await runHabitMiner(baseInput({ backend }));
    expect(result.upserted).toHaveLength(3);
    expect(backend.complete).toHaveBeenCalledTimes(1 + 2); // the mine + capped draft calls
  });
});

describe('corpus reader fn form', () => {
  it('accepts a lazy reader fn for the corpus', async () => {
    const reader = () => corpusOf(MIN_NEW_EVENTS);
    const result = await runHabitMiner(baseInput({ corpus: reader }));
    expect(result.mined).toBe(true);
  });
});
