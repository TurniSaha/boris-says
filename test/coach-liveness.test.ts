/**
 * Coach liveness (brain/coach-liveness.ts): the deterministic display-pipe heartbeat —
 * a sentinel self-test phrase (every time) + a one-time first-prompt connection ping.
 * Ported from the upstream coach service pm-service/test/coach-liveness.test.ts and RE-KEYED to the
 * single-arg `check(sessionId, text)` signature (decision #6 / spec §15c).
 */
import { describe, expect, it } from 'vitest';
import {
  createCoachLiveness,
  isCoachSentinel,
  COACH_SENTINEL_PHRASE,
  COACH_SENTINEL_REPLY,
  COACH_CONNECTED_PING,
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

describe('createCoachLiveness.check (re-keyed to sessionId)', () => {
  it('returns the sentinel reply for the self-test phrase, EVERY time (no ping alongside)', () => {
    const live = createCoachLiveness();
    expect(live.check('s', COACH_SENTINEL_PHRASE)).toEqual({ sentinel: COACH_SENTINEL_REPLY, ping: null });
    expect(live.check('s', COACH_SENTINEL_PHRASE)).toEqual({ sentinel: COACH_SENTINEL_REPLY, ping: null });
    expect(live.check('s', '  WHEN LIFE GIVES YOU LEMONS ')).toEqual({ sentinel: COACH_SENTINEL_REPLY, ping: null });
  });

  it('returns the connection ping on the FIRST prompt of a session, then nothing after', () => {
    const live = createCoachLiveness();
    expect(live.check('s1', 'start the auth work')).toEqual({ sentinel: null, ping: COACH_CONNECTED_PING });
    expect(live.check('s1', 'now add tests')).toEqual({ sentinel: null, ping: null });
    expect(live.check('s1', 'and docs')).toEqual({ sentinel: null, ping: null });
  });

  it('the sentinel on the FIRST prompt wins over the ping (sentinel precedence, no ping)', () => {
    const live = createCoachLiveness();
    expect(live.check('s2', COACH_SENTINEL_PHRASE)).toEqual({ sentinel: COACH_SENTINEL_REPLY, ping: null });
    expect(live.check('s2', 'real prompt')).toEqual({ sentinel: null, ping: null });
  });

  it('isolates the first-prompt ping per session', () => {
    const live = createCoachLiveness();
    expect(live.check('sessA', 'hi').ping).toBe(COACH_CONNECTED_PING);
    expect(live.check('sessB', 'hi').ping).toBe(COACH_CONNECTED_PING);
    expect(live.check('sessA', 'hi again').ping).toBeNull();
  });

  it('sweeps stale first-seen markers past the TTL (a long-idle session re-pings)', () => {
    let t = 1_000_000;
    const live = createCoachLiveness({ now: () => t });
    expect(live.check('s', 'first').ping).toBe(COACH_CONNECTED_PING);
    expect(live.check('s', 'second').ping).toBeNull();
    t += 7 * 60 * 60_000;
    expect(live.check('s', 'much later').ping).toBe(COACH_CONNECTED_PING);
  });
});
