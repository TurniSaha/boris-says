import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJudge, type JudgeDeps } from '../src/judge.js';
import { createStore, type Store, type InboxPayload } from '../src/state/store.js';
import { createPatternsStore, type PatternsStore } from '../src/habit/patterns-store.js';
import { createMergedSkillCatalog } from '../src/capability/merged-skill-catalog.js';
import { runIndexRefresh, type IndexRefreshInput } from '../src/capability/index-refresh.js';
import type { SkillIndex } from '../src/capability/skill-index.js';
import type { LlmBackend } from '../src/llm/backend.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'coach-judge-refresh-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-07-02T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** A silent backend (haiku below the prospector floor → no tip; miner throttled out). */
function silentBackend(): LlmBackend {
  return {
    configured: true,
    async complete() {
      return '0.0';
    },
  };
}

function officialIdx(): SkillIndex {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    sources: [],
    entries: [
      {
        id: 'anthropic-skills/pdf',
        name: 'pdf',
        kind: 'skill',
        description: 'PDF manipulation toolkit',
        keywords: ['pdf'],
        category: null,
        install: '/plugin install document-skills@anthropic-agent-skills',
        sourceUrl: 'https://github.com/anthropics/skills',
        trust: 'official',
        pinnedSha: null,
        repoStars: 157657,
      },
    ],
  };
}

const GOOD_META = {
  stargazers_count: 2467,
  pushed_at: new Date(NOW - DAY).toISOString(),
  archived: false,
  default_branch: 'main',
};

const UPSTREAM = JSON.stringify({
  plugins: [
    {
      name: 'tool-a',
      description: 'A clean community plugin that validates documents for careful review.',
      keywords: ['documents'],
      author: { name: 'Someone Else' },
      verification: { score: 90, grade: 'A' },
    },
  ],
});

function payloadOf(session: string, turn: string): InboxPayload {
  return {
    prompt: 'tidy up the readme wording',
    transcript_path: '',
    session_id: session,
    cwd: '',
    turn_id: turn,
  };
}

function depsOf(
  store: Store,
  patterns: PatternsStore,
  inboxPath: string,
  overrides: Partial<JudgeDeps> = {},
): JudgeDeps {
  return {
    env: { PROMPT_COACH_DIR: baseDir },
    inboxPath,
    store,
    patternsStore: patterns,
    backend: silentBackend(),
    readTranscript: () => [],
    catalog: createMergedSkillCatalog([]),
    capabilities: [],
    readCorpus: () => [],
    loadSkillIndex: () => null,
    now: () => NOW,
    ...overrides,
  };
}

describe('runJudge — (4) index auto-refresh step (G-M4b)', () => {
  it('persisted throttle across two judge runs: exactly ONE network attempt', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    let fetches = 0;
    const writes: string[] = [];
    const seam = (input: IndexRefreshInput) =>
      runIndexRefresh({
        ...input,
        fetchJson: async () => {
          fetches += 1;
          return GOOD_META;
        },
        fetchText: async () => UPSTREAM,
        loadCurrent: () => officialIdx(),
        writeAtomic: (path: string) => {
          writes.push(path);
        },
      });

    const inbox1 = store.writeInbox(payloadOf('s1', 's1#a'));
    await runJudge(depsOf(store, patterns, inbox1, { runIndexRefresh: seam }));
    expect(fetches).toBe(1);
    expect(writes).toHaveLength(1);
    expect(store.getState().lastIndexRefreshAt).toBe(NOW);

    const inbox2 = store.writeInbox(payloadOf('s1', 's1#b'));
    await runJudge(depsOf(store, patterns, inbox2, { runIndexRefresh: seam }));
    expect(fetches).toBe(1); // throttled — the persisted watermark held.
  });

  it('a refresh step that THROWS is swallowed; the judged-marker is unaffected', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = store.writeInbox(payloadOf('s1', 's1#a'));
    await expect(
      runJudge(
        depsOf(store, patterns, inbox, {
          runIndexRefresh: async () => {
            throw new Error('boom');
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(store.wasTurnJudged('s1', 's1#a')).toBe(true);
  });

  it('the env kill switch reaches the step (input.env carries it; state untouched)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const inbox = store.writeInbox(payloadOf('s1', 's1#a'));
    let seen: IndexRefreshInput | null = null;
    await runJudge(
      depsOf(store, patterns, inbox, {
        env: { PROMPT_COACH_DIR: baseDir, PROMPT_COACH_NO_INDEX_REFRESH: '1' },
        runIndexRefresh: async (input: IndexRefreshInput) => {
          seen = input;
          return runIndexRefresh(input); // real semantics → 'disabled', zero fetches.
        },
      }),
    );
    expect(seen).not.toBeNull();
    expect(seen!.env.PROMPT_COACH_NO_INDEX_REFRESH).toBe('1');
    expect(seen!.baseDir).toBe(baseDir);
    expect(store.getState().lastIndexRefreshAt).toBeNull(); // disabled → no advance.
  });

  it('the refresh step runs AFTER markTurnJudged (tip delivery is never delayed)', async () => {
    const store = createStore(baseDir);
    const patterns = createPatternsStore(baseDir);
    const order: string[] = [];
    const wrapped: Store = {
      ...store,
      markTurnJudged(sessionId: string, turnId: string) {
        order.push('markTurnJudged');
        store.markTurnJudged(sessionId, turnId);
      },
    };
    const inbox = store.writeInbox(payloadOf('s1', 's1#a'));
    await runJudge(
      depsOf(wrapped, patterns, inbox, {
        store: wrapped,
        runIndexRefresh: async (input: IndexRefreshInput) => {
          order.push('refresh');
          return { refreshed: false, skippedReason: 'throttle', nextState: input.state };
        },
      }),
    );
    expect(order).toEqual(['markTurnJudged', 'refresh']);
  });
});
