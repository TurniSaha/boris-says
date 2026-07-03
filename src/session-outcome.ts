/**
 * src/session-outcome.ts -> dist/session-outcome.js — the SessionEnd entry (W2-OUTCOME Phase 1).
 *
 * Fires ONCE when a session terminates (exit / clear / compact). It re-reads the just-ended
 * session's `.jsonl`, computes HONEST per-signal Outcome facts (tests / commit / change-size),
 * renders ONE factual line, and writes a crash-safe GLOBAL `last-outcome.json` for the NEXT
 * session's first prompt to surface. It CANNOT block and CANNOT reliably show interactive
 * output (SessionEnd semantics) — so it only persists; the surfacing happens on next start.
 *
 * Hard rules (mirrors the hook): NEVER throws, ALWAYS exits 0, no fake numbers — an empty
 * report writes NOTHING (no "0 tests passed" default). The reader/extractors are permissive +
 * pure; the strict typed-prompt gate is untouched.
 */
import { readFileSync } from 'node:fs';
import { resolveBaseDir, projectKeyForCwd, type ConfigEnv } from './config.js';
import { scanToolEvents } from './jsonl/outcome-reader.js';
import { buildOutcomeReport, renderOutcomeLine } from './brain/outcome-signals.js';
import { writeLastOutcome } from './brain/outcome-store.js';

/** The raw SessionEnd stdin payload (extra fields tolerated). */
interface SessionEndStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  reason?: string;
}

/** Injected deps so a test drives it with no real stdin / fs / clock. */
export interface SessionOutcomeDeps {
  readonly stdin: string;
  readonly env: ConfigEnv;
  /** Read the ended session's JSONL (defaults to fs.readFileSync; '' on any error). */
  readonly readTranscript?: (path: string) => string;
  readonly now?: () => number;
}

/** Parse + validate the SessionEnd stdin, or null. */
function parseStdin(stdin: string): { sessionId: string; transcriptPath: string; cwd: string } | null {
  let raw: SessionEndStdin;
  try {
    raw = JSON.parse(stdin) as SessionEndStdin;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const transcriptPath = typeof raw.transcript_path === 'string' ? raw.transcript_path : '';
  if (transcriptPath.length === 0) return null; // nothing to read → nothing to compute.
  return {
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
    transcriptPath,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '', // for the project-scoping key (cross-project leak fix).
  };
}

/** Default transcript reader — never throws (→ '' on any error). */
function defaultReadTranscript(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Run the SessionEnd body. NEVER throws. Writes the global outcome file when there is at
 * least one measured signal; otherwise writes nothing (no fabricated line).
 */
export function runSessionOutcome(deps: SessionOutcomeDeps): void {
  try {
    const parsed = parseStdin(deps.stdin);
    if (parsed === null) return;

    const read = deps.readTranscript ?? defaultReadTranscript;
    const jsonl = read(parsed.transcriptPath);
    if (jsonl.length === 0) return;

    const report = buildOutcomeReport(scanToolEvents(jsonl));
    const line = renderOutcomeLine(report);
    if (line.length === 0) return; // nothing measured → write nothing (honesty rule).

    const baseDir = resolveBaseDir(deps.env);
    const now = deps.now ?? Date.now;
    writeLastOutcome(baseDir, {
      line,
      endedSessionId: parsed.sessionId,
      projectKey: projectKeyForCwd(parsed.cwd), // scope the recap to this project (cross-project leak fix).
      consumed: false,
      at: now(),
    });
  } catch {
    // SessionEnd must never throw — a failure just means no line next session.
  }
}

/** Read all of stdin as a string. Never rejects. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** The real entry: read stdin, compute, always exit 0. */
async function main(): Promise<void> {
  let stdin = '';
  try {
    stdin = await readStdin();
  } catch {
    stdin = '';
  }
  runSessionOutcome({ stdin, env: process.env });
  process.exit(0);
}

// Only run as a script when executed directly (importing for tests is side-effect-free).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
