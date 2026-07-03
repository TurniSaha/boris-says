/**
 * outcome-reader.ts — W2-OUTCOME (Phase 1): a PERMISSIVE session scanner that surfaces
 * honest, retrospective Outcome SIGNALS from the same `.jsonl` the live judge reads, WITHOUT
 * touching the strict typed-prompt gate (`line-parser.ts`/`session-reader.ts` stay strict —
 * they are load-bearing for the live per-prompt judge).
 *
 * Design + honesty rules: the outcome-scoring design (SPEC §5.2). The hard ones encoded here:
 *  - Every signal carries PROVENANCE; a missing signal is "not measured", NEVER 0 / pass.
 *  - tests-passed emits ONLY when a WHITELISTED runner's own summary grammar is present in a
 *    PAIRED tool-result (unrecognized runners, `curl`/prose "passed" → no signal — the
 *    precision wall). NEVER infer pass/fail from an exit code (none exists in the transcript).
 *  - change-size / commit are LABELED PROXIES (churn / file count / git op), never renamed
 *    "quality" or "complexity".
 *  - NO combined 0–100 number (Phase 3, gated). This module yields raw per-signal facts only.
 *
 * Empirically verified against real sessions (2026-06-30): a Bash tool-result lives on a
 * `user` line as a top-level `toolUseResult { stdout, stderr, interrupted, ... }`; a commit
 * lives in `toolUseResult.gitOperation = { commit: { sha, kind } }`; an Edit result carries
 * `{ filePath, oldString, newString, structuredPatch }`. tool_use (assistant) pairs to its
 * result (user) by `tool_use.id === tool_result.tool_use_id`.
 */

/** One paired tool call + its structured result, lifted permissively from the JSONL. */
export interface ToolEvent {
  readonly toolName: string;
  /** The Bash command string when the tool is Bash (else null). */
  readonly command: string | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly interrupted: boolean;
  /** The edited file path for Edit/Write (else null). */
  readonly filePath: string | null;
  /** structuredPatch line-count proxy: {added, removed} when recoverable, else null. */
  readonly patch: { readonly added: number; readonly removed: number } | null;
  /** The git operation object when present (e.g. { commit: { sha, kind } }), else null. */
  readonly gitOperation: Record<string, unknown> | null;
}

/** A tool_use block awaiting its result (internal pairing state). */
interface PendingToolUse {
  readonly id: string;
  readonly name: string;
  readonly command: string | null;
}

/** Coerce an unknown JSON value to a plain object or null. */
function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Count added/removed lines from a structuredPatch array (best-effort, never throws). */
function patchCounts(structuredPatch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(structuredPatch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of structuredPatch) {
    const h = asObject(hunk);
    if (h === null || !Array.isArray(h.lines)) continue;
    for (const line of h.lines as unknown[]) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Scan the session `.jsonl` text and return the paired tool events (oldest first). PERMISSIVE
 * + TOLERANT: every line in its own try/catch; a torn line is skipped, never fatal. A
 * missing/empty text yields []. This does NOT use the strict typed-prompt gate.
 */
export function scanToolEvents(jsonlText: string | null | undefined): ToolEvent[] {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return [];
  const pending = new Map<string, PendingToolUse>();
  const events: ToolEvent[] = [];

  for (const line of jsonlText.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const o = asObject(parsed);
    if (o === null) continue;
    const msg = asObject(o.message);

    // (a) assistant line → register any tool_use blocks (id, name, command).
    if (o.type === 'assistant' && msg !== null && Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        const b = asObject(block);
        if (b === null || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
        const input = asObject(b.input);
        const command =
          input !== null && typeof input.command === 'string' ? input.command : null;
        pending.set(b.id, { id: b.id, name: b.name, command });
      }
    }

    // (b) user line → the matching tool_result + the structured toolUseResult.
    if (o.type === 'user' && msg !== null && Array.isArray(msg.content)) {
      const result = asObject(o.toolUseResult);
      for (const block of msg.content as unknown[]) {
        const b = asObject(block);
        if (b === null || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const use = pending.get(b.tool_use_id);
        if (use === undefined) continue; // a result with no captured tool_use — skip.
        pending.delete(b.tool_use_id);
        events.push(liftEvent(use, result));
      }
    }
  }
  return events;
}

/** Build a ToolEvent from a paired tool_use + its (possibly null) structured result. */
function liftEvent(use: PendingToolUse, result: Record<string, unknown> | null): ToolEvent {
  const stdout = result !== null && typeof result.stdout === 'string' ? result.stdout : null;
  const stderr = result !== null && typeof result.stderr === 'string' ? result.stderr : null;
  const interrupted = result !== null && result.interrupted === true;
  const filePath = result !== null && typeof result.filePath === 'string' ? result.filePath : null;
  const patch = result !== null ? patchCounts(result.structuredPatch) : null;
  const gitOperation = result !== null ? asObject(result.gitOperation) : null;
  return {
    toolName: use.name,
    command: use.command,
    stdout,
    stderr,
    interrupted,
    filePath,
    patch,
    gitOperation,
  };
}
