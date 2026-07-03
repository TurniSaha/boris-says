/**
 * Current Anthropic model id constants for the prompt-coach backend.
 *
 * Ported from the upstream coach service `pm-service/src/llm/models.ts` but with the STALE
 * Opus id fixed per SPEC §9 (the source carried a stale 4-1 Opus id). The
 * brain only ever requests the ALIASES `'haiku'` | `'sonnet'`; the backend maps
 * an alias to the concrete id below for the raw-API path (the CLI path passes
 * the alias straight through to `--model`).
 *
 * Current models (2026-06): Opus 4.8 = `claude-opus-4-8`, Sonnet 4.6 = `claude-sonnet-4-6`,
 * Haiku 4.5 = `claude-haiku-4-5`.
 */
/** Haiku 4.5 — the cheap prospector tier. */
export const HAIKU = 'claude-haiku-4-5';
/** Sonnet 4.6 — the balanced judge tier. */
export const SONNET = 'claude-sonnet-4-6';
/** Opus 4.8 — the deepest-reasoning judge tier (default for the advice judge). */
export const OPUS = 'claude-opus-4-8';
/**
 * Alias → concrete current model id. Used at the raw-API backend boundary to
 * turn the brain's alias request into a wire model id. (The CLI path passes the
 * alias straight to `claude --model`, where `opus`/`sonnet`/`haiku` auto-resolve.)
 */
export const aliasToId = {
    haiku: HAIKU,
    sonnet: SONNET,
    opus: OPUS,
};
