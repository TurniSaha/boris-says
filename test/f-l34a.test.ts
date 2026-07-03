/**
 * F-L34a — PRE-RUN "ask for the simplest viable solution" (anti-overengineering, pre-prompt).
 *
 * DISPOSITION: report-only / INERT by SPEC DESIGN, NOT a firing lever this run.
 *
 * TUNING-SPEC §A0 (lines ~907-924) + §A.GATE-MATRIX (lines ~592-631) freeze
 * `l34a_mode = disabled_report_only` by DEFAULT. Emission is legal ONLY in
 * `required_best_practice` (needs a `check-ledger`-certified strict-primary PRE-RUN
 * simplicity quote — there is NO `source-ledger.json` row on disk) or
 * `required_local_empirical` (needs a `policy-evidence-ledger.json` row — also absent).
 * Neither certifying artifact exists, so the ONLY legal mode is the report-only default,
 * in which L34a:
 *   - EMITS NOTHING in production,
 *   - has NO production prompt clause in `PROMPT_COACH_SKILL` / `JUDGE_SYSTEM`,
 *   - has NO cascade path eligible for display or delivery,
 *   - is INERT in every gate.
 * The doc-backed anti-overengineering lever is the POST-DIFF sibling L34b
 * (`primary overeng-1` + `supporting doc-overeng`). Its prompt-path runtime
 * (`l34b_mode = next_prompt_budgeted`) was DEMOTED by the M1 relevance overhaul (it was
 * the live silence-filling violation); the anti-overengineering advice now rides the
 * SessionEnd outcome recap (outcome-signals.ts prune clause), NOT L34a and NOT a
 * per-prompt lever.
 *
 * This is the CONFORMANCE GUARD for that frozen inert contract. It is NOT a firing-lever
 * contract test (there is no L34a firing path to test). It PINS that no L34a pre-run
 * "ask-for-simpler" clause has leaked into the shared judge prompt — adding one would
 * violate the spec ("has NO production prompt clause in PROMPT_COACH_SKILL") and the
 * no-ungated-emission invariant ("there is NO state in which L34a EMITS without being
 * REQUIRED"). If a future FRESH run flips `l34a_mode` to an emitting+REQUIRED value with
 * a certifying ledger row, THIS guard is the thing that gets deliberately replaced.
 */
import { describe, it, expect } from 'vitest';
import { JUDGE_SYSTEM, PROSPECTOR_SYSTEM, PROMPT_COACH_SKILL } from '../src/brain/prompt-coach-skill.js';

describe('F-L34a — pre-run-simplest lever is report-only / INERT by spec (no firing clause)', () => {
  it('JUDGE_SYSTEM carries NO pre-run "ask for the simplest viable solution" clause', () => {
    const folded = JUDGE_SYSTEM.toLowerCase();
    // The spec's L34a trigger string and its lexical neighbours must NOT appear as a
    // pre-run firing instruction in the shared judge prompt.
    expect(folded).not.toContain('simplest thing that works');
    expect(folded).not.toContain('simplest viable');
    expect(folded).not.toContain('ask for the simplest');
    expect(folded).not.toContain('l34a');
  });

  it('PROSPECTOR_SYSTEM carries NO pre-run simplicity-ask escalation cue', () => {
    const folded = PROSPECTOR_SYSTEM.toLowerCase();
    expect(folded).not.toContain('simplest thing that works');
    expect(folded).not.toContain('simplest viable');
    expect(folded).not.toContain('ask for the simplest');
  });

  it('the shipped skill exposes NO l34a emission knob (no firing path) and L34a is not a rubric dimension', () => {
    // PROMPT_COACH_SKILL is the entire shipped rubric surface. It must not carry an L34a
    // lever/dimension/mode — emission is gated OUT at the spec level, not in code here.
    const serialized = JSON.stringify({
      version: PROMPT_COACH_SKILL.version,
      dimensions: PROMPT_COACH_SKILL.dimensions,
    }).toLowerCase();
    expect(serialized).not.toContain('l34a');
    expect(serialized).not.toContain('simplest');
    // The rubric dimension ids are the only levers the judge can name as primary_lever;
    // none of them is a pre-run-simplicity lever.
    const dimIds = PROMPT_COACH_SKILL.dimensions.map((d) => d.id);
    expect(dimIds).not.toContain('l34a');
    expect(dimIds).not.toContain('pre_run_simplest');
    expect(dimIds).not.toContain('simplicity');
  });
});
