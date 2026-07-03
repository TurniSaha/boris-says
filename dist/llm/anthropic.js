import { aliasToId } from './models.js';
/**
 * Raw-fetch Anthropic backend, ported from the upstream coach service
 * `pm-service/src/llm/anthropic.ts` (a hand-rolled fetch, NOT @anthropic-ai/sdk).
 *
 * Three load-bearing properties are preserved byte-for-byte from the source:
 *   - the system block is sent as `system[0]` with `cache_control: ephemeral`,
 *     so a byte-stable static system prompt actually hits Anthropic prompt
 *     caching (the brain was tuned for this discount);
 *   - the error path NEVER echoes the vendor response body (it can carry
 *     headers/keys) — we collapse every failure to `null`;
 *   - `fetchImpl` is injectable, so unit tests run with zero real network.
 *
 * SPEC §6.2 reconciliation 4: the source THREW on non-2xx / unconfigured. The
 * local `LlmBackend` contract is never-throws → return `null` on ANY failure.
 * We wrap EVERYTHING in try/catch here at the backend boundary so the cascade
 * can simply null-guard.
 */
export function createAnthropicBackend(apiKey, fetchImpl = fetch) {
    return {
        configured: Boolean(apiKey),
        async complete({ system, user, maxTokens, model }) {
            try {
                if (!apiKey)
                    return null;
                const id = aliasToId[model];
                if (!id)
                    return null;
                const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                        model: id,
                        max_tokens: maxTokens,
                        // Single ephemeral-cached system block: clean system/user separation
                        // + the prompt-cache discount the brain depends on.
                        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                        messages: [{ role: 'user', content: user }],
                    }),
                });
                if (!response.ok) {
                    // Never surface the vendor body: it can echo headers/keys. Collapse to null.
                    return null;
                }
                const body = (await response.json());
                const blocks = Array.isArray(body.content) ? body.content : [];
                const first = blocks.find((b) => b.type === 'text');
                if (!first || typeof first.text !== 'string')
                    return null;
                return first.text;
            }
            catch {
                // Network error, JSON parse failure, anything: null, never throw.
                return null;
            }
        },
    };
}
