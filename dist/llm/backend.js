import { spawnSync } from 'node:child_process';
import { createAnthropicBackend } from './anthropic.js';
import { createClaudeCliBackend } from './claude-cli.js';
/** The always-null backend: configured=false, complete always resolves null. */
function createNullBackend() {
    return {
        configured: false,
        async complete() {
            return null;
        },
    };
}
/** Real probe: is `claude` resolvable + runnable on PATH? Fail-closed on error. */
function defaultClaudeOnPath() {
    try {
        const result = spawnSync('claude', ['--version'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true,
        });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
/**
 * Select the backend per SPEC §6.3 (CLI is the DEFAULT):
 *   1. `PROMPT_COACH_USE_API` set AND `ANTHROPIC_API_KEY` set/non-empty → raw API.
 *   2. else if `claude` on PATH → CLI backend (the default).
 *   3. else → null backend (configured=false, complete → null; silent no-op).
 */
export function createLlmBackend(env, deps = {}) {
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
