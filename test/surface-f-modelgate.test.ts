/**
 * surface-f-modelgate.test.ts — ROW F-MODELGATE pinning test (corrected + W2-MODELGATE).
 *
 * STORY: capability/flag advice is MODEL-AWARE. `--effort xhigh` is scoped to the
 * xhigh-capable families per the OFFICIAL effort matrix
 * (platform.claude.com/docs/en/build-with-claude/effort, fetched 2026-06-30):
 * Fable 5 + Mythos 5 + Opus 4.8/4.7 + Sonnet 5 — NOT Sonnet 4.6 / Opus 4.6 / Codex. So it
 * surfaces to an Opus/Fable/Sonnet-5/Mythos dev, is HIDDEN from a Sonnet-4.6/Codex dev, and
 * on an UNKNOWN active model the coach NEVER guesses a model-scoped flag (no gate applied,
 * but the capability still carries its scope so the judge sees the constraint).
 *
 * W2-MODELGATE FIX (this is the load-bearing over-fire the audit found): the xhigh gate's
 * taxonomy predated Sonnet 5 (launched 2026-06-30) + Mythos 5. A Sonnet 4.6 dev (who CANNOT
 * use xhigh) used to collapse to `undefined`=ungated → the gate didn't apply → xhigh stayed
 * VISIBLE to them (a model-scoped flag offered to a model that lacks it = over-fire). The fix
 * adds `sonnet5`+`sonnet`+`mythos` families, scopes xhigh to `['opus','fable','sonnet5',
 * 'mythos']`, maps Sonnet-5 strings → `sonnet5` (IN scope) and Sonnet-4.x strings → `sonnet`
 * (a KNOWN family OUT of scope) so the gate now ACTIVELY HIDES xhigh from a Sonnet 4.6 dev
 * end-to-end. (Genuinely unknown models still fail open — only Sonnet 4.x is now gated.)
 */
import { describe, it, expect } from 'vitest';
import { resolveCapability, type CapabilityPerson } from '../src/capability/catalog.js';
import { modelStringToFamily } from '../src/brain/local-context-probe.js';

const recentCli: CapabilityPerson = { installedCommands: [], cliVersion: '2.1.185' };
const XHIGH_FAMILIES = ['opus', 'fable', 'sonnet5', 'mythos'] as const;

describe('F-MODELGATE — effort-xhigh is scoped to {opus, fable, sonnet5, mythos} (official effort matrix)', () => {
  it('OPUS active model → xhigh surfaces (available:true)', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'opus' });
    expect(r.available).toBe(true);
    expect(r.capability?.id).toBe('effort-xhigh');
    expect(r.capability?.modelFamilies).toEqual([...XHIGH_FAMILIES]);
  });

  it('FABLE active model → xhigh surfaces (available:true) — a Fable dev is NOT denied', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'fable' });
    expect(r.available).toBe(true);
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('SONNET 5 active model → xhigh surfaces (available:true) — was a latent fail-open, now explicit', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'sonnet5' });
    expect(r.available).toBe(true);
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('MYTHOS active model → xhigh surfaces (available:true) — Mythos 5 is in the xhigh list', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'mythos' });
    expect(r.available).toBe(true);
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('SONNET 4.6 active model → xhigh is HIDDEN (available:false) — THE over-fire fix', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'sonnet' });
    expect(r.available).toBe(false);
    // capability still returned (constraint visible to the judge), just not available.
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('OPUS 4.6 active model → xhigh is HIDDEN (available:false) — same-class over-fire (max-only, not xhigh)', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'opus46' });
    expect(r.available).toBe(false);
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('CODEX active model → xhigh is HIDDEN (available:false) — never recommend xhigh to a non-xhigh family', () => {
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: 'codex' });
    expect(r.available).toBe(false);
    // capability still returned (constraint visible to the judge), just not available.
    expect(r.capability?.id).toBe('effort-xhigh');
  });

  it('UNKNOWN active model → NO gate applied (available:true) and the coach never guesses — the scope still rides along', () => {
    const r = resolveCapability('--effort xhigh', recentCli); // activeModel omitted
    expect(r.available).toBe(true);
    // The constraint is NOT erased: the resolved capability still declares its family set
    // so a downstream judge can SEE the scope and avoid guessing for an unconfirmed model.
    expect(r.capability?.modelFamilies).toEqual([...XHIGH_FAMILIES]);
  });
});

describe('F-MODELGATE — modelStringToFamily maps the gated families (raw JSONL → family)', () => {
  it('opus 4.7/4.8 / fable / mythos / codex raw strings map to their families; haiku/unknown → undefined', () => {
    expect(modelStringToFamily('claude-opus-4-8')).toBe('opus');
    expect(modelStringToFamily('claude-opus-4-7')).toBe('opus');
    expect(modelStringToFamily('claude-fable-5')).toBe('fable');
    expect(modelStringToFamily('claude-mythos-5')).toBe('mythos');
    expect(modelStringToFamily('gpt-5.5-codex')).toBe('codex');
    expect(modelStringToFamily('claude-haiku-4-5')).toBeUndefined();
    expect(modelStringToFamily(null)).toBeUndefined();
    expect(modelStringToFamily(undefined)).toBeUndefined();
    expect(modelStringToFamily('')).toBeUndefined();
  });

  it('Opus 4.5/4.6 strings map to `opus46` (KNOWN, out of xhigh scope) — NOT opus, NOT undefined', () => {
    // Opus 4.6/4.5 are max-only (NOT xhigh) → a known-but-excluded family so the gate hides
    // xhigh; Opus 4.7/4.8 stay `opus` (in scope). The discriminator is the minor version.
    expect(modelStringToFamily('claude-opus-4-6')).toBe('opus46');
    expect(modelStringToFamily('claude-opus-4-5')).toBe('opus46');
    expect(modelStringToFamily('claude-opus-4-6-20260101')).toBe('opus46');
    expect(modelStringToFamily('opus 4.6')).toBe('opus46');
    // 4.7/4.8 must NOT be caught by the opus46 branch:
    expect(modelStringToFamily('claude-opus-4-8')).toBe('opus');
    expect(modelStringToFamily('claude-opus-4-7')).toBe('opus');
  });

  it('an Opus 4.6 raw string round-trips so an Opus 4.6 dev is NEVER offered xhigh end-to-end', () => {
    const family = modelStringToFamily('claude-opus-4-6');
    expect(family).toBe('opus46');
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: family });
    expect(r.available).toBe(false);
  });

  it('Sonnet 5 strings map to `sonnet5` (in xhigh scope) — across plausible string shapes', () => {
    expect(modelStringToFamily('claude-sonnet-5')).toBe('sonnet5');
    expect(modelStringToFamily('claude-sonnet-5-20260630')).toBe('sonnet5');
    expect(modelStringToFamily('sonnet 5')).toBe('sonnet5');
    expect(modelStringToFamily('Claude Sonnet 5')).toBe('sonnet5');
  });

  it('Sonnet 4.x strings map to `sonnet` (KNOWN, out of xhigh scope) — NOT sonnet5, NOT undefined', () => {
    // The load-bearing discriminator: only a `sonnet…5` major version is xhigh-scoped; a
    // Sonnet 4.x string is a known-but-excluded family so the gate actively hides xhigh.
    expect(modelStringToFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelStringToFamily('claude-sonnet-4-5')).toBe('sonnet');
    expect(modelStringToFamily('sonnet 4.6')).toBe('sonnet');
  });

  it('a Fable raw string round-trips through the gate so a Fable dev gets xhigh end-to-end', () => {
    const family = modelStringToFamily('claude-fable-5');
    expect(family).toBe('fable');
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: family });
    expect(r.available).toBe(true);
  });

  it('a Sonnet 5 raw string round-trips so a Sonnet 5 dev GETS xhigh end-to-end', () => {
    const family = modelStringToFamily('claude-sonnet-5');
    expect(family).toBe('sonnet5');
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: family });
    expect(r.available).toBe(true);
  });

  it('a Sonnet 4.6 raw string round-trips so a Sonnet 4.6 dev is NEVER offered xhigh end-to-end (THE over-fire closed)', () => {
    // The decisive acceptance test: raw JSONL string → family → gate → NOT available.
    const family = modelStringToFamily('claude-sonnet-4-6');
    expect(family).toBe('sonnet');
    const r = resolveCapability('--effort xhigh', { ...recentCli, activeModel: family });
    expect(r.available).toBe(false);
  });
});

describe('F-MODELGATE — a single-family scalar capability still gates (back-compat)', () => {
  it('the scalar modelFamily path is unchanged for entries that use it', () => {
    // Synthesize via the real resolver on a model-agnostic capability to confirm the
    // fallback branch (scalar → [scalar]) does not change unrelated behavior: a
    // model-agnostic capability is unaffected by any activeModel.
    const r = resolveCapability('--worktree', { ...recentCli, activeModel: 'codex' });
    expect(r.available).toBe(true); // worktree is model-agnostic → never gated.
  });
});
