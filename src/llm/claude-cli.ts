import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { LlmBackend, LlmCompleteOptions } from './backend.js';

/**
 * Minimal subset of the child handle the backend needs. Lets tests inject a
 * fake spawn without depending on the full `ChildProcess` shape.
 */
export interface CliChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  /**
   * item 8: the judge payload is written HERE (stdin), not on argv, so it is never visible in
   * `ps`/`/proc/<pid>/cmdline`. Optional so a fake/edge child without stdin degrades safely.
   */
  stdin?: { write(chunk: string | Buffer): void; end(): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null) => void): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => CliChild;

const adaptedSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args as string[], options) as unknown as CliChild;

/**
 * CLI backend (the DEFAULT per SPEC §6.3). Shells out to:
 *   `claude -p --model <alias> --bare --output-format json`
 * with the judge payload written to the child's STDIN (item 8 privacy fix — see below),
 * and `PROMPT_COACH_JUDGING=1` in the child env (the recursion guard, spike-verified
 * §6.2.5 — `--bare` also skips hooks, so two independent guards).
 *
 * PRIVACY (item 8): the prompt used to ride argv (`-p <payload>`), which is visible to any
 * local process via `ps`/`/proc/<pid>/cmdline`. VERIFIED 2026-07-02 against the installed
 * claude 2.1.199 that `claude -p` (no prompt arg) reads the prompt from STDIN
 * (`--input-format text` default; a trivial `echo … | claude -p …` returned the expected
 * `.result`). So the payload now goes to stdin and NEVER touches argv. If a future CLI drops
 * stdin support the call simply yields null (never-throws contract) — no payload leak either way.
 *
 * Spike-pinned JSON shape (§6.2.5): stdout is a single object
 * `{ "type":"result", "result":"<model text>", ... }`; the model text is `.result`.
 *
 * CLI-fidelity tradeoff (§6.2 / §6.2.5): `claude -p` has no separate system slot, so we
 * PREPEND the system text to the user content. This loses the clean system/user separation +
 * the `cache_control` discount the raw-API backend keeps — an accepted cost of the zero-setup,
 * no-per-call-charge default path.
 *
 * Never throws: spawn error, non-zero exit, non-JSON stdout, or missing `.result` all
 * resolve to `null`.
 */
export function createClaudeCliBackend(spawnFn: SpawnFn = adaptedSpawn): LlmBackend {
  return {
    configured: true,
    complete({ system, user, model }: LlmCompleteOptions): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        try {
          const combinedUser = system ? `${system}\n\n${user}` : user;
          // item 8: NO prompt on argv — `-p` is a bare flag and the payload rides stdin.
          const args = ['-p', '--model', model, '--bare', '--output-format', 'json'];
          const child = spawnFn('claude', args, {
            env: { ...process.env, PROMPT_COACH_JUDGING: '1' },
            // stdin is now a PIPE we write the payload into (was 'ignore').
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          // Write the judge payload to the child's stdin, then close it so `claude -p` sees
          // EOF and runs. Guarded: a child without a writable stdin (edge/fake) degrades to
          // the never-throws null path rather than crashing.
          try {
            child.stdin?.write(combinedUser);
            child.stdin?.end();
          } catch {
            /* stdin write failure → the close/error handlers still resolve null. */
          }

          let settled = false;
          const done = (value: string | null): void => {
            if (settled) return;
            settled = true;
            resolve(value);
          };

          let out = '';
          child.stdout?.on('data', (chunk) => {
            out += chunk.toString();
          });
          // Drain stderr so the child never blocks on a full pipe; ignore content.
          child.stderr?.on('data', () => {});

          child.on('error', () => done(null));
          child.on('close', (code) => {
            if (code !== 0) return done(null);
            try {
              const parsed = JSON.parse(out) as { result?: unknown };
              if (typeof parsed.result !== 'string') return done(null);
              return done(parsed.result);
            } catch {
              return done(null);
            }
          });
        } catch {
          resolve(null);
        }
      });
    },
  };
}
