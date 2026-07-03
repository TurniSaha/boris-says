/**
 * habit/draft-writer.ts — M3 review-file writer (D5: NEVER auto-activates).
 * Targets: skill → ~/.claude/skills/<name>/SKILL.md.draft (the .draft suffix means
 * Claude Code never loads it); rule/hook → <baseDir>/drafts/. No-clobber, never
 * throws, belt-and-suspenders slug re-sanitization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDraftTarget,
  writeDraft,
  installInstructions,
} from '../src/habit/draft-writer.js';
import type { PatternDraft } from '../src/habit/patterns-store.js';

let home: string;
let baseDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'coach-home-'));
  baseDir = mkdtempSync(join(tmpdir(), 'coach-base-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

function mkDraft(over: Partial<PatternDraft> = {}): PatternDraft {
  return {
    kind: 'skill',
    name: 'context-handoff',
    content: '---\nname: context-handoff\ndescription: d\n---\nbody\n',
    createdAt: 1,
    ...over,
  };
}

const KEY = 'context-handoff:next-session-prompt';

describe('resolveDraftTarget (D5 targets)', () => {
  it('skill → <home>/.claude/skills/<name>/SKILL.md.draft', () => {
    expect(resolveDraftTarget(mkDraft(), KEY, home, baseDir)).toBe(
      join(home, '.claude', 'skills', 'context-handoff', 'SKILL.md.draft'),
    );
  });

  it('claude_md_rule → <baseDir>/drafts/claude-md-rule-<safe key>.md', () => {
    const d = mkDraft({ kind: 'claude_md_rule', name: 'handoff-rule', content: '## x\n- y' });
    expect(resolveDraftTarget(d, KEY, home, baseDir)).toBe(
      join(baseDir, 'drafts', 'claude-md-rule-context-handoff_next-session-prompt.md'),
    );
  });

  it('hook → <baseDir>/drafts/hook-<safe key>.sh', () => {
    const d = mkDraft({ kind: 'hook', name: 'handoff-hook', content: '#!/bin/sh\ntrue' });
    expect(resolveDraftTarget(d, KEY, home, baseDir)).toBe(
      join(baseDir, 'drafts', 'hook-context-handoff_next-session-prompt.sh'),
    );
  });

  it('re-sanitizes a hostile name — ../evil cannot escape the skills root', () => {
    const path = resolveDraftTarget(mkDraft({ name: '../evil' }), KEY, home, baseDir);
    expect(path).not.toBeNull();
    expect(path).toBe(join(home, '.claude', 'skills', 'evil', 'SKILL.md.draft'));
    expect(path).not.toContain('..');
  });

  it('a name with NOTHING salvageable → null', () => {
    expect(resolveDraftTarget(mkDraft({ name: '../..' }), KEY, home, baseDir)).toBeNull();
  });
});

describe('writeDraft (mkdir -p, no-clobber, never throws)', () => {
  it('writes the draft body byte-equal and reports existed=false', () => {
    const result = writeDraft(mkDraft(), KEY, home, baseDir);
    expect(result.error).toBeUndefined();
    expect(result.existed).toBe(false);
    expect(readFileSync(result.path!, 'utf8')).toBe(mkDraft().content);
  });

  it('no-clobber: a second write reports existed=true and leaves the content untouched', () => {
    const first = writeDraft(mkDraft(), KEY, home, baseDir);
    const second = writeDraft(mkDraft({ content: '---\nname: n\ndescription: d\n---\nOVERWRITE' }), KEY, home, baseDir);
    expect(second.existed).toBe(true);
    expect(second.path).toBe(first.path);
    expect(readFileSync(first.path!, 'utf8')).toBe(mkDraft().content);
  });

  it('an unusable name → {error} variant, nothing written, no throw', () => {
    const result = writeDraft(mkDraft({ name: '###' }), KEY, home, baseDir);
    expect(result.error).toBeTruthy();
    expect(result.path).toBeUndefined();
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('refuses to draft into a LIVE installed skill: existing SKILL.md → {error}, nothing written', () => {
    const liveDir = join(home, '.claude', 'skills', 'context-handoff');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'SKILL.md'), '---\nname: context-handoff\ndescription: the dev own live skill\n---\nlive\n', 'utf8');
    const result = writeDraft(mkDraft(), KEY, home, baseDir);
    expect(result.error).toContain('already installed');
    expect(result.path).toBeUndefined();
    expect(existsSync(join(liveDir, 'SKILL.md.draft'))).toBe(false);
    expect(readFileSync(join(liveDir, 'SKILL.md'), 'utf8')).toContain('live');
  });
});

describe('installInstructions (enable is ALWAYS a manual dev step)', () => {
  it('skill: prints the mv that strips the .draft suffix', () => {
    const path = join(home, '.claude', 'skills', 'context-handoff', 'SKILL.md.draft');
    const lines = installInstructions(mkDraft(), path);
    expect(lines.join('\n')).toContain(`mv '${path}' '${path.replace(/\.draft$/, '')}'`);
  });

  it('claude_md_rule: prints the append command (never touches CLAUDE.md itself)', () => {
    const d = mkDraft({ kind: 'claude_md_rule' });
    const lines = installInstructions(d, join(baseDir, 'drafts', 'claude-md-rule-x.md'));
    expect(lines.join('\n')).toContain('>> ~/.claude/CLAUDE.md');
  });

  it('hook: tells the dev to add the snippet themselves — the coach never edits settings', () => {
    const d = mkDraft({ kind: 'hook' });
    const lines = installInstructions(d, join(baseDir, 'drafts', 'hook-x.sh'));
    expect(lines.join('\n')).toContain('never edits settings');
  });
});
