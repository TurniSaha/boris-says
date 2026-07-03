/**
 * src/habit/draft-writer.ts — M3 review-file writer for `/coach build` (D5).
 *
 * NEVER auto-activates anything:
 *   - skill        → ~/.claude/skills/<name>/SKILL.md.draft — the correct final
 *                    home, but the `.draft` suffix means Claude Code never loads
 *                    it; enabling is one printed `mv`.
 *   - claude_md_rule → <baseDir>/drafts/claude-md-rule-<key>.md — appending to
 *                    ~/.claude/CLAUDE.md IS activation, so we never touch it;
 *                    the append command is printed for the dev.
 *   - hook         → <baseDir>/drafts/hook-<key>.sh — script only; the
 *                    settings.json snippet lives in its header comment and is
 *                    the dev's to apply. settings.json is NEVER edited.
 *
 * No-clobber (an existing target is reported, not overwritten — protects dev
 * edits) and never throws (an {error} variant is returned instead).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PatternDraft } from './patterns-store.js';

/** writeDraft outcome: a written/existing path, or a never-thrown error. */
export interface DraftWriteResult {
  readonly path?: string;
  readonly existed?: boolean;
  readonly error?: string;
}

/**
 * Belt-and-suspenders slug re-sanitization (the parser already enforces
 * [a-z0-9-], but the writer must hold on its own): keep ONLY [a-z0-9-] after
 * lowercasing, so `../evil` collapses to `evil` and can never escape the root.
 * Returns '' when nothing salvageable remains.
 */
function sanitizeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/** Filesystem-safe habit key (mirrors the store's safeName discipline). */
function safeKey(habitKey: string): string {
  return habitKey.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Resolve the D5 target path for a draft, or null when the draft name is
 * unusable (fail closed — better no file than a weird one).
 */
export function resolveDraftTarget(
  draft: PatternDraft,
  habitKey: string,
  homeDir: string,
  baseDir: string,
): string | null {
  const name = sanitizeSlug(draft.name);
  if (name.length === 0) return null;
  switch (draft.kind) {
    case 'skill':
      return join(homeDir, '.claude', 'skills', name, 'SKILL.md.draft');
    case 'claude_md_rule':
      return join(baseDir, 'drafts', `claude-md-rule-${safeKey(habitKey)}.md`);
    case 'hook':
      return join(baseDir, 'drafts', `hook-${safeKey(habitKey)}.sh`);
    default:
      return null;
  }
}

/**
 * Write the draft body to its review target (mkdir -p). No-clobber: an existing
 * file is left byte-untouched and reported with existed=true. NEVER throws.
 */
export function writeDraft(
  draft: PatternDraft,
  habitKey: string,
  homeDir: string,
  baseDir: string,
): DraftWriteResult {
  try {
    const path = resolveDraftTarget(draft, habitKey, homeDir, baseDir);
    if (path === null) return { error: `unsafe draft name "${draft.name}"` };
    // A live SKILL.md at the target means the dev already has a skill by this
    // name — refuse rather than seed an enable step that would overwrite it.
    if (draft.kind === 'skill' && existsSync(path.replace(/\.draft$/, ''))) {
      return {
        error: `a skill named "${sanitizeSlug(draft.name)}" is already installed — refusing to draft over a live skill; review it against habit "${habitKey}" manually`,
      };
    }
    if (existsSync(path)) return { path, existed: true };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, draft.content, 'utf8');
    return { path, existed: false };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : 'write failed' };
  }
}

/**
 * The printed enable instructions — activation is ALWAYS a manual dev step
 * (D5: nothing the coach writes can load without one).
 */
export function installInstructions(draft: PatternDraft, path: string): string[] {
  switch (draft.kind) {
    case 'skill':
      return [`enable: mv '${path}' '${path.replace(/\.draft$/, '')}'`];
    case 'claude_md_rule':
      return [`enable: cat '${path}' >> ~/.claude/CLAUDE.md`];
    case 'hook':
      return [
        'enable: review the header comment and add the snippet to ~/.claude/settings.json yourself — the coach never edits settings',
      ];
    default:
      return [];
  }
}
