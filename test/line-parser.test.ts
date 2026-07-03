import { describe, it, expect } from 'vitest';
import { parseTypedPromptLine } from '../src/jsonl/line-parser.js';

/** Build one JSONL line object → string. */
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A canonical typed-prompt line: passes all three tiers. */
function typedLine(text: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    promptSource: 'typed',
    sessionId: 's-1',
    timestamp: '2026-06-22T00:00:00.000Z',
    message: { role: 'user', content: text },
    ...extra,
  });
}

describe('parseTypedPromptLine — the three-tier typed gate', () => {
  it('ACCEPTS a type:user + promptSource:typed + message.role:user line', () => {
    const out = parseTypedPromptLine(typedLine('refactor the auth module please'));
    expect(out).not.toBeNull();
    expect(out!.text).toBe('refactor the auth module please');
  });

  it('extracts sessionId and ts when present', () => {
    const out = parseTypedPromptLine(typedLine('hello', { sessionId: 'abc', timestamp: '2026-06-22T12:00:00.000Z' }));
    expect(out!.sessionId).toBe('abc');
    expect(typeof out!.ts).toBe('number');
    expect(out!.ts).toBe(Date.parse('2026-06-22T12:00:00.000Z'));
  });

  // ---- Tier 2: promptSource gate (STRICT equality) ----
  it('REJECTS promptSource:system (slash/command expansion)', () => {
    const out = parseTypedPromptLine(
      line({ type: 'user', promptSource: 'system', message: { role: 'user', content: '<command-message>/foo</command-message>' } }),
    );
    expect(out).toBeNull();
  });

  it('REJECTS promptSource:queued (out-of-turn human prose)', () => {
    const out = parseTypedPromptLine(
      line({ type: 'user', promptSource: 'queued', message: { role: 'user', content: 'whats the difference' } }),
    );
    expect(out).toBeNull();
  });

  it('REJECTS promptSource:sdk (programmatic injection)', () => {
    const out = parseTypedPromptLine(
      line({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'launch briefing' } }),
    );
    expect(out).toBeNull();
  });

  it('REJECTS a user line with NO promptSource (e.g. tool_result user line)', () => {
    const out = parseTypedPromptLine(
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
        toolUseResult: { stdout: 'ok' },
      }),
    );
    expect(out).toBeNull();
  });

  // ---- Tier 1: top-level type dispatch ----
  it('REJECTS an assistant line', () => {
    const out = parseTypedPromptLine(
      line({ type: 'assistant', promptSource: 'typed', message: { role: 'assistant', content: 'here you go' } }),
    );
    expect(out).toBeNull();
  });

  it('REJECTS a non-user top-level type even with promptSource:typed', () => {
    const out = parseTypedPromptLine(
      line({ type: 'system', promptSource: 'typed', message: { role: 'user', content: 'x' } }),
    );
    expect(out).toBeNull();
  });

  // ---- Tier 3: nested role guard ----
  it('REJECTS type:user + promptSource:typed but nested message.role !== user', () => {
    const out = parseTypedPromptLine(
      line({ type: 'user', promptSource: 'typed', message: { role: 'assistant', content: 'x' } }),
    );
    expect(out).toBeNull();
  });

  // ---- text extraction ----
  it('extracts text from a string content', () => {
    const out = parseTypedPromptLine(typedLine('a plain string prompt'));
    expect(out!.text).toBe('a plain string prompt');
  });

  it('extracts the first text block when content is an array of blocks', () => {
    const out = parseTypedPromptLine(
      line({
        type: 'user',
        promptSource: 'typed',
        message: { role: 'user', content: [{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }] },
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.text).toContain('block one');
  });

  it('returns null when content is an empty array (no text)', () => {
    const out = parseTypedPromptLine(
      line({ type: 'user', promptSource: 'typed', message: { role: 'user', content: [] } }),
    );
    expect(out).toBeNull();
  });

  // ---- defensive ----
  it('returns null (never throws) on malformed/truncated JSON', () => {
    expect(parseTypedPromptLine('{"type":"user","promptSour')).toBeNull();
    expect(parseTypedPromptLine('not json at all')).toBeNull();
    expect(parseTypedPromptLine('')).toBeNull();
  });

  it('returns null on a JSON null / non-object line', () => {
    expect(parseTypedPromptLine('null')).toBeNull();
    expect(parseTypedPromptLine('42')).toBeNull();
    expect(parseTypedPromptLine('"a string"')).toBeNull();
  });

  it('returns null when message is missing', () => {
    expect(parseTypedPromptLine(line({ type: 'user', promptSource: 'typed' }))).toBeNull();
  });
});

import { promptHasAttachedImage } from '../src/jsonl/line-parser.js';

describe('promptHasAttachedImage — detect an attached image/screenshot marker', () => {
  it('detects [Image #N] markers (Claude Code attachment form)', () => {
    expect(promptHasAttachedImage('[Image #1] whats wrong here?')).toBe(true);
    expect(promptHasAttachedImage('see this [Image #12] and fix it')).toBe(true);
    expect(promptHasAttachedImage('[Image #19] [Image #20] merge these')).toBe(true);
    expect(promptHasAttachedImage('[image #3]')).toBe(true); // case-insensitive
    expect(promptHasAttachedImage('[Image]')).toBe(true); // bare form
  });
  it('is false for prompts with NO attached image (described-but-unattached)', () => {
    expect(promptHasAttachedImage('the error I got says it crashed')).toBe(false);
    expect(promptHasAttachedImage('fix the login bug')).toBe(false);
    expect(promptHasAttachedImage('')).toBe(false);
    expect(promptHasAttachedImage('imagine a world')).toBe(false); // not a marker
  });
});
