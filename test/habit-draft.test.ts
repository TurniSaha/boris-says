/**
 * habit/draft.ts — the PURE draft seam for M3 (repetition→artifact): the Sonnet
 * draft prompt renderer, the fail-closed parser, and the deterministic
 * groundedness guardrail (D3: invented behavior is mechanically rejectable).
 */
import { describe, expect, it } from 'vitest';
import {
  DRAFT_SYSTEM,
  MAX_DRAFT_CONTENT_CHARS,
  MAX_DRAFTS_PER_MINE,
  renderDraftRequest,
  parseDraft,
  isDraftGrounded,
} from '../src/habit/draft.js';
import type { Pattern } from '../src/habit/patterns-store.js';

function mkPattern(over: Partial<Pattern> = {}): Pattern {
  return {
    habit_key: 'context-handoff:next-session-prompt',
    trigger: 'prompt_recurring:context-handoff:next-session-prompt',
    match_phrases: [
      'give me the prompt for the next session',
      'write the next session prompt handoff',
      'prepare the next session handoff prompt',
    ],
    habit: 'asked for a next-session prompt',
    fix: 'bake a prompt-handoff into your /context-handoff command',
    why_inefficient: 'retypes a handoff every session',
    occurrences: [
      { sessionId: 'a', ts: 1, evidence: 'give me the prompt for the next session' },
      { sessionId: 'b', ts: 2, evidence: 'write the next session prompt handoff' },
      { sessionId: 'c', ts: 3, evidence: 'prepare the next session handoff prompt' },
    ],
    occurrenceCount: 3,
    confidence: 0.8,
    status: 'open',
    createdAt: 100,
    surfacedAt: null,
    ...over,
  };
}

const SKILL_CONTENT =
  '---\nname: context-handoff\ndescription: write the next session handoff prompt\n---\n' +
  'When the session ends, prepare the handoff:\n' +
  '1. Write the prompt for the next session.\n' +
  '2. Bake the prompt-handoff into your /context-handoff command.\n';

function skillJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: 'skill', name: 'context-handoff', content: SKILL_CONTENT, ...over });
}

describe('constants + prompt (D2)', () => {
  it('exports the caps', () => {
    expect(MAX_DRAFT_CONTENT_CHARS).toBe(4000);
    expect(MAX_DRAFTS_PER_MINE).toBe(2);
  });

  it('DRAFT_SYSTEM forbids inventing behavior and allows a null answer', () => {
    expect(DRAFT_SYSTEM).toMatch(/never invent/i);
    expect(DRAFT_SYSTEM).toMatch(/null/);
  });

  it('renderDraftRequest carries habit, fix, and the verbatim evidence lines', () => {
    const req = renderDraftRequest(mkPattern());
    expect(req).toContain('asked for a next-session prompt');
    expect(req).toContain('bake a prompt-handoff into your /context-handoff command');
    expect(req).toContain('give me the prompt for the next session');
    expect(req).toContain('prepare the next session handoff prompt');
  });
});

describe('parseDraft — fail-closed (D2)', () => {
  it('parses a valid skill draft', () => {
    const d = parseDraft(skillJson());
    expect(d).toEqual({ kind: 'skill', name: 'context-handoff', content: SKILL_CONTENT });
  });

  it('tolerates prose around the JSON object', () => {
    const d = parseDraft('Sure, here it is:\n' + skillJson() + '\nDone.');
    expect(d?.kind).toBe('skill');
  });

  it('rejects a kind outside the enum', () => {
    expect(parseDraft(skillJson({ kind: 'agent' }))).toBeNull();
  });

  it('rejects empty content', () => {
    expect(parseDraft(skillJson({ content: '   ' }))).toBeNull();
  });

  it('rejects oversize content', () => {
    expect(parseDraft(skillJson({ content: '---\nx\n---\n' + 'a'.repeat(MAX_DRAFT_CONTENT_CHARS + 1) }))).toBeNull();
  });

  it('rejects a name with path traversal or spaces or uppercase', () => {
    expect(parseDraft(skillJson({ name: '../evil' }))).toBeNull();
    expect(parseDraft(skillJson({ name: 'has space' }))).toBeNull();
    expect(parseDraft(skillJson({ name: 'a/b' }))).toBeNull();
    expect(parseDraft(skillJson({ name: 'Upper' }))).toBeNull();
    expect(parseDraft(skillJson({ name: '' }))).toBeNull();
  });

  it('a literal null answer or prose-only text → null', () => {
    expect(parseDraft('null')).toBeNull();
    expect(parseDraft('  null  ')).toBeNull();
    expect(parseDraft('I cannot produce a complete artifact from this evidence.')).toBeNull();
  });

  it('skill content WITHOUT --- frontmatter is rejected', () => {
    expect(parseDraft(skillJson({ content: '# just markdown\nno frontmatter here at all' }))).toBeNull();
  });

  it('claude_md_rule / hook kinds do not require frontmatter', () => {
    const rule = parseDraft(
      JSON.stringify({ kind: 'claude_md_rule', name: 'handoff-rule', content: '## Handoff\n- always write the next session prompt' }),
    );
    expect(rule?.kind).toBe('claude_md_rule');
    const hook = parseDraft(
      JSON.stringify({ kind: 'hook', name: 'handoff-hook', content: '#!/bin/sh\n# settings snippet: ...\necho hi' }),
    );
    expect(hook?.kind).toBe('hook');
  });
});

describe('isDraftGrounded — deterministic guardrail (D3)', () => {
  it('a draft distilled from the evidence tokens is grounded', () => {
    const d = parseDraft(skillJson());
    expect(d).not.toBeNull();
    expect(isDraftGrounded(d!, mkPattern())).toBe(true);
  });

  it('a draft that introduces steps/tools absent from every occurrence is NOT grounded', () => {
    const invented = {
      kind: 'skill' as const,
      name: 'context-handoff',
      content:
        '---\nname: context-handoff\ndescription: deploy pipeline\n---\n' +
        'Deploy to staging, run terraform apply, rebuild the docker image and push to the registry.',
    };
    expect(isDraftGrounded(invented, mkPattern())).toBe(false);
  });

  it('an empty-ish draft body (no content tokens) fails closed', () => {
    const empty = { kind: 'hook' as const, name: 'x-y', content: '# a\n# b\nrun' };
    expect(isDraftGrounded(empty, mkPattern())).toBe(false);
  });
});
