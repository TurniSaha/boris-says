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
} from '../src/brain/coach-liveness.js';

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
