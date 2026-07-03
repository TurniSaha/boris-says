/**
 * test/f-v04.test.ts — FEASIBILITY / PRECISION-WALL pinning for lever F-V04
 * (phase-handoff): a long-transcript "continue"/phase-switch with NO compact.
 *
 * This is NOT a firing contract test — F-V04 is BLOCKED. It is a regression guard
 * that PINS the three structural walls that make a precision-safe F-V04 signal
 * impossible in the current architecture, so a future agent does not "build it"
 * without first adding the missing input channel (a context-fullness probe).
 *
 * WALL 1 — the canonical trigger word is suppressed at Tier-0 reflex, before any
 *          model token is spent: a bare "continue" never reaches the judge, so no
 *          JUDGE_SYSTEM clause can ever see it.
 * WALL 2 — a non-bare "continue with X" / phase-switch is, by the skill's own
 *          definition, a CONTINUATION — excluded from INTERRUPT_ELIGIBLE_PHASES and
 *          silenced by the firing gate even at high confidence. Any F-V04 firing
 *          clause would have to detonate that precision lever.
 * WALL 3 — the judge input carries the last typed-prompt TEXTS only: no turn-count,
 *          no context-fullness %, no compaction state. The premise "context is
 *          degrading" is a runtime-window fact the typed-prompt cascade cannot see,
 *          and is NOT a pre-run prompt-quality signal (the skill's reframe excludes
 *          runtime/outcome state).
 *
 * It ALSO documents the one fact that IS cheaply observable (compaction markers and
 * raw transcript length exist in the JSONL) — proving the BLOCK is about PRECISION /
 * the missing-channel, not about raw observability.
 */
import { describe, it, expect } from 'vitest';
import { reflex } from '../src/brain/judge-reflex.js';
import { JUDGE_SYSTEM, INTERRUPT_ELIGIBLE_PHASES } from '../src/brain/prompt-coach-skill.js';
import { gatherLocalContext, type ProbeDeps } from '../src/brain/local-context-probe.js';

describe('F-V04 phase-handoff — WALL 1: the trigger word is reflex-suppressed', () => {
  it('a bare "continue" is suppressed at Tier-0 (never reaches Haiku/Sonnet)', () => {
    for (const word of ['continue', 'Continue', 'go on', 'proceed', 'next']) {
      const v = reflex(word);
      expect(v.suppress).toBe(true);
    }
  });

  it('a bare phase-switch ack ("ok") is also reflex-suppressed', () => {
    expect(reflex('ok').suppress).toBe(true);
    expect(reflex('yes').suppress).toBe(true);
  });
});

describe('F-V04 phase-handoff — WALL 2: a "continue with X" is a CONTINUATION (silenced)', () => {
  it('continuation is NOT an interrupt-eligible phase', () => {
    expect(INTERRUPT_ELIGIBLE_PHASES.has('continuation')).toBe(false);
    // Only new-task / escalation / ambiguous are ever interrupt-eligible.
    expect([...INTERRUPT_ELIGIBLE_PHASES].sort()).toEqual([
      'ambiguous',
      'escalation',
      'new-task',
    ]);
  });

  it('JUDGE_SYSTEM treats an anchored continuation as presumptively FINE', () => {
    expect(JUDGE_SYSTEM).toContain(
      'A continuation or correction anchored in recent context is presumptively FINE',
    );
  });
});

describe('F-V04 phase-handoff — WALL 3: no context-fullness / turn-count channel in the judge', () => {
  it('JUDGE_SYSTEM carries NO transcript-length / context-fullness / turn-count instruction', () => {
    const folded = JUDGE_SYSTEM.toLowerCase();
    // The F-V04 *premise* vocabulary (a degrading/full context, a turn count) is absent —
    // the judge cannot key on it because it is never threaded into the judge input.
    expect(folded).not.toContain('turn count');
    expect(folded).not.toContain('turn-count');
    expect(folded).not.toContain('context window');
    expect(folded).not.toContain('context is full');
    expect(folded).not.toContain('context fullness');
    expect(folded).not.toContain('nearly full');
  });

  it('the ONLY existing compact/handoff reference DEFERS to V04 (it does not implement it)', () => {
    // F-L16 (built) names V04 only to AVOID double-firing on a switch the dev already
    // handled — confirming V04 is a recognized-but-unbuilt, distinct concern.
    expect(JUDGE_SYSTEM).toContain('UNRELATED-SWITCH EXCEPTION');
    expect(JUDGE_SYSTEM).toContain("that is V04`s phase-boundary handoff — do NOT double-fire; defer to it");
  });
});

describe('F-V04 phase-handoff — the BLOCK is precision/channel, not raw observability', () => {
  // Compaction state and raw transcript length ARE cheaply observable in the JSONL
  // (the probe already does a permissive line scan). The block is NOT that the hook
  // cannot count turns — it is that the resulting signal cannot be made precision-safe
  // (WALL 1+2) and the *coaching premise* (context degrading) is a runtime-window fact,
  // not a pre-run prompt-quality signal the skill is allowed to coach on.
  function jsonl(lines: object[]): string {
    return lines.map((l) => JSON.stringify(l)).join('\n');
  }
  function deps(over: Partial<ProbeDeps>): ProbeDeps {
    return {
      transcriptPath: '/proj/.session.jsonl',
      cwd: '/proj',
      homeDir: '/home/dev',
      readFile: () => null,
      runGit: () => null,
      ...over,
    };
  }

  it('the probe could SEE a long transcript + a compaction marker (raw observability exists)', () => {
    // A realistic post-compact tail: an isCompactSummary line then more user turns.
    const raw = jsonl([
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: 'ok' } },
      { type: 'user', promptSource: 'typed', message: { role: 'user', content: 'continue with the logout flow' } },
    ]);
    // The probe reads the file without throwing and lifts the model — proving the JSONL is
    // readable and these fields are physically present. (The probe does NOT yet lift
    // turn-count or isCompactSummary; doing so is the future-unblock work, not this lever.)
    const ctx = gatherLocalContext(deps({ readFile: () => raw }));
    expect(ctx.activeModel).toBe('claude-opus-4-8');
    // No turn-count / compaction field exists on LocalContext today — the channel is absent.
    expect((ctx as Record<string, unknown>).turnCount).toBeUndefined();
    expect((ctx as Record<string, unknown>).compacted).toBeUndefined();
  });
});
