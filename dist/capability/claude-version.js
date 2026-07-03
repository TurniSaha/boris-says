import { spawnSync as nodeSpawnSync } from 'node:child_process';
/**
 * Capability-awareness — the `claude --version` probe (SPEC §0.1 row 11).
 *
 * Runs `claude --version` and parses the LEADING semver out of stdout (the CLI
 * prints e.g. `2.1.185 (Claude Code)`). Returns the `x.y.z` string, or null on ANY
 * failure: a spawn error (ENOENT — claude not on PATH), a non-zero exit, a timeout,
 * or output with no parseable semver. NEVER throws.
 *
 * The cli_version it returns feeds the capability resolver so we can version-gate
 * the universal Claude capabilities (keywords/modes/flags) the coach may surface —
 * fail-CLOSED on null (a capability with a minVersion is hidden when we cannot
 * confirm the dev's build).
 *
 * DI'd spawnSync, 5s timeout, encoding 'utf8', status-checked, try/catch-wrapped.
 */
const PROBE_TIMEOUT_MS = 5000;
/**
 * Probe `claude --version` and return the leading `x.y.z`, or null. Never throws.
 */
export function claudeCliVersion(options = {}) {
    const spawnSync = options.spawnSync ?? nodeSpawnSync;
    try {
        const result = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
        // Two distinct failure modes, both treated as "no version": a SPAWN failure
        // (ENOENT — claude not on PATH, or a permission error) sets result.error; a
        // TIMEOUT kills the process (killed:true, status:null) WITHOUT setting error.
        // The error-check catches the former; the status-check (null !== 0) the latter.
        if (result.error != null)
            return null;
        if (result.status !== 0)
            return null;
        const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
        return parseLeadingSemver(stdout);
    }
    catch {
        return null;
    }
}
/**
 * Extract the LEADING strict `x.y.z` from CLI output, or null. Anchored at the start
 * (after optional whitespace) so a noisy stdout line (e.g. a warning containing
 * "...line 10.20.30...") can't yield a phantom version — `claude --version` prints the
 * version first (`2.1.185 (Claude Code)`). The trailing boundary (\D or end) rejects a
 * 4-segment "1.2.3.4" → would-be "1.2.3" leak.
 */
function parseLeadingSemver(text) {
    const match = /^\s*(\d+\.\d+\.\d+)(?!\.\d)/.exec(text);
    return match ? match[1] : null;
}
