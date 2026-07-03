import { describe, it, expect, vi } from 'vitest';
import { createLlmBackend } from '../src/llm/backend.js';

// ---------------------------------------------------------------------------
// ROW F-BACKEND — runtime-surface pin
//
// The existing llm-backend.test.ts proves the SELECTION precedence (which
// branch is taken via `configured` + probe-not-called) and, separately, that
// the raw-API backend targets api.anthropic.com. This file closes the one
// end-to-end seam those leave open: that a backend RETURNED BY THE SELECTOR
// (createLlmBackend) actually routes a `complete()` call to api.anthropic.com
// ONLY when PROMPT_COACH_USE_API is set — and routes through the CLI spawn
// (no network) when it is not. Story clauses:
//   1. CLI default (claude -p --bare) — spawn, NOT api.anthropic.com.
//   2. raw API (api.anthropic.com) ONLY when PROMPT_COACH_USE_API is set.
//   3. silent no-op when neither is usable.
// ---------------------------------------------------------------------------

function wellFormedApiResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
  } as unknown as Response;
}

describe('surface F-BACKEND — selected backend routing (end-to-end through createLlmBackend)', () => {
  it('USE_API set + key present → selected backend hits api.anthropic.com, never spawns CLI', async () => {
    const fetchImpl = vi.fn(async () => wellFormedApiResponse('API SAYS HI')) as unknown as typeof fetch;
    const spawnFn = (() => {
      throw new Error('CLI spawn must NOT run when the API path is selected');
    }) as unknown as Parameters<typeof createLlmBackend>[1]['spawnFn'];

    const backend = createLlmBackend(
      { PROMPT_COACH_USE_API: '1', ANTHROPIC_API_KEY: 'sk-row-f' },
      { fetchImpl, spawnFn, claudeOnPath: () => true },
    );

    const out = await backend.complete({ system: 'S', user: 'U', maxTokens: 16, model: 'haiku' });
    expect(out).toBe('API SAYS HI');

    // The selected backend issued exactly one fetch, to the raw Anthropic API.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    // and it carried the opt-in key in the header
    const init = calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-row-f');
  });

  it('key present but USE_API ABSENT → selected backend routes to CLI spawn, NEVER api.anthropic.com', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch to api.anthropic.com must NOT happen on the default CLI path');
    }) as unknown as typeof fetch;

    const captured: { command?: string; args?: readonly string[] } = {};
    const spawnFn = ((command: string, args: readonly string[]) => {
      captured.command = command;
      captured.args = args;
      const dataCbs: Array<(c: string) => void> = [];
      let closeCb: ((code: number | null) => void) | null = null;
      const child = {
        stdout: { on: (_e: 'data', cb: (c: string) => void) => dataCbs.push(cb) },
        stderr: { on: () => {} },
        on(event: 'error' | 'close', cb: unknown) {
          if (event === 'close') closeCb = cb as (code: number | null) => void;
        },
      };
      queueMicrotask(() => {
        for (const cb of dataCbs) cb(JSON.stringify({ type: 'result', result: 'CLI SAYS HI' }));
        closeCb?.(0);
      });
      return child;
    }) as unknown as Parameters<typeof createLlmBackend>[1]['spawnFn'];

    // ANTHROPIC_API_KEY is present, but without PROMPT_COACH_USE_API the API
    // path must NOT be taken — a key alone never triggers a per-call charge.
    const backend = createLlmBackend(
      { ANTHROPIC_API_KEY: 'sk-present-but-unused' },
      { fetchImpl, spawnFn, claudeOnPath: () => true },
    );

    const out = await backend.complete({ system: 'S', user: 'U', maxTokens: 16, model: 'haiku' });
    expect(out).toBe('CLI SAYS HI');

    // Routed through the CLI spawn with the cost-free `claude -p ... --bare` invocation.
    expect(captured.command).toBe('claude');
    expect(captured.args).toContain('-p');
    expect(captured.args).toContain('--bare');
    // and absolutely no network call to the paid API was made.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('neither USE_API nor claude on PATH → silent no-op (configured=false, complete→null, no fetch, no spawn)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const spawnFn = (() => {
      throw new Error('no-op path must not spawn');
    }) as unknown as Parameters<typeof createLlmBackend>[1]['spawnFn'];

    const backend = createLlmBackend({}, { fetchImpl, spawnFn, claudeOnPath: () => false });
    expect(backend.configured).toBe(false);

    const out = await backend.complete({ system: 'S', user: 'U', maxTokens: 16, model: 'haiku' });
    expect(out).toBeNull();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
