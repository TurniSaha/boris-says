/**
 * src/hook.ts -> dist/hook.js — the UserPromptSubmit entry (SPEC §8.1, §2, §15).
 *
 * Two jobs, one script (decision #2), and it must be INSTANT (< ~100ms), NEVER throw,
 * and ALWAYS exit 0 (any error -> silent no-op):
 *   TOP GUARD: PROMPT_COACH_JUDGING set -> exit 0 (recursion guard, decision #13);
 *              state.enabled === false  -> exit 0 (kill switch).
 *   (1) DRAIN : read mailbox/<session_id>.json; if a tip waits, print it to the human
 *               (stdout, §8.2) — QUALITY before HABIT (§7.4 yield-to-quality, the store
 *               already orders) — and atomically clear the mailbox.
 *   (2) DETACH: write the stdin payload to a per-invocation inbox file (atomic, unique),
 *               then spawn the detached judge with [judgePath, inboxPath] and unref it.
 *               judgePath is anchored (CLAUDE_PLUGIN_ROOT/dist/judge.js or the hook's own
 *               __dirname-relative path — NEVER cwd-relative). PROMPT_COACH_JUDGING is
 *               NOT set on the judge (the judge needs the LLM; the guard rides only the
 *               inner `claude -p`, §6).
 *
 * The heavy bits (spawn, stdin, store, clock, judge-path resolution) are INJECTED so the
 * unit test runs with zero real spawn/stdin. The cascade is NEVER run here — it is the
 * detached judge's job (§8.1 felt-experience: the hook returns instantly).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createStore, type Store, type InboxPayload } from './state/store.js';
import { resolveBaseDir, resolveJudgePath, isEnabled, projectKeyForCwd, type ConfigEnv } from './config.js';
import { emitTip } from './hook-output.js';
import { isCoachSentinel, COACH_SENTINEL_REPLY } from './brain/coach-liveness.js';
import { formatCoachBanner, withPromptAttribution } from './brain/mailbox-format.js';
import { surfaceOutcomeRecap } from './brain/outcome-surface.js';

/** The raw UserPromptSubmit stdin payload (§8.1, §3). Extra fields tolerated. */
interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  user_prompt?: string;
}

/** Minimal spawn seam (matches node:child_process spawn for our usage). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => { unref(): void };

/** Injected dependencies — every side effect is a seam (§8.1). */
export interface HookDeps {
  /** The raw stdin JSON text (already read). */
  readonly stdin: string;
  readonly env: ConfigEnv & { PROMPT_COACH_JUDGING?: string | undefined };
  /** The dir the running hook lives in (its own dist dir) for judge-path anchoring. */
  readonly hookDirname: string;
  readonly store?: Store;
  readonly spawnFn?: SpawnFn;
  /** Where to print a drained tip (defaults to process.stdout via emitTip). */
  readonly out?: NodeJS.WriteStream;
}

/**
 * Run the hook body. Returns synchronously-ish (the only async is JSON parse, trivial).
 * NEVER throws: the whole body is wrapped so any failure becomes a silent no-op. The
 * caller maps the return to `process.exit(0)` unconditionally.
 */
export function runHook(deps: HookDeps): void {
  try {
    // TOP GUARD: recursion guard (decision #13). The inner `claude -p` runs with this
    // set; if we are that child, do nothing.
    if (deps.env.PROMPT_COACH_JUDGING) return;

    const payload = parseStdin(deps.stdin);
    if (payload === null) return; // unparseable / missing prompt -> nothing to do.

    const baseDir = resolveBaseDir(deps.env);
    const store = deps.store ?? createStore(baseDir);

    // Kill switch.
    if (!isEnabled(store)) return;

    const sessionId = payload.session_id;

    // (0) SYNCHRONOUS SENTINEL — the true "hello world" health check. When the dev types the
    // exact sentinel phrase, print `make lemonade!` IMMEDIATELY, THIS turn, with NO background
    // judge, NO mailbox round-trip, NO model call. (The cascade also handles the sentinel, but
    // that path is next-turn + depends on the detached judge succeeding — useless as a liveness
    // probe if the judge's `claude -p` is down. This synchronous path always works.)
    if (isCoachSentinel(payload.prompt)) {
      emitTip(formatCoachBanner(COACH_SENTINEL_REPLY), deps.out ?? process.stdout);
      return;
    }

    // (0b) W2-OUTCOME SURFACE — if a PRIOR session in THIS project ended and left an unconsumed
    // Outcome line, show it ONCE on this session's first prompt (same-project + first-prompt +
    // consume-once — fixes the cross-project leak). M2: the SHARED gated helper, called by
    // both this hook and the Stop hook so the gates can never diverge. Additive, before the
    // drain so it never competes with a fresh coaching tip for the budget. Returns whether a
    // recap banner (which already carries the Boris title) actually surfaced.
    const recapSurfaced = surfaceOutcomeRecap(store, baseDir, sessionId, projectKeyForCwd(payload.cwd), deps.out);

    // (1) DRAIN — print the oldest-eligible waiting tip (quality before habit; the store
    // orders the returned array). We surface a single banner per turn; clearing is atomic.
    const drained = drain(store, sessionId, deps.out);

    // (1b) TIER 1 LIVENESS HEARTBEAT — a single title-only banner ("I'm in your corner!") on
    // this session's FIRST prompt: a cheap, deterministic proof the plugin loaded (no LLM, no
    // mailbox). ADDITIVE by construction — this synchronous hook path never calls markQualityTip,
    // so it arms no cooldown and suppresses no real tip. It is emitted ONLY when nothing else
    // surfaced this turn: EVERY coach banner (a recap or a drained tip) already carries the
    // Boris title, which IS the heartbeat — so on those turns the liveness signal is already
    // present and a second banner would only double the title (and Claude Code expects ONE
    // systemMessage JSON per hook). Gated on its OWN per-session flag so none of
    // greet/recap/liveness consume another's first-prompt gate.
    if (!recapSurfaced && !drained && store.markLivenessShownIfFirst(sessionId)) {
      emitTip(formatCoachBanner(''), deps.out ?? process.stdout);
    }

    // (2) DETACH — hand the payload to the judge via a per-invocation inbox file, then
    // spawn the detached judge and unref so the hook can exit immediately.
    detach(store, payload, deps);
  } catch {
    // Hard rule (§8.1): the hook never throws — any error is a silent no-op.
  }
}

/** Parse + validate the stdin JSON into a normalized inbox payload, or null. */
function parseStdin(stdin: string): InboxPayload | null {
  let raw: HookStdin;
  try {
    raw = JSON.parse(stdin) as HookStdin;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : raw.user_prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return null;
  return {
    prompt,
    transcript_path: typeof raw.transcript_path === 'string' ? raw.transcript_path : '',
    session_id: typeof raw.session_id === 'string' ? raw.session_id : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
  };
}

/**
 * M2: the LABELED BACKSTOP drain (PLAN Step 6). The Stop hook is now the PRIMARY tip
 * surface (same-turn); anything still waiting here at the NEXT UserPromptSubmit is by
 * definition about a PRIOR prompt (this turn's id is only minted AFTER this drain), so a
 * tip that carries its judged prompt renders with the `about your prompt: "…"` label.
 * Claiming is the ATOMIC rename shared with the Stop hook — one surface, never two.
 */
function drain(store: Store, sessionId: string, out: NodeJS.WriteStream | undefined): boolean {
  const tips = store.claimMailbox(sessionId);
  if (tips.length === 0) return false;
  // Quality-before-habit ordering is the store's job; print the highest-priority tip.
  const tip = tips[0];
  // Single banner per turn (deliberate) — but re-queue the tail so a lower-priority tip
  // deferred behind this one is NOT silently discarded; it surfaces on the next drain.
  for (const rest of tips.slice(1)) store.writeMailbox(sessionId, rest);
  const message =
    typeof tip.prompt === 'string' && tip.prompt.length > 0
      ? withPromptAttribution(tip.message, tip.prompt)
      : tip.message; // no judged prompt (bare ping/sentinel) → nothing to attribute.
  emitTip(message, out ?? process.stdout);
  return true;
}

/**
 * Write the inbox file + spawn the detached judge anchored at the resolved judge path.
 * M2: mints the per-turn id first — `beginTurn` records it for the Stop hook's poll, and
 * the same id rides to the judge inside the inbox payload (tip attribution + the
 * judge-done marker [A2]). A beginTurn failure must never cost the judge spawn.
 */
function detach(store: Store, payload: InboxPayload, deps: HookDeps): void {
  const turnId = `${payload.session_id}#${process.pid}-${Date.now()}-${process.hrtime.bigint()}`;
  try {
    store.beginTurn(payload.session_id, turnId);
  } catch {
    // marker is an optimization for the Stop poll — never block the judge on it.
  }
  const inboxPath = store.writeInbox({ ...payload, turn_id: turnId });
  const judgePath = resolveJudgePath(deps.hookDirname, deps.env);
  const spawnFn = deps.spawnFn ?? (defaultSpawn as SpawnFn);
  const child = spawnFn('node', [judgePath, inboxPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // Do NOT set PROMPT_COACH_JUDGING on the judge — it needs the LLM (§8.1). The guard
  // var rides only the inner `claude -p` the backend spawns (§6).
  child.unref();
}

/** The real spawn (node:child_process) wired to the SpawnFn seam. */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
): { unref(): void } {
  return spawn(command, [...args], options);
}

/** Read all of stdin (the UserPromptSubmit JSON) as a string. Never rejects. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** The real entry: read stdin, run the hook, always exit 0. */
async function main(): Promise<void> {
  let stdin = '';
  try {
    stdin = await readStdin();
  } catch {
    stdin = '';
  }
  const hookDirname = dirname(fileURLToPath(import.meta.url));
  runHook({ stdin, env: process.env, hookDirname });
  process.exit(0);
}

// Only run as a script when executed directly (so importing for tests is side-effect-free).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
