import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HAIKU, SONNET, aliasToId } from '../src/llm/models.js';
import { createLlmBackend, type LlmBackend } from '../src/llm/backend.js';
import { createAnthropicBackend } from '../src/llm/anthropic.js';
import { createClaudeCliBackend, type CliChild } from '../src/llm/claude-cli.js';

// ---------------------------------------------------------------------------
// models.ts — current ids + alias map, NO stale ids
// ---------------------------------------------------------------------------
describe('models.ts', () => {
  it('exports the current model ids per SPEC §9', () => {
    expect(HAIKU).toBe('claude-haiku-4-5');
    expect(SONNET).toBe('claude-sonnet-4-6');
  });

  it('aliasToId maps haiku/sonnet to the current ids', () => {
    expect(aliasToId.haiku).toBe('claude-haiku-4-5');
    expect(aliasToId.sonnet).toBe('claude-sonnet-4-6');
  });

  it('contains NO stale ids (e.g. claude-opus-4-1) anywhere in the source', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'src', 'llm', 'models.ts'), 'utf8');
    expect(src).not.toContain('claude-opus-4-1');
    // the live alias map values are exactly the current ids (haiku prospector; sonnet + opus
    // judge tiers — opus is the default advice judge).
    expect(aliasToId).toEqual({
      haiku: 'claude-haiku-4-5',
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-8',
    });
  });
});

// ---------------------------------------------------------------------------
// backend.ts — selection precedence (SPEC §6.3)
// ---------------------------------------------------------------------------
describe('createLlmBackend — selection', () => {
  const neverSpawn = (() => {
    throw new Error('spawn should not be called during selection');
  }) as unknown as Parameters<typeof createLlmBackend>[1]['spawnFn'];

  it('PROMPT_COACH_USE_API + key present → API backend (configured)', () => {
    const backend = createLlmBackend(
      { PROMPT_COACH_USE_API: '1', ANTHROPIC_API_KEY: 'sk-test' },
      { fetchImpl: vi.fn() as unknown as typeof fetch, claudeOnPath: () => true },
    );
    expect(backend.configured).toBe(true);
  });

  it('USE_API set but key empty → falls through to CLI when claude on PATH', () => {
    const backend = createLlmBackend(
      { PROMPT_COACH_USE_API: '1', ANTHROPIC_API_KEY: '' },
      { claudeOnPath: () => true, spawnFn: vi.fn() as unknown as Parameters<typeof createLlmBackend>[1]['spawnFn'] },
    );
    // CLI backend reports configured=true (uses existing auth)
    expect(backend.configured).toBe(true);
  });

  it('no USE_API but claude on PATH → CLI backend (configured)', () => {
    const backend = createLlmBackend(
      { ANTHROPIC_API_KEY: 'sk-test' }, // key present but USE_API absent → NOT API
      { claudeOnPath: () => true, spawnFn: vi.fn() as unknown as Parameters<typeof createLlmBackend>[1]['spawnFn'] },
    );
    expect(backend.configured).toBe(true);
  });

  it('neither USE_API nor claude on PATH → null backend (configured=false, complete→null)', async () => {
    const backend = createLlmBackend({}, { claudeOnPath: () => false });
    expect(backend.configured).toBe(false);
    const out = await backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' });
    expect(out).toBeNull();
  });

  it('does not spawn or probe the CLI when API path is taken', () => {
    const probe = vi.fn(() => true);
    createLlmBackend(
      { PROMPT_COACH_USE_API: '1', ANTHROPIC_API_KEY: 'sk-test' },
      { fetchImpl: vi.fn() as unknown as typeof fetch, claudeOnPath: probe, spawnFn: neverSpawn },
    );
    expect(probe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// anthropic.ts — raw API backend
// ---------------------------------------------------------------------------
function wellFormedResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
  } as unknown as Response;
}

describe('anthropic.ts — raw API backend', () => {
  it('returns the first text block from a well-formed response', async () => {
    const fetchImpl = vi.fn(async () => wellFormedResponse('HELLO FROM HAIKU')) as unknown as typeof fetch;
    const backend = createAnthropicBackend('sk-test', fetchImpl);
    const out = await backend.complete({ system: 'sys', user: 'usr', maxTokens: 8, model: 'haiku' });
    expect(out).toBe('HELLO FROM HAIKU');
  });

  it('sends cache_control ephemeral on the system block and the mapped model id', async () => {
    const fetchImpl = vi.fn(async () => wellFormedResponse('ok')) as unknown as typeof fetch;
    const backend = createAnthropicBackend('sk-test', fetchImpl);
    await backend.complete({ system: 'SYSTEM TEXT', user: 'USER TEXT', maxTokens: 600, model: 'sonnet' });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-sonnet-4-6'); // alias mapped to real id
    expect(body.max_tokens).toBe(600);
    expect(body.system).toEqual([
      { type: 'text', text: 'SYSTEM TEXT', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'USER TEXT' }]);
    // required headers
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });

  it('returns null on a non-2xx (500) without surfacing the vendor body', async () => {
    const secret = 'VENDOR-LEAK-do-not-surface';
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: secret }),
      text: async () => secret,
    })) as unknown as typeof fetch;
    const backend = createAnthropicBackend('sk-test', fetchImpl);
    const out = await backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' });
    expect(out).toBeNull();
    // the vendor body must never become the returned value (null carries nothing)
    expect(out).not.toBe(secret);
  });

  it('returns null on a network throw (never throws to caller)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET socket hang up');
    }) as unknown as typeof fetch;
    const backend = createAnthropicBackend('sk-test', fetchImpl);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });

  it('returns null on malformed JSON (parse failure)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    })) as unknown as typeof fetch;
    const backend = createAnthropicBackend('sk-test', fetchImpl);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'sonnet' }),
    ).resolves.toBeNull();
  });

  it('returns null when there is no text block', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'tool_use', name: 'x' }] }),
    })) as unknown as typeof fetch;
    const backend = createAnthropicBackend('sk-test', fetchImpl);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });

  it('configured reflects key presence; missing key → null', async () => {
    const unconfigured = createAnthropicBackend(undefined, vi.fn() as unknown as typeof fetch);
    expect(unconfigured.configured).toBe(false);
    await expect(
      unconfigured.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claude-cli.ts — CLI backend
// ---------------------------------------------------------------------------
type DataCb = (chunk: Buffer | string) => void;
type ErrCb = (err: Error) => void;
type CloseCb = (code: number | null) => void;

interface FakeChildSpec {
  stdout?: string;
  exitCode?: number | null;
  spawnError?: Error;
}

/** Build a fake spawn that drives a fake child through data → close (or error). */
function fakeSpawn(
  spec: FakeChildSpec,
  capture?: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv; stdin?: string },
) {
  return ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }): CliChild => {
    if (capture) {
      capture.command = command;
      capture.args = args;
      capture.env = options.env;
      capture.stdin = '';
    }
    const dataCbs: DataCb[] = [];
    let errCb: ErrCb | null = null;
    let closeCb: CloseCb | null = null;

    const child: CliChild = {
      stdout: { on: (_e: 'data', cb: DataCb) => dataCbs.push(cb) },
      stderr: { on: () => {} },
      // item 8: the judge payload now rides STDIN (not ps-visible argv). Capture what the
      // backend writes so the test can assert it never touches argv.
      stdin: {
        write: (chunk: string | Buffer) => {
          if (capture) capture.stdin = (capture.stdin ?? '') + String(chunk);
          return true;
        },
        end: () => {},
      },
      on(event: 'error' | 'close', cb: ErrCb | CloseCb) {
        if (event === 'error') errCb = cb as ErrCb;
        if (event === 'close') closeCb = cb as CloseCb;
      },
    };

    // Drive asynchronously so the listeners are registered first.
    queueMicrotask(() => {
      if (spec.spawnError) {
        errCb?.(spec.spawnError);
        return;
      }
      if (spec.stdout !== undefined) {
        for (const cb of dataCbs) cb(spec.stdout);
      }
      closeCb?.(spec.exitCode ?? 0);
    });

    return child;
  }) as unknown as Parameters<typeof createClaudeCliBackend>[0];
}

describe('claude-cli.ts — CLI backend', () => {
  it('parses {"type":"result","result":"HELLO"} and yields HELLO', async () => {
    const spawnFn = fakeSpawn({ stdout: JSON.stringify({ type: 'result', result: 'HELLO' }), exitCode: 0 });
    const backend = createClaudeCliBackend(spawnFn);
    const out = await backend.complete({ system: 'sys', user: 'usr', maxTokens: 8, model: 'haiku' });
    expect(out).toBe('HELLO');
  });

  it('sets PROMPT_COACH_JUDGING=1, uses the right argv, and passes the PROMPT via STDIN (not argv)', async () => {
    const cap: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv; stdin?: string } = {};
    const spawnFn = fakeSpawn({ stdout: JSON.stringify({ type: 'result', result: 'ok' }), exitCode: 0 }, cap);
    const backend = createClaudeCliBackend(spawnFn);
    await backend.complete({ system: 'SYS', user: 'USR', maxTokens: 8, model: 'sonnet' });

    expect(cap.command).toBe('claude');
    expect(cap.env?.PROMPT_COACH_JUDGING).toBe('1');
    const args = cap.args ?? [];
    expect(args).toContain('-p');
    expect(args).toContain('--bare');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    // mapped --model alias passed straight through
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('sonnet');
    // item 8 PRIVACY: the judge payload rides STDIN, NEVER argv (argv is ps-visible).
    expect(cap.stdin).toContain('SYS');
    expect(cap.stdin).toContain('USR');
    // No argv element carries the prompt text.
    for (const a of args) {
      expect(a).not.toContain('SYS');
      expect(a).not.toContain('USR');
    }
    // `-p` is a bare flag now (no prompt arg after it) OR followed by another flag, never the payload.
    const promptIdx = args.indexOf('-p');
    const after = args[promptIdx + 1];
    expect(after === undefined || after.startsWith('--')).toBe(true);
  });

  it('returns null on a non-zero exit', async () => {
    const spawnFn = fakeSpawn({ stdout: JSON.stringify({ type: 'result', result: 'ignored' }), exitCode: 1 });
    const backend = createClaudeCliBackend(spawnFn);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });

  it('returns null on non-JSON stdout', async () => {
    const spawnFn = fakeSpawn({ stdout: 'not json at all', exitCode: 0 });
    const backend = createClaudeCliBackend(spawnFn);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });

  it('returns null on missing .result', async () => {
    const spawnFn = fakeSpawn({ stdout: JSON.stringify({ type: 'result', subtype: 'success' }), exitCode: 0 });
    const backend = createClaudeCliBackend(spawnFn);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });

  it('returns null on a spawn error (never throws)', async () => {
    const spawnFn = fakeSpawn({ spawnError: new Error('ENOENT claude not found') });
    const backend = createClaudeCliBackend(spawnFn);
    await expect(
      backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' }),
    ).resolves.toBeNull();
  });

  it('recursion guard env is set on every call', async () => {
    const cap: { env?: NodeJS.ProcessEnv } = {};
    const spawnFn = fakeSpawn({ stdout: JSON.stringify({ result: 'x' }), exitCode: 0 }, cap as never);
    const backend: LlmBackend = createClaudeCliBackend(spawnFn);
    await backend.complete({ system: 's', user: 'u', maxTokens: 8, model: 'haiku' });
    expect(cap.env?.PROMPT_COACH_JUDGING).toBe('1');
  });
});
