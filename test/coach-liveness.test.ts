/**
 * Coach liveness (brain/coach-liveness.ts): the deterministic display-pipe heartbeat —
 * now a PURE sentinel self-test predicate (the former in-memory first-prompt connection
 * ping + TTL sweep was retired in favor of the persisted `tourShown` greet in the store).
 */
import { describe, expect, it } from 'vitest';
import {
  isCoachSentinel,
  COACH_SENTINEL_PHRASE,
  COACH_SENTINEL_REPLY,
  COACH_FIRST_RUN_TOUR,
} from '../src/brain/coach-liveness.js';
import { loadSkillIndex, type SkillIndex } from '../src/capability/skill-index.js';
import { matchExternalSkills } from '../src/capability/skill-index-matcher.js';

describe('isCoachSentinel — exact phrase, modulo whitespace/case', () => {
  it('matches the exact phrase', () => {
    expect(isCoachSentinel(COACH_SENTINEL_PHRASE)).toBe(true);
  });
  it('matches case-insensitively and tolerates surrounding/inner whitespace', () => {
    expect(isCoachSentinel('  When Life Gives You Lemons  ')).toBe(true);
    expect(isCoachSentinel('when life   gives you\tlemons')).toBe(true);
  });
  it('does NOT match a prompt that merely contains the phrase', () => {
    expect(isCoachSentinel('when life gives you lemons I said hi')).toBe(false);
  });
  it('does NOT match an unrelated prompt', () => {
    expect(isCoachSentinel('refactor the auth module')).toBe(false);
  });
  it('pins the exact sentinel constants (lemons -> lemonade)', () => {
    expect(COACH_SENTINEL_PHRASE).toBe('when life gives you lemons');
    expect(COACH_SENTINEL_REPLY).toContain('make lemonade!');
  });
});

describe("the tour's advertised /coach find example teaches on its first result", () => {
  // Extract the exact "e.g. /coach find <query>" query the tour tells a newcomer to try.
  const m = COACH_FIRST_RUN_TOUR.match(/e\.g\.\s*\/coach find ([^)]+)\)/);
  const tourExample = (m?.[1] ?? '').trim();

  it('the tour actually advertises a /coach find example', () => {
    expect(tourExample.length).toBeGreaterThan(0);
  });

  it("the newcomer's very first result surfaces AND carries a real (non-omitted) description", () => {
    const real = loadSkillIndex();
    expect(real).not.toBeNull();
    // The tour points a newcomer at the userInitiated /coach find path.
    const hits = matchExternalSkills(tourExample, real as SkillIndex, new Set(), undefined, {
      userInitiated: true,
    });
    expect(hits.length, `tour example "${tourExample}" must return a hit`).toBeGreaterThan(0);
    // The first result must TEACH — not "description omitted (source not permissively licensed)".
    expect(hits[0].description).not.toMatch(/description omitted/i);
    expect(hits[0].description.length).toBeGreaterThan(20);
  });
});
