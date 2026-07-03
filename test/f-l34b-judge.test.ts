/**
 * F-L34b DEMOTED (M1 relevance overhaul) — the prompt-path prune lever is GONE.
 *
 * GOAL.md relevance invariant: L34b's `next_prompt_budgeted` mode was the live silence-
 * filling violation — it captured the WHOLE dirty working tree's `git diff --shortstat`
 * and fired a "prune your last change" nudge on the NEXT prompt whenever the cascade was
 * otherwise silent, regardless of what the dev actually asked (the live specimen: a
 * read-only "check the deploy webhook config in the repo" got the prune nudge).
 *
 * The lever is DEMOTED into the SessionEnd outcome recap (outcome-signals.ts, agent-
 * attributed change size). This file pins the demotion at the judge level:
 *   - THE LIVE SPECIMEN never receives any deposit, even with legacy carried state on disk.
 *   - The capture/consume machinery is dead: legacy state keys are never read or written.
 *   - A REAL quality tip still fires (the demote never muted genuine coaching).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJudge, type JudgeDeps } from '../src/judge.js';
import { createStore, writeJsonAtomic, type Store, type InboxPayload } from '../src/state/store.js';
import { createPatternsStore, type PatternsStore } from '../src/habit/patterns-store.js';
import { createMergedSkillCatalog } from '../src/capability/merged-skill-catalog.js';
import type { LlmBackend, LlmCompleteOptions } from '../src/llm/backend.js';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-l34b-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const SILENT_VERDICT = JSON.stringify({
  phase: 'new-task',
  dimension_scores: {},
  missing_piece: null,
  risk_level: 'low',
  skill_fit: { candidate_skill: null, confidence: 0 },
  capability_fit: { candidate_capability: null, confidence: 0 },
  interrupt: false,
  confidence: 0.1,
  primary_lever: 'goal_clarity',
  nudge: null,
});

const FIRING_VERDICT = JSON.stringify({
  phase: 'new-task',
  dimension_scores: { process_fit: 0.2 },
  missing_piece: 'no plan for the refactor',
  risk_level: 'medium',
  skill_fit: { candidate_skill: null, confidence: 0 },
  capability_fit: { candidate_capability: null, confidence: 0 },
  interrupt: true,
  confidence: 0.85,
  primary_lever: 'process_fit',
  nudge: 'sketch the data contract and key views before diving in',
});

function backend(judge: string): LlmBackend {
  return {
    configured: true,
    async complete(o: LlmCompleteOptions) {
      return o.model === 'haiku' ? '0.9' : judge;
    },
  };
}

const NOW = 5_000_000;

/**
 * Seed a LEGACY on-disk state.json carrying the retired L34b keys: a fresh, owned
 * pendingDiffReview for `sessionId` (the shape old installs still have on disk). The
 * session is pre-greeted so the additive first-seen ping never muddies the assertions.
 */
function seedLegacyState(sessionId: string): Record<string, unknown> {
  const legacy = {
    enabled: true,
    greetedSessions: [sessionId],
    pendingDiffReview: {
      capturedForSession: sessionId,
      capturedAt: NOW - 60_000, // fresh (1 min old — well inside any TTL).
      insertions: 400,
      filesChanged: 6,
    },
    l34bLastNudgedInsertions: 0,
  };
  writeJsonAtomic(join(baseDir, 'state.json'), legacy);
  return legacy;
}

function readRawState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(baseDir, 'state.json'), 'utf8')) as Record<string, unknown>;
}

function deps(store: Store, patterns: PatternsStore, inboxPath: string, verdict: string): JudgeDeps {
  return {
    env: { PROMPT_COACH_DIR: baseDir },
    inboxPath,
    store,
    patternsStore: patterns,
    backend: backend(verdict),
    readTranscript: () => ['prior turn'],
    catalog: createMergedSkillCatalog([]),
    capabilities: [],
    readCorpus: () => [],
    now: () => NOW,
  };
}

/** Run one judge turn for `prompt` in `session`, return the deposited tips. */
async function turn(
  store: Store,
  patterns: PatternsStore,
  session: string,
  prompt: string,
  verdict: string,
): Promise<string[]> {
  const payload: InboxPayload = {
    prompt,
    transcript_path: join(baseDir, 't.jsonl'),
    session_id: session,
    cwd: baseDir,
  };
  const inboxPath = store.writeInbox(payload);
  await runJudge(deps(store, patterns, inboxPath, verdict));
  return store.readAndClearMailbox(session).map((t) => t.message);
}

describe('F-L34b demoted — the prompt-path prune lever never fires', () => {
  it('THE LIVE SPECIMEN: a read-only prompt over a legacy bloated review gets NO deposit at all', async () => {
    const sid = 'sess-specimen';
    const seeded = seedLegacyState(sid);
    const store = createStore(baseDir);
    const patterns = createPatternsStore(join(baseDir, 'patterns.json'));

    // The exact live mis-fire: a read-only prompt, a silent judge verdict, a bloated
    // carried review on disk. The old lever filled the silence with the prune nudge.
    const tips = await turn(store, patterns, sid, 'check the deploy webhook config in the repo', SILENT_VERDICT);
    expect(tips).toEqual([]); // no mailbox deposit of ANY kind.

    // No capture/consume machinery ran: the legacy keys are byte-untouched on disk (the
    // old code CLEARED pendingDiffReview on consume and re-armed the watermark).
    const raw = readRawState();
    expect(raw.pendingDiffReview).toEqual(seeded.pendingDiffReview);
    expect(raw.l34bLastNudgedInsertions ?? 0).toBe(0);
  });

  it('ANY prompt over a legacy review + a silent cascade → no deposit, zero L34b state writes', async () => {
    const sid = 'sess-any';
    const seeded = seedLegacyState(sid);
    const store = createStore(baseDir);
    const patterns = createPatternsStore(join(baseDir, 'patterns.json'));

    // A change-directed prompt (the intent gate is NOT what silences this) — the lever
    // itself is gone, so the silence stays silent.
    const tips = await turn(store, patterns, sid, 'now wire the export button to the new endpoint', SILENT_VERDICT);
    expect(tips).toEqual([]);

    const raw = readRawState();
    expect(raw.pendingDiffReview).toEqual(seeded.pendingDiffReview); // never consumed/cleared.
    expect(raw.l34bLastNudgedInsertions ?? 0).toBe(0); // never re-armed.
  });

  it('a REAL quality tip still fires over a legacy review (demote never muted genuine coaching)', async () => {
    const sid = 'sess-real';
    seedLegacyState(sid);
    const store = createStore(baseDir);
    const patterns = createPatternsStore(join(baseDir, 'patterns.json'));

    const tips = await turn(store, patterns, sid, 'refactor the retry logic across the services', FIRING_VERDICT);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toContain('sketch the data contract');
    expect(tips[0]).not.toContain('prune'); // and never the retired prune text.
    expect(store.getState().leversUsedBySession[sid]).toContain('process_fit');
  });
});
