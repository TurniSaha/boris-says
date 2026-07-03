/**
 * src/hook-output.ts — the SELECTED tip surface (SPEC §8.2, decision #15).
 *
 * RATIONALE (load-bearing — CORRECTED 2026-06-25 against the CURRENT Claude Code hooks docs;
 * the original "Spike B" conclusion was BACKWARDS and made the banner invisible while still
 * leaking the tip into the model):
 *
 *   For a `UserPromptSubmit` hook, Claude Code routes the three output channels as:
 *     - PLAIN STDOUT                          → fed to the MODEL as context, NOT shown to the human ❌ (both wrong)
 *     - hookSpecificOutput.additionalContext  → fed to the MODEL, NOT shown to the human          ❌
 *     - { "systemMessage": ... } (JSON stdout)→ SHOWN TO THE HUMAN, NOT in the model context      ✅
 *
 *   A prompting tip must reach the DEVELOPER's eyes and must NEVER steer the agent's task —
 *   only `systemMessage` does both. So the hook prints ONE JSON object
 *   `{"systemMessage": <banner>}` to stdout and exits 0.
 *   (Citation: code.claude.com/docs/en/hooks.md — "How Outputs Are Surfaced".)
 *
 *   NOTE: `systemMessage` renders as a plain UI string, so the ANSI box collapses to plain
 *   text — still clearly a "🤖 Boris says …" coach message (habit nudges carry a 🐾 body
 *   marker). The banner formatter keeps those markers so it reads as a coach message either way.
 */
/**
 * Emit a coaching tip to the HUMAN via the `systemMessage` JSON channel (§8.2). Claude Code
 * displays `systemMessage` to the developer and does NOT inject it into the model's context.
 * The caller exits 0 after. Writes exactly ONE JSON object + trailing newline. Never throws
 * on a normal write; a write failure is swallowed (the hook must always be a silent no-op on
 * error — §8.1 hard rule).
 */
export function emitTip(text, out = process.stdout) {
    try {
        out.write(JSON.stringify({ systemMessage: text }) + '\n');
    }
    catch {
        // A failed write must never crash the hook (§8.1 hard rule: silent no-op).
    }
}
