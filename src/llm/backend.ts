import { spawnSync } from 'node:child_process';
import type { ModelAlias } from './models.js';
import { createAnthropicBackend } from './anthropic.js';
import { createClaudeCliBackend, type SpawnFn } from './claude-cli.js';

/** Options for one model call. SPEC §6.1. */
export interface LlmCompleteOptions {
  system: string;
  user: string;
  maxTokens: number;
  model: ModelAlias;
}

/**
 * The local LLM backend seam (SPEC §6.1). This is the renamed/relocated source
 * `PmProvider`, reconciled per §6.2: `complete` returns the model's raw text, or
 * `null` on ANY failure — it NEVER throws to the caller.
 */
export interface LlmBackend {
  readonly configured: boolean;
  complete(opts: LlmCompleteOptions): Promise<string | null>;
}

/** The subset of `process.env` the selector reads. */
export interface BackendEnv {
  PROMPT_COACH_USE_API?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
}

/**
 * Injection seam for tests: stub the raw-API call, the CLI spawn, and the
 * claude-on-PATH probe so backend SELECTION is testable with zero network and
 * zero real process spawn.
 */
export interface BackendDeps {
  /** Injected fetch for the raw-API backend. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected spawn for the CLI backend. Defaults to `node:child_process` spawn. */
  spawnFn?: SpawnFn;
  /** Whether `claude` is on PATH. Defaults to a real `claude --version` probe. */
  claudeOnPath?: () => boolean;
}

/** The always-null backend: configured=false, complete always resolves null. */
function createNullBackend(): LlmBackend {
  return {
    configured: false,
    async complete(): Promise<string | null> {
      return null;
    },
  };
}

/** Real probe: is `claude` resolvable + runnable on PATH? Fail-closed on error. */
function defaultClaudeOnPath(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Select the backend per SPEC §6.3 (CLI is the DEFAULT):
 *   1. `PROMPT_COACH_USE_API` set AND `ANTHROPIC_API_KEY` set/non-empty → raw API.
 *   2. else if `claude` on PATH → CLI backend (the default).
 *   3. else → null backend (configured=false, complete → null; silent no-op).
 */
export function createLlmBackend(env: BackendEnv, deps: BackendDeps = {}): LlmBackend {
  const apiKey = env.ANTHROPIC_API_KEY;
  const useApi = Boolean(env.PROMPT_COACH_USE_API);

  if (useApi && typeof apiKey === 'string' && apiKey.length > 0) {
    return createAnthropicBackend(apiKey, deps.fetchImpl);
  }

  const onPath = deps.claudeOnPath ?? defaultClaudeOnPath;
  if (onPath()) {
    return createClaudeCliBackend(deps.spawnFn);
  }

  return createNullBackend();
}
