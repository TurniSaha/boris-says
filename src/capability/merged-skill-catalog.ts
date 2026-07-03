/**
 * src/capability/merged-skill-catalog.ts — the MergedSkillCatalog the quality cascade
 * reads (SPEC §15 seam, structurally defined by judge-cascade.ts).
 *
 * The cascade depends on a STRUCTURAL interface:
 *   interface MergedSkillCatalog {
 *     readonly all: readonly string[];
 *     resolveAction(skillId: string): SkillAction;   // { kind: 'none'|'run'|'install_run', skillId? }
 *   }
 * This module BUILDS that object by merging two on-disk-derived sets:
 *   - CURATED_SKILLS  (from scan-skills.ts; the vetted INSTALLABLE seed, incl.
 *     `database-migrations` per §5.5.5d) — a curated-but-not-installed skill resolves
 *     `install_run` so the data-safety / planning affordances are offerable.
 *   - the dev's actually-INSTALLED skills (scanInstalledSkills) — an installed skill
 *     resolves `run` (no install step needed).
 *
 * resolveAction(id):
 *   - installed                       -> { kind: 'run',         skillId }
 *   - curated but NOT installed        -> { kind: 'install_run', skillId }
 *   - neither (the judge invented one) -> { kind: 'none' }                (SKILL-WINS no-op)
 *
 * `all` = the union of curated + installed ids, deduped + sorted, rendered into the
 * judge input ("recommend ONLY from this list"). Matching is case-folded so a catalog id
 * and an on-disk scanned id compare cleanly (mirrors catalog.ts `fold`).
 *
 * Pure builder: it takes the two id lists as inputs (the CALLER runs the async scan),
 * so the catalog object itself is synchronous, deterministic, and trivially testable.
 */
import { CURATED_SKILLS } from './scan-skills.js';
import type { MergedSkillCatalog, SkillAction } from '../brain/judge-cascade.js';

/** Case-fold + trim so a curated id and a scanned id compare cleanly (mirrors catalog.ts). */
const fold = (s: string): string => s.trim().toLowerCase();

/**
 * Build the MergedSkillCatalog from the curated seed + the dev's installed skills.
 *
 * @param installedSkills the dev's on-disk skill ids (scanInstalledSkills result).
 * @param curatedSkills   the vetted INSTALLABLE seed; defaults to CURATED_SKILLS.
 */
export function createMergedSkillCatalog(
  installedSkills: readonly string[],
  curatedSkills: readonly string[] = CURATED_SKILLS,
): MergedSkillCatalog {
  // Fold-keyed lookup of installed ids -> their original (display) form, so `all`
  // renders the id the dev actually has on disk and `run` reports the on-disk id.
  const installedByFold = new Map<string, string>();
  for (const id of installedSkills) {
    const key = fold(id);
    if (key.length > 0 && !installedByFold.has(key)) installedByFold.set(key, id);
  }

  const curatedByFold = new Map<string, string>();
  for (const id of curatedSkills) {
    const key = fold(id);
    if (key.length > 0 && !curatedByFold.has(key)) curatedByFold.set(key, id);
  }

  // `all` = union of installed + curated display ids, deduped (fold) + sorted. Installed
  // wins the display form on a collision (the dev's real on-disk id is authoritative).
  const allByFold = new Map<string, string>();
  for (const [key, id] of curatedByFold) allByFold.set(key, id);
  for (const [key, id] of installedByFold) allByFold.set(key, id);
  const all: readonly string[] = [...allByFold.values()].sort();

  function resolveAction(skillId: string): SkillAction {
    const key = fold(skillId);
    if (key.length === 0) return { kind: 'none' };
    const installed = installedByFold.get(key);
    if (installed !== undefined) return { kind: 'run', skillId: installed };
    const curated = curatedByFold.get(key);
    if (curated !== undefined) return { kind: 'install_run', skillId: curated };
    return { kind: 'none' };
  }

  return { all, resolveAction };
}
