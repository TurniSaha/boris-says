import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJudge, type JudgeDeps } from '../src/judge.js';
import { createStore, type Store, type InboxPayload } from '../src/state/store.js';
import { preClosedWatch } from '../src/state/watch.js';
import {
  createPatternsStore,
  type Pattern,
  type PatternsStore,
} from '../src/habit/patterns-store.js';
import { createMergedSkillCatalog } from '../src/capability/merged-skill-catalog.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-judge-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** A mock backend driven by a per-model script. configured=true. */
function mockBackend(opts: {
  haiku?: string | null;
  sonnet?: string | null;
  onCall?: (o: LlmCompleteOptions) => void;
}): { backend: LlmBackend; calls: LlmCompleteOptions[] } {
  const calls: LlmCompleteOptions[] = [];
  const backend: LlmBackend = {
    configured: true,
    async complete(o) {
      calls.push(o);
      opts.onCall?.(o);
      return o.model === 'haiku' ? (opts.haiku ?? null) : (opts.sonnet ?? null);
    },
  };
  return { backend, calls };
}

/** A judge verdict JSON that FIRES (new-task, interrupt, high confidence, lever, nudge). */
const FIRING_VERDICT = JSON.stringify({
  phase: 'new-task',
  dimension_scores: { goal_clarity: 0.2 },
  missing_piece: 'a concrete definition of done',
  risk_level: 'low',
  skill_fit: { candidate_skill: null, confidence: 0 },
  capability_fit: { candidate_capability: null, confidence: 0 },
  interrupt: true,
  confidence: 0.9,
  primary_lever: 'process_fit',
  nudge: 'sketch the data contract and key views first',
});

function writeInboxFile(store: Store, payload: InboxPayload): string {
  return store.writeInbox(payload);
}

/**
 * M5: seed a CLOSED + ANNOUNCED watch window so the firing-path tests below keep pinning
 * today's POST-window critique behavior (FIRING_VERDICT rides process_fit — a critique
 * lever that is observe-only while the window is open). The watch-first behavior itself
 * is pinned in f-watch-judge.test.ts.
 */
function seedClosedWatch(store: Store): void {
  store.saveState({ ...store.getState(), watch: preClosedWatch(0) });
}

function baseDeps(
  store: Store,
  patternsStore: PatternsStore,
  inboxPath: string,
  overrides: Partial<JudgeDeps> = {},
): JudgeDeps {
  return {
    env: { PROMPT_COACH_DIR: baseDir },
    inboxPath,
    store,
    patternsStore,
    backend: mockBackend({ haiku: '0.9', sonnet: FIRING_VERDICT }).backend,
    readTranscript: () => [],
    catalog: createMergedSkillCatalog([]),
    capabilities: [],
    readCorpus: () => [],
    now: () => 1_000_000,
    ...overrides,
  };
}

describe('runJudge — recursion guard (§8.3 top guard)', () => {
  it('PROMPT_COACH_JUDGING set -> no-op, inbox untouched', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'p',
      transcript_path: '',
      session_id: 's',
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        env: { PROMPT_COACH_DIR: baseDir, PROMPT_COACH_JUDGING: '1' },
      }),
    );
    // Inbox NOT consumed (guard returns before reading).
    expect(existsSync(inbox)).toBe(true);
  });
});

describe('runJudge — reads + unlinks the inbox (§8.3)', () => {
  it('the inbox file is gone after the judge runs', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard',
      transcript_path: '',
      session_id: 's1',
      cwd: '',
    });
    expect(existsSync(inbox)).toBe(true);
    await runJudge(baseDeps(store, patterns, inbox));
    expect(existsSync(inbox)).toBe(false);
  });

  it('the current prompt fed to the cascade is payload.prompt (not the jsonl)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'THE-VERBATIM-PROMPT',
      transcript_path: '/tmp/whatever.jsonl',
      session_id: 's1',
      cwd: '',
    });
    let seenUser = '';
    const { backend } = mockBackend({
      haiku: '0.9',
      sonnet: FIRING_VERDICT,
      onCall: (o) => {
        if (o.model === 'haiku') seenUser = o.user;
      },
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend,
        // A transcript reader that would return DIFFERENT text proves the prompt came
        // from the payload, not the transcript.
        readTranscript: () => ['some prior prompt'],
      }),
    );
    expect(seenUser).toContain('THE-VERBATIM-PROMPT');
  });
});

describe('runJudge — (1) quality cascade deposit (§5, §15b)', () => {
  it('a firing cascade deposits a quality tip + records cooldown AND lever', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sQ',
      cwd: '',
    });
    await runJudge(baseDeps(store, patterns, inbox));

    const tips = store.readAndClearMailbox('sQ');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('quality');
    expect(tips[0].message).toContain('sketch the data contract');

    const state = store.getState();
    expect(state.lastQualityTipAt).toBe(1_000_000);
    expect(state.leversUsedBySession['sQ']).toContain('process_fit');
  });
});

describe('runJudge — (2) habit delivery (§7.4) yields to quality', () => {
  function openPattern(): Pattern {
    return {
      habit_key: 'context-handoff:next-session-prompt',
      trigger: 'prompt_recurring:context-handoff:next-session-prompt',
      match_phrases: ['give me the prompt for the next session'],
      anchorSignature: ['give', 'prompt', 'next', 'session'],
      habit: 'asked for a next-session handoff prompt',
      fix: 'bake a prompt-handoff into your /context-handoff',
      why_inefficient: 'retypes a handoff every session',
      occurrences: [
        { sessionId: 'a', ts: 1, evidence: 'x' },
        { sessionId: 'b', ts: 2, evidence: 'y' },
        { sessionId: 'c', ts: 3, evidence: 'z' },
      ],
      occurrenceCount: 3,
      confidence: 0.9,
      status: 'open',
      createdAt: 0,
      surfacedAt: null,
    };
  }

  it('a habit match deposits a habit tip + markSurfaced + lastSurfacedPatternKey set', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([openPattern()]);
    // Prime this session so the one-time first-prompt liveness ping is already spent (the
    // ping is additive and must NOT count as a coaching tip; we isolate the habit path).
    const prime = writeInboxFile(store, {
      prompt: 'a priming prompt that does not match the habit',
      transcript_path: '',
      session_id: 'sH',
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, prime, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );
    store.readAndClearMailbox('sH'); // drain the priming ping.

    const inbox = writeInboxFile(store, {
      prompt: 'give me the prompt for the next session',
      transcript_path: '',
      session_id: 'sH',
      cwd: '',
    });
    // Quality stays SILENT this turn (prospector below band) so the habit path is the only
    // eligible surface.
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: '0.0', sonnet: FIRING_VERDICT }).backend,
      }),
    );

    const tips = store.readAndClearMailbox('sH');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('habit');
    expect(tips[0].message).toContain('/context-handoff');

    const state = store.getState();
    expect(state.lastSurfacedPatternKey).toBe('context-handoff:next-session-prompt');
    expect(state.lastHabitNudgeAt).toBe(1_000_000);

    const updated = patterns.readPatterns()[0];
    expect(updated.status).toBe('surfaced');
  });

  it('§5.5.6c fuzzy fallback: a NON-lexical but handoff-ish prompt fires via ONE Haiku yes', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([openPattern()]);
    // Spend the first-prompt liveness/tour on a non-matching priming prompt.
    const prime = writeInboxFile(store, { prompt: 'a priming prompt', transcript_path: '', session_id: 'sFuzz', cwd: '' });
    await runJudge(baseDeps(store, patterns, prime, { backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend }));
    store.claimMailbox('sFuzz');

    // A prompt that does NOT lexically match the pattern's phrases but LOOKS handoff-ish
    // ("next session"). The deterministic matchHabit returns null → the fuzzy fallback runs
    // ONE Haiku call; here it answers "yes" so the habit fires.
    const inbox = writeInboxFile(store, {
      prompt: 'can you jot down where we should pick things back up in the next session',
      transcript_path: '',
      session_id: 'sFuzz',
      cwd: '',
    });
    // Quality below band (haiku '0.0') → silent, so the habit path is the only surface.
    // The SAME backend's haiku answers the fuzzy yes/no; return 'yes' for it.
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: 'yes', sonnet: FIRING_VERDICT }).backend,
      }),
    );

    const tips = store.claimMailbox('sFuzz');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('habit');
    expect(patterns.readPatterns()[0].status).toBe('surfaced');
  });

  it('yields to a quality tip on the same turn (no habit when quality fired)', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([openPattern()]);
    const inbox = writeInboxFile(store, {
      prompt: 'give me the prompt for the next session',
      transcript_path: '',
      session_id: 'sHQ',
      cwd: '',
    });
    // The cascade FIRES (prospector high + firing verdict) -> habit must yield.
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: '0.9', sonnet: FIRING_VERDICT }).backend,
      }),
    );

    const tips = store.readAndClearMailbox('sHQ');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('quality');
    // The habit pattern stays OPEN (it was not surfaced this turn).
    expect(patterns.readPatterns()[0].status).toBe('open');
  });
});

describe('runJudge — first-run TOUR is ONCE PER INSTALL (item 3)', () => {
  async function silentTurn(store: Store, patterns: ReturnType<typeof createPatternsStore>, sid: string): Promise<void> {
    const inbox = writeInboxFile(store, {
      prompt: 'first prompt of ' + sid,
      transcript_path: '',
      session_id: sid,
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, { backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend }),
    );
  }

  it('the tour fires on the FIRST session and NEVER on a later fresh session', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);

    await silentTurn(store, patterns, 'sess-1');
    const first = store.claimMailbox('sess-1');
    expect(first.some((t) => t.message.includes('Watch-first'))).toBe(true); // tour on install turn 1.

    // A brand-new SESSION on the same install must NOT re-tour (once per install, not session).
    await silentTurn(store, patterns, 'sess-2');
    const second = store.claimMailbox('sess-2');
    expect(second.some((t) => t.message.includes('Watch-first'))).toBe(false);
  });

  it('an ENGAGED legacy install gets NO surprise tour on upgrade (migration)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    // Seed a legacy state that predates the tour flag but shows engagement (a prior tip).
    const legacy: Record<string, unknown> = { ...store.getState(), lastQualityTipAt: 111 };
    delete legacy.tourShown;
    store.saveState(legacy as any);

    await silentTurn(store, patterns, 'sess-upgrade');
    const tips = store.claimMailbox('sess-upgrade');
    expect(tips.some((t) => t.message.includes('Watch-first'))).toBe(false); // no surprise tour.
  });
});

describe('runJudge — welcome_ping ratification pin (owner-accepted surface, M1 Step 5)', () => {
  // The one-time "Boris connected" ping is an ADDITIVE liveness heartbeat, NOT coaching:
  // it deposits with NO lever, must NOT arm the quality cooldown (markQualityTip), and
  // must NOT suppress the habit step on the same turn. Pinned so a future change that
  // turns the ping into a coaching-budget consumer fails loudly. (Whether the ping should
  // be intent/relevance-gated at all is an OWNER call — queued for ratification.)
  it('a first-seen bare ping: no lever recorded, cooldown NOT armed, habit still delivers same-turn', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([
      {
        habit_key: 'context-handoff:next-session-prompt',
        trigger: 'prompt_recurring:context-handoff:next-session-prompt',
        match_phrases: ['give me the prompt for the next session'],
        anchorSignature: ['give', 'prompt', 'next', 'session'],
        habit: 'asked for a next-session handoff prompt',
        fix: 'bake a prompt-handoff into your /context-handoff',
        why_inefficient: 'retypes a handoff every session',
        occurrences: [
          { sessionId: 'a', ts: 1, evidence: 'x' },
          { sessionId: 'b', ts: 2, evidence: 'y' },
          { sessionId: 'c', ts: 3, evidence: 'z' },
        ],
        occurrenceCount: 3,
        confidence: 0.9,
        status: 'open',
        createdAt: 0,
        surfacedAt: null,
      },
    ]);
    // FIRST prompt of a fresh session, quality cascade SILENT (prospector below band) →
    // the only quality-kind surface is the bare welcome ping.
    const inbox = writeInboxFile(store, {
      prompt: 'give me the prompt for the next session',
      transcript_path: '',
      session_id: 'sPing',
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );

    const tips = store.readAndClearMailbox('sPing');
    // The first-run TOUR deposited AND the habit tip deposited on the SAME turn (tour ≠
    // coaching → yield-to-quality does not trigger). The banner soft-wraps, so match a
    // tour-specific token ("Watch-first") that survives wrapping.
    expect(tips.some((t) => t.kind === 'quality' && t.message.includes('Watch-first'))).toBe(true);
    expect(tips.some((t) => t.kind === 'habit')).toBe(true);

    const state = store.getState();
    expect(state.lastQualityTipAt).toBeNull(); // markQualityTip NOT called (no cooldown armed).
    expect(state.leversUsedBySession['sPing']).toBeUndefined(); // no lever rode the ping.
    expect(state.lastTip).toBeNull(); // nothing rateable was recorded.
  });
});

describe('runJudge — (3) miner throttle (§7.2)', () => {
  it('throttled (too few new events) -> no LLM mine, no state advance', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'yes',
      transcript_path: '',
      session_id: 'sM',
      cwd: '',
    });
    let sonnetMineCalled = false;
    const { backend } = mockBackend({
      haiku: '0.0', // below band -> no quality fire, no habit
      sonnet: '[]',
      onCall: (o) => {
        // The miner is the only OTHER sonnet caller; a tiny corpus throttles it out.
        if (o.model === 'sonnet' && o.system.includes('RECURRING HABITS')) {
          sonnetMineCalled = true;
        }
      },
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend,
        readCorpus: () => [], // empty corpus -> throttle_events
      }),
    );
    expect(sonnetMineCalled).toBe(false);
    expect(store.getState().lastMinedAt).toBeNull();
  });
});

describe('runJudge — each step is independently guarded (§8.3)', () => {
  it('step 1 throwing does NOT abort steps 2/3 (habit still delivers)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([
      {
        habit_key: 'k',
        trigger: 't',
        match_phrases: ['give me the prompt for the next session'],
        anchorSignature: [],
        habit: 'asked for a next-session prompt',
        fix: 'template it',
        why_inefficient: 'retypes',
        occurrences: [
          { sessionId: 'a', ts: 1, evidence: 'x' },
          { sessionId: 'b', ts: 2, evidence: 'y' },
          { sessionId: 'c', ts: 3, evidence: 'z' },
        ],
        occurrenceCount: 3,
        confidence: 1,
        status: 'open',
        createdAt: 0,
        surfacedAt: null,
      },
    ]);
    const inbox = writeInboxFile(store, {
      prompt: 'give me the prompt for the next session',
      transcript_path: '',
      session_id: 'sErr',
      cwd: '',
    });
    // A backend that THROWS on the haiku (cascade) call but the cascade swallows? No —
    // the backend never throws by contract; to force step 1 to throw we inject a
    // catalog whose resolveAction throws is not reached. Instead, force the TRANSCRIPT
    // reader (used only by step 1) to throw.
    await runJudge(
      baseDeps(store, patterns, inbox, {
        readTranscript: () => {
          throw new Error('transcript boom');
        },
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );
    // Step 1 threw; step 2 (habit) still ran and surfaced the pattern.
    const tips = store.readAndClearMailbox('sErr');
    expect(tips.some((t) => t.kind === 'habit')).toBe(true);
  });

  it('runJudge never rejects even when everything throws', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'p',
      transcript_path: '',
      session_id: 's',
      cwd: '',
    });
    const explode = (): never => {
      throw new Error('boom');
    };
    await expect(
      runJudge(
        baseDeps(store, patterns, inbox, {
          readTranscript: explode,
          readCorpus: explode,
          backend: {
            configured: true,
            async complete() {
              throw new Error('backend boom');
            },
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('runJudge — local-context probe wiring (Part D)', () => {
  it('gathers localContext from the payload and passes it into the cascade', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '/some/session.jsonl',
      session_id: 'sLC',
      cwd: '/some/cwd',
    });
    let probeArgs: { transcriptPath: string; cwd: string } | null = null;
    await runJudge(
      baseDeps(store, patterns, inbox, {
        gatherLocalContext: (d) => {
          probeArgs = d;
          return { mode: 'normal' };
        },
      }),
    );
    // The probe was invoked with the payload's transcript_path + cwd (gathered ONCE).
    expect(probeArgs).not.toBeNull();
    expect(probeArgs!.transcriptPath).toBe('/some/session.jsonl');
    expect(probeArgs!.cwd).toBe('/some/cwd');
    // mode normal does NOT suppress a process_fit fire → tip still deposited.
    const tips = store.readAndClearMailbox('sLC');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('quality');
  });

  it('a plan-mode localContext suppresses a process_fit fire end-to-end (no coaching tip)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sLCsup',
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        gatherLocalContext: () => ({ mode: 'plan' }),
      }),
    );
    // FIRING_VERDICT is process_fit; plan mode suppresses the COACHING tip. The only
    // surface left is the additive first-prompt liveness ping (no lever, no nudge text).
    // The load-bearing signal that the coaching tip was suppressed: NO lever recorded for
    // the session (a suppressed/ping-only run records no lever — see judge.ts §15b).
    const tips = store.readAndClearMailbox('sLCsup');
    expect(tips.every((t) => !t.message.includes('sketch the data contract'))).toBe(true);
    expect(store.getState().leversUsedBySession['sLCsup']).toBeUndefined();
  });

  // ROOT CAUSE of "intro banner shows, then no coaching ever follows": a lever-LESS result
  // (the once-per-session liveness ping, or a suppressed/ping-only run) must NOT arm the
  // GLOBAL 10-minute quality cooldown. It used to call markQualityTip unconditionally, so the
  // bare welcome ping set lastQualityTipAt=now and the cascade's cadence gate then suppressed
  // every real coaching tip for 10 min (lastQualityTipAt is global across sessions).
  it('a ping-only / suppressed run does NOT arm the quality cooldown (lastQualityTipAt stays null)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sCooldownPing',
      cwd: '',
    });
    expect(store.getState().lastQualityTipAt).toBeNull(); // fresh store
    await runJudge(
      baseDeps(store, patterns, inbox, {
        gatherLocalContext: () => ({ mode: 'plan' }), // suppresses the coaching fire → ping-only
      }),
    );
    // A bare liveness ping carries no lever, so it must not arm the coaching cooldown.
    expect(store.getState().lastQualityTipAt).toBeNull();
  });

  it('a REAL coaching fire DOES arm the quality cooldown (control)', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sCooldownFire',
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        gatherLocalContext: () => ({ mode: 'normal' }), // no suppression → process_fit fires
        now: () => 1_234_567,
      }),
    );
    // A real coaching tip (a lever rode) MUST arm the cooldown so back-to-back tips are spaced.
    expect(store.getState().lastQualityTipAt).toBe(1_234_567);
  });

  it('without the suppressing localContext the SAME process_fit verdict FIRES (control)', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sLCfire',
      cwd: '',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        gatherLocalContext: () => ({ mode: 'normal' }), // not plan → no suppression.
      }),
    );
    const tips = store.readAndClearMailbox('sLCfire');
    expect(tips.some((t) => t.kind === 'quality' && t.message.includes('sketch the data contract'))).toBe(true);
    expect(store.getState().leversUsedBySession['sLCfire']).toContain('process_fit');
  });

  it('default (real) gatherLocalContext seam never throws on a bogus path', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '/no/such/file.jsonl',
      session_id: 'sLCreal',
      cwd: '/no/such/dir',
    });
    // No gatherLocalContext override → uses the real probe; degrades to all-null and
    // therefore byte-identical to today (the process_fit fire still deposits).
    await runJudge(baseDeps(store, patterns, inbox));
    const tips = store.readAndClearMailbox('sLCreal');
    expect(tips.some((t) => t.kind === 'quality')).toBe(true);
  });
});

describe('runJudge — M4 external-skill index wiring', () => {
  function freshIndex(entries: unknown[], generatedAt = new Date(1_000_000).toISOString()) {
    return {
      schemaVersion: 1 as const,
      generatedAt,
      sources: [],
      entries: entries as never[],
    };
  }

  function pdfEntry(name = 'pdf') {
    return {
      id: `anthropic-skills/${name}`,
      name,
      kind: 'skill',
      description: 'PDF manipulation toolkit',
      keywords: ['pdf', 'extraction', 'tables'],
      category: null,
      install: '/plugin install document-skills@anthropic-agent-skills',
      sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      trust: 'official',
      pinnedSha: null,
      repoStars: 157657,
    };
  }

  const MATCHING_PROMPT = 'extract the tables from this pdf report';

  async function judgeUserFor(loader: (() => unknown) | undefined): Promise<string> {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: MATCHING_PROMPT,
      transcript_path: '',
      session_id: `sExt-${Math.random().toString(36).slice(2)}`,
      cwd: '',
    });
    let judgeUser = '';
    const { backend } = mockBackend({
      haiku: '0.9',
      sonnet: FIRING_VERDICT,
      onCall: (o) => {
        if (o.model !== 'haiku') judgeUser = o.user;
      },
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend,
        ...(loader !== undefined ? { loadSkillIndex: loader as never } : {}),
      }),
    );
    return judgeUser;
  }

  it('missing index (loader → null) → NO external section in the judge input (everything silent)', async () => {
    const judgeUser = await judgeUserFor(() => null);
    expect(judgeUser.length).toBeGreaterThan(0);
    expect(judgeUser).not.toContain('External skills');
  });

  it('fresh index + matching prompt → judge input carries the external section (≤ 5 lines)', async () => {
    const judgeUser = await judgeUserFor(() => freshIndex([pdfEntry()]));
    expect(judgeUser).toContain('External skills (NOT installed');
    expect(judgeUser).toContain('- pdf: PDF manipulation toolkit');
    const lines = judgeUser
      .split('\n')
      .filter((l) => l.startsWith('- ') && l.includes(': '))
      .filter((l) => l.includes('PDF manipulation'));
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('stale index (generatedAt > 180 days old) → no external section', async () => {
    const stale = freshIndex([pdfEntry()], new Date(1_000_000 - 181 * 24 * 60 * 60 * 1000).toISOString());
    const judgeUser = await judgeUserFor(() => stale);
    expect(judgeUser.length).toBeGreaterThan(0);
    expect(judgeUser).not.toContain('External skills');
  });

  it('exclusion built from catalog.all: an entry colliding with an installed skill never reaches the prompt', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: MATCHING_PROMPT,
      transcript_path: '',
      session_id: 'sExtExcl',
      cwd: '',
    });
    let judgeUser = '';
    const { backend } = mockBackend({
      haiku: '0.9',
      sonnet: FIRING_VERDICT,
      onCall: (o) => {
        if (o.model !== 'haiku') judgeUser = o.user;
      },
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend,
        catalog: createMergedSkillCatalog(['pdf']), // 'pdf' is INSTALLED.
        loadSkillIndex: (() => freshIndex([pdfEntry()])) as never,
      }),
    );
    expect(judgeUser.length).toBeGreaterThan(0);
    expect(judgeUser).not.toContain('External skills'); // the only candidate was excluded.
  });

  it('an entry colliding with a CAPABILITY id (code-review) never reaches the prompt', async () => {
    const entry = {
      ...pdfEntry('code-review'),
      keywords: ['code', 'review', 'quality'],
      description: 'A marketplace skill shadowing a capability',
    };
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'run a code review pass over the quality of this diff',
      transcript_path: '',
      session_id: 'sExtCap',
      cwd: '',
    });
    let judgeUser = '';
    const { backend } = mockBackend({
      haiku: '0.9',
      sonnet: FIRING_VERDICT,
      onCall: (o) => {
        if (o.model !== 'haiku') judgeUser = o.user;
      },
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend,
        // NOTE: 'code-review' is ALSO a curated skill (catalog.all) AND a capability id —
        // either exclusion source must drop it.
        loadSkillIndex: (() => freshIndex([entry])) as never,
      }),
    );
    expect(judgeUser.length).toBeGreaterThan(0);
    expect(judgeUser).not.toContain('External skills');
  });
});

describe('runJudge — missing inbox -> no-op', () => {
  it('a non-existent inbox path is a clean no-op', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    await expect(
      runJudge(baseDeps(store, patterns, join(baseDir, 'inbox', 'nope.json'))),
    ).resolves.toBeUndefined();
  });
});

// ── M2 same-turn coaching: tip attribution + the judge-done marker [A2] ─────────
// (PLAN §B Step 3 — deposits carry the judged prompt + turnId so a LATE surface can
// label itself; the judge marks the turn judged at the END of its run on BOTH the
// deposited AND the silent outcome, so the Stop poll never stalls a well-formed turn.)

describe('M2 — runJudge deposits carry prompt + turnId; judge-done marker set (PLAN Step 3)', () => {
  it('a FIRING turn: the deposited quality tip carries the verbatim prompt + the turn_id, and the turn is marked judged', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sM2q',
      cwd: '',
      turn_id: 'sM2q#t1',
    });
    await runJudge(baseDeps(store, patterns, inbox));

    const tips = store.claimMailbox('sM2q');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('quality');
    expect(tips[0].prompt).toBe('build a whole dashboard from scratch');
    expect(tips[0].turnId).toBe('sM2q#t1');
    // [A2] the done-marker is set on the DEPOSITED outcome too.
    expect(store.wasTurnJudged('sM2q', 'sM2q#t1')).toBe(true);
  });

  it('a SILENT turn: NO tip, but the judge-done marker IS set (the Stop poll exits fast)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    // Spend the one-time welcome ping first so the silent turn is TRULY tip-free.
    const prime = writeInboxFile(store, {
      prompt: 'priming prompt',
      transcript_path: '',
      session_id: 'sM2s',
      cwd: '',
      turn_id: 'sM2s#t0',
    });
    await runJudge(
      baseDeps(store, patterns, prime, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );
    store.claimMailbox('sM2s'); // drain the ping.

    const inbox = writeInboxFile(store, {
      prompt: 'a perfectly well-formed prompt',
      transcript_path: '',
      session_id: 'sM2s',
      cwd: '',
      turn_id: 'sM2s#t1',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );

    expect(store.claimMailbox('sM2s')).toEqual([]); // silent — no tip.
    expect(store.wasTurnJudged('sM2s', 'sM2s#t1')).toBe(true); // but judged.
  });

  it('the bare first-run tour carries NO prompt (never labeled "about your prompt") but DOES carry the turnId', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'first prompt of a fresh session',
      transcript_path: '',
      session_id: 'sM2p',
      cwd: '',
      turn_id: 'sM2p#t1',
    });
    // Cascade silent → the only deposit is the additive once-per-install first-run tour.
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );
    const tips = store.claimMailbox('sM2p');
    expect(tips).toHaveLength(1);
    expect(tips[0].message).toContain('Watch-first'); // the tour (banner soft-wraps; token survives).
    expect(tips[0].prompt).toBeUndefined();
    expect(tips[0].turnId).toBe('sM2p#t1');
  });

  it('a deposited HABIT tip carries prompt + turnId too (the labeled backstop covers habits)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    patterns.upsertPatterns([
      {
        habit_key: 'context-handoff:next-session-prompt',
        trigger: 'prompt_recurring:context-handoff:next-session-prompt',
        match_phrases: ['give me the prompt for the next session'],
        anchorSignature: ['give', 'prompt', 'next', 'session'],
        habit: 'asked for a next-session handoff prompt',
        fix: 'bake a prompt-handoff into your /context-handoff',
        why_inefficient: 'retypes a handoff every session',
        occurrences: [
          { sessionId: 'a', ts: 1, evidence: 'x' },
          { sessionId: 'b', ts: 2, evidence: 'y' },
          { sessionId: 'c', ts: 3, evidence: 'z' },
        ],
        occurrenceCount: 3,
        confidence: 0.9,
        status: 'open',
        createdAt: 0,
        surfacedAt: null,
      },
    ]);
    // Prime the session (spend the ping), then a habit-matching silent-quality turn.
    const prime = writeInboxFile(store, {
      prompt: 'priming prompt',
      transcript_path: '',
      session_id: 'sM2h',
      cwd: '',
      turn_id: 'sM2h#t0',
    });
    await runJudge(
      baseDeps(store, patterns, prime, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );
    store.claimMailbox('sM2h');

    const inbox = writeInboxFile(store, {
      prompt: 'give me the prompt for the next session',
      transcript_path: '',
      session_id: 'sM2h',
      cwd: '',
      turn_id: 'sM2h#t1',
    });
    await runJudge(
      baseDeps(store, patterns, inbox, {
        backend: mockBackend({ haiku: '0.0', sonnet: '[]' }).backend,
      }),
    );
    const tips = store.claimMailbox('sM2h');
    expect(tips).toHaveLength(1);
    expect(tips[0].kind).toBe('habit');
    expect(tips[0].prompt).toBe('give me the prompt for the next session');
    expect(tips[0].turnId).toBe('sM2h#t1');
  });

  it('an OLD-shape inbox payload (no turn_id) never writes a judged marker (back-compat, no blank-key ring entries)', async () => {
    const store = createStore(baseDir);
    seedClosedWatch(store);
    const patterns = createPatternsStore(baseDir);
    const inbox = writeInboxFile(store, {
      prompt: 'build a whole dashboard from scratch',
      transcript_path: '',
      session_id: 'sM2old',
      cwd: '',
    });
    await runJudge(baseDeps(store, patterns, inbox));
    expect(store.getState().judgedTurns).toEqual([]);
    // The tip still deposits (the feature degrades, never breaks).
    expect(store.claimMailbox('sM2old')).toHaveLength(1);
  });
});
