import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitTip } from '../src/hook-output.js';

/** A fake write stream that captures whatever emitTip writes. */
function fakeStream(): { stream: NodeJS.WriteStream; written: string[] } {
  const written: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, written };
}

describe('emitTip — systemMessage surface (§8.2, corrected)', () => {
  it('emits ONE JSON object with the tip under systemMessage (the human-visible channel)', () => {
    const { stream, written } = fakeStream();
    emitTip('🤖 Boris says — sketch the data contract first', stream);
    const out = written.join('');
    const parsed = JSON.parse(out.trim());
    expect(parsed.systemMessage).toBe('🤖 Boris says — sketch the data contract first');
  });

  it('uses ONLY systemMessage — NOT additionalContext / hookSpecificOutput (never steers the model)', () => {
    const { stream, written } = fakeStream();
    emitTip('the tip', stream);
    const parsed = JSON.parse(written.join('').trim());
    expect(Object.keys(parsed)).toEqual(['systemMessage']);
    expect(parsed).not.toHaveProperty('hookSpecificOutput');
    expect(parsed).not.toHaveProperty('additionalContext');
  });

  it('writes exactly one line (single JSON object + trailing newline)', () => {
    const { stream, written } = fakeStream();
    emitTip('hello', stream);
    const out = written.join('');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.trim())).toEqual({ systemMessage: 'hello' });
  });

  it('preserves a multi-line ANSI banner inside the JSON string (round-trips exactly)', () => {
    const { stream, written } = fakeStream();
    const banner = '\n\x1b[1mline1\x1b[0m\nline2\n';
    emitTip(banner, stream);
    expect(JSON.parse(written.join('').trim()).systemMessage).toBe(banner);
  });

  it('never throws on a failing write (silent no-op, §8.1)', () => {
    const stream = {
      write() {
        throw new Error('EPIPE');
      },
    } as unknown as NodeJS.WriteStream;
    expect(() => emitTip('x', stream)).not.toThrow();
  });
});

describe('hook-output rationale comment (§8.2)', () => {
  it('documents the CORRECTED routing (systemMessage = human-visible, non-steering)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'src', 'hook-output.ts'), 'utf8');
    expect(src).toMatch(/systemMessage/);
    // The corrected rationale names all three channels + that stdout/additionalContext steer.
    expect(src).toMatch(/additionalContext/);
    expect(src.toLowerCase()).toMatch(/shown to the human|human-visible|shown to the developer/);
  });
});
