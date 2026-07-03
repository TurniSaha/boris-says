import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPatternsStore, type Pattern, type PatternDraft } from '../src/habit/patterns-store.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-pat-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function mkPattern(over: Partial<Pattern> = {}): Pattern {
  return {
    habit_key: 'context-handoff:next-session-prompt',
    trigger: 'prompt_recurring:context-handoff:next-session-prompt',
    match_phrases: ['give me the prompt for the next session'],
    habit: 'asks for a next-session handoff prompt',
    fix: 'bake a prompt-handoff into your /context-handoff command',
    why_inefficient: 'retypes a handoff every session',
    occurrences: [
      { sessionId: 'a', ts: 1, evidence: 'e1' },
      { sessionId: 'b', ts: 2, evidence: 'e2' },
      { sessionId: 'c', ts: 3, evidence: 'e3' },
    ],
    occurrenceCount: 3,
    confidence: 0.8,
    status: 'open',
    createdAt: 100,
    surfacedAt: null,
    ...over,
  };
}

describe('readPatterns', () => {
  it('returns [] when patterns.json is missing', () => {
    expect(createPatternsStore(baseDir).readPatterns()).toEqual([]);
  });

  it('returns [] when patterns.json is corrupt (never throws)', () => {
    writeFileSync(join(baseDir, 'patterns.json'), 'NOT JSON');
    expect(createPatternsStore(baseDir).readPatterns()).toEqual([]);
  });
});

describe('upsertPatterns (read-merge-write under temp-rename)', () => {
  it('inserts a new key as open', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    const all = store.readPatterns();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('open');
  });

  it('dedupes by habit_key (re-run collapses to one entry)', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.upsertPatterns([mkPattern({ occurrenceCount: 5, confidence: 0.9 })]);
    const all = store.readPatterns();
    expect(all).toHaveLength(1);
    expect(all[0].occurrenceCount).toBe(5);
    expect(all[0].confidence).toBe(0.9);
  });

  it('NEVER re-opens a dismissed entry', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.markDismissed('context-handoff:next-session-prompt');
    // Miner re-runs and tries to upsert the same key as open.
    store.upsertPatterns([mkPattern({ status: 'open' })]);
    expect(store.readPatterns()[0].status).toBe('dismissed');
  });

  it('NEVER regresses surfaced back to open', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.markSurfaced('context-handoff:next-session-prompt');
    store.upsertPatterns([mkPattern({ status: 'open' })]);
    expect(store.readPatterns()[0].status).toBe('surfaced');
  });

  it('preserves createdAt on an existing key', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern({ createdAt: 100 })]);
    store.upsertPatterns([mkPattern({ createdAt: 999 })]);
    expect(store.readPatterns()[0].createdAt).toBe(100);
  });

  it('preserves surfacedAt on an existing surfaced key', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.markSurfaced('context-handoff:next-session-prompt', 777);
    store.upsertPatterns([mkPattern({ status: 'open', surfacedAt: null })]);
    const p = store.readPatterns()[0];
    expect(p.status).toBe('surfaced');
    expect(p.surfacedAt).toBe(777);
  });

  it('leaves no temp sibling after a write', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    expect(readdirSync(baseDir)).toEqual(['patterns.json']);
  });

  it('upserts multiple distinct keys', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern({ habit_key: 'k1' }), mkPattern({ habit_key: 'k2' })]);
    expect(store.readPatterns().map((p) => p.habit_key).sort()).toEqual(['k1', 'k2']);
  });
});

describe('markSurfaced / markDismissed', () => {
  it('markSurfaced sets status surfaced and surfacedAt', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.markSurfaced('context-handoff:next-session-prompt', 555);
    const p = store.readPatterns()[0];
    expect(p.status).toBe('surfaced');
    expect(p.surfacedAt).toBe(555);
  });

  it('markDismissed sets status dismissed', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.markDismissed('context-handoff:next-session-prompt');
    expect(store.readPatterns()[0].status).toBe('dismissed');
  });

  it('marking an unknown key is a no-op (does not throw or create an entry)', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern()]);
    store.markDismissed('does-not-exist');
    expect(store.readPatterns()).toHaveLength(1);
    expect(store.readPatterns()[0].status).toBe('open');
  });
});

describe('M3 drafts: draft survives merges + dismissal (D4)', () => {
  function mkDraft(over: Partial<PatternDraft> = {}): PatternDraft {
    return {
      kind: 'skill',
      name: 'context-handoff',
      content: '---\nname: context-handoff\ndescription: d\n---\nbody',
      createdAt: 500,
      ...over,
    };
  }

  it('a re-upsert WITHOUT a draft preserves the existing draft (the clobber bug)', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern({ draft: mkDraft() })]);
    store.upsertPatterns([mkPattern({ occurrenceCount: 5 })]); // miner re-run, no draft
    const p = store.readPatterns()[0];
    expect(p.occurrenceCount).toBe(5);
    expect(p.draft).toEqual(mkDraft());
  });

  it('a legacy pre-M3 row (no draft field) round-trips unchanged', () => {
    const legacy = mkPattern();
    delete (legacy as Partial<Pattern>).draft;
    writeFileSync(join(baseDir, 'patterns.json'), JSON.stringify([legacy]));
    const store = createPatternsStore(baseDir);
    expect(store.readPatterns()).toEqual([legacy]);
    // A merge over the legacy row must not invent a draft key.
    store.upsertPatterns([mkPattern({ confidence: 0.9 })]);
    expect(store.readPatterns()[0].draft).toBeUndefined();
  });

  it('markDismissed keeps the draft (dismiss = never surface, not data loss)', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern({ draft: mkDraft() })]);
    store.markDismissed('context-handoff:next-session-prompt');
    const p = store.readPatterns()[0];
    expect(p.status).toBe('dismissed');
    expect(p.draft).toEqual(mkDraft());
  });

  it('the EXISTING draft wins over an incoming different draft (first draft wins)', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern({ draft: mkDraft() })]);
    store.upsertPatterns([mkPattern({ draft: mkDraft({ name: 'other', createdAt: 999 }) })]);
    expect(store.readPatterns()[0].draft).toEqual(mkDraft());
  });
});

describe('§7.6 concurrency: a concurrent dismiss + miner upsert ends dismissed', () => {
  it('dismiss lands first, then miner upsert preserves dismissed (merge tiebreaker: dismissed wins)', () => {
    const writer = createPatternsStore(baseDir);
    writer.upsertPatterns([mkPattern()]);

    // Two independent store handles simulate two processes over the same file.
    const dismisser = createPatternsStore(baseDir);
    const miner = createPatternsStore(baseDir);

    dismisser.markDismissed('context-handoff:next-session-prompt');
    // Miner re-reads (sees dismissed) and merges its fresh open upsert.
    miner.upsertPatterns([mkPattern({ status: 'open', confidence: 0.99 })]);

    expect(miner.readPatterns()[0].status).toBe('dismissed');
  });

  it('miner upsert lands first, then dismiss still wins', () => {
    const writer = createPatternsStore(baseDir);
    writer.upsertPatterns([mkPattern()]);

    const dismisser = createPatternsStore(baseDir);
    const miner = createPatternsStore(baseDir);

    miner.upsertPatterns([mkPattern({ status: 'open', confidence: 0.99 })]);
    dismisser.markDismissed('context-handoff:next-session-prompt');

    expect(dismisser.readPatterns()[0].status).toBe('dismissed');
  });

  it('an incoming upsert that itself carries status dismissed wins over an existing open', () => {
    const store = createPatternsStore(baseDir);
    store.upsertPatterns([mkPattern({ status: 'open' })]);
    store.upsertPatterns([mkPattern({ status: 'dismissed' })]);
    expect(store.readPatterns()[0].status).toBe('dismissed');
  });
});
