import { describe, expect, it } from 'vitest';
import { reflex } from '../src/brain/judge-reflex.js';

/**
 * TIER 0 REFLEX — the local, no-model gate. Ported from the upstream coach service
 * pm-service/test/judge-reflex.test.ts, plus the §5.5.5 INTENT/risk-token cases.
 */
describe('judge Tier-0 reflex (local trivial/continuation suppression)', () => {
  it('suppresses single-token approvals as "approval"', () => {
    for (const t of ['yes', 'Yes', 'YES.', 'ok', 'okay', 'sure', 'approve', 'lgtm', 'no', 'stop']) {
      const v = reflex(t);
      expect(v.suppress).toBe(true);
      expect(v.reason).toBe('approval');
    }
  });

  it('suppresses short continuations as "trivial-continuation"', () => {
    for (const t of ['go on', 'continue', 'proceed', 'do that', 'next', 'sounds good']) {
      const v = reflex(t);
      expect(v.suppress).toBe(true);
      expect(v.reason).toBe('trivial-continuation');
    }
  });

  it('suppresses a short trivial fix ("fix the typo") as "trivial-fix"', () => {
    const v = reflex('fix the typo');
    expect(v.suppress).toBe(true);
    expect(v.reason).toBe('trivial-fix');
  });

  it('does NOT suppress a real task even if it contains a trivial marker, because it is long', () => {
    // "rename" appears, but this is a real, scoped task — Tier 0 must let it through.
    const v = reflex(
      'rename the AuthService.refreshToken method to renewSession across the codebase and update all call sites',
    );
    expect(v.suppress).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('does NOT suppress a fresh new-task prompt — that is Sonnet\'s call', () => {
    const v = reflex('build a dashboard, not sure what it needs yet, maybe charts?');
    expect(v.suppress).toBe(false);
  });

  it('does NOT swallow a terse-but-unrecognized prompt at Tier 0 (lets the transcript-aware tiers judge)', () => {
    // Short, but not a recognized continuation/approval/fix marker — proceed.
    const v = reflex('add retry logic');
    expect(v.suppress).toBe(false);
  });

  // ---- §5.5.5 EDIT: gate on INTENT, not raw length ----
  describe('§5.5.5 trivial-INTENT + risk-token guard', () => {
    it('SUPPRESSES a short trivial-intent rename past the old 24-char limit', () => {
      // "rename this variable to userId" is 30 chars — was wasting a Haiku call before.
      const v = reflex('rename this variable to userId');
      expect(v.suppress).toBe(true);
      expect(v.reason).toBe('trivial-fix');
    });

    it('SUPPRESSES "fix the typo in the README install command" (trivial, no risk token)', () => {
      const v = reflex('fix the typo in the README');
      expect(v.suppress).toBe(true);
      expect(v.reason).toBe('trivial-fix');
    });

    it('does NOT suppress a trivial-looking fix that names a RISK surface (escalates)', () => {
      // Risk token "migration"/"drops"/"users table" present -> never trivial.
      const v = reflex('fix the typo in the migration that drops the users table');
      expect(v.suppress).toBe(false);
      expect(v.reason).toBeNull();
    });

    it('does NOT suppress a multi-clause rename (and ... 40 call sites)', () => {
      const v = reflex('rename the User model and migrate all 40 call sites');
      expect(v.suppress).toBe(false);
    });

    it('suppresses single-clause linter/formatter runs by intent', () => {
      expect(reflex('run the linter').suppress).toBe(true);
      expect(reflex('format').suppress).toBe(true);
      expect(reflex('bump the version').suppress).toBe(true);
    });
  });
});
