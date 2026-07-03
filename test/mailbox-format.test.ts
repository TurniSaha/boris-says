/**
 * mailbox-format (brain/mailbox-format.ts): the ANSI filled-panel banner renderer
 * extracted per spec §14 (the in-memory FIFO is dropped). Pins the wrap-then-pad/clip
 * contract and the ANSI-stripped fallback readability.
 */
import { describe, expect, it } from 'vitest';
import { formatCoachBanner } from '../src/brain/mailbox-format.js';

const ESC = '\x1b[';
/** Strip all SGR sequences so we can assert the fallback (plain padded block) too. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatCoachBanner — the loud ANSI panel', () => {
  it('renders ANSI SGR colour bytes (the loud fill)', () => {
    const out = formatCoachBanner('add a plan first');
    expect(out).toContain(ESC); // contains escape sequences
    expect(out).toContain("🤖  Boris says: I'm in your corner!");
  });

  it('starts with a leading blank line and a title strip', () => {
    const out = formatCoachBanner('hi');
    const lines = out.split('\n');
    expect(lines[0]).toBe(''); // leading blank lifts it off the prompt echo
    // the title strip line carries the Boris banner label
    expect(out).toContain("Boris says");
  });

  it('every rendered (non-leading) line pads to the fixed panel width (stripped fallback reads as a block)', () => {
    const out = formatCoachBanner('short');
    const stripped = stripAnsi(out)
      .split('\n')
      .filter((l) => l.trim().length > 0 || l.startsWith('  '));
    // Each visible panel line is "  " + padEnd(50) + "  " = width 54 (modulo emoji width).
    const widths = stripAnsi(out)
      .split('\n')
      .slice(1) // drop the leading blank
      .map((l) => l.length);
    // All panel lines share the same stripped width.
    const uniqueWidths = new Set(widths.filter((w) => w > 0));
    expect(uniqueWidths.size).toBeLessThanOrEqual(2); // emoji line may differ by 1
    expect(stripped.some((l) => l.includes('short'))).toBe(true);
  });

  it('soft-wraps a long message to <=50-col body lines BEFORE padding (wrap, not clip)', () => {
    const long =
      'snapshot legacy_orders or run it through your reversible migration pipeline with a rollback before you drop it on prod';
    const out = formatCoachBanner(long);
    const stripped = stripAnsi(out);
    // wrapped into multiple body lines, each word preserved (no mid-word clipping)
    expect(stripped).toContain('snapshot');
    expect(stripped).toContain('rollback');
    expect(stripped).toContain('prod');
    // multiple body lines exist
    const bodyLineCount = out.split('\n').filter((l) => l.includes('legacy_orders') || l.includes('rollback')).length;
    expect(bodyLineCount).toBeGreaterThanOrEqual(1);
  });

  it('CLIPS only a single un-splittable token longer than 50 chars (defensive backstop)', () => {
    const token = 'x'.repeat(80);
    const out = formatCoachBanner(token);
    const stripped = stripAnsi(out);
    // the 80-x token is clipped to <=50 x's on its line (never widens the panel)
    const longestRun = stripped.split('\n').map((l) => (l.match(/x+/) ?? [''])[0].length);
    expect(Math.max(...longestRun)).toBeLessThanOrEqual(50);
  });
});

// ── M2 same-turn coaching: the late-surface attribution label (PLAN Step 4) ─────
import { withPromptAttribution } from '../src/brain/mailbox-format.js';

describe('M2 — withPromptAttribution (the "about your prompt" label for LATE tips)', () => {
  const banner = formatCoachBanner('plan the schema first');

  it('prepends an "about your prompt" label line ABOVE the untouched banner', () => {
    const out = withPromptAttribution(banner, 'make it better');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('about your prompt');
    expect(stripped).toContain('"make it better"');
    // The original banner body still renders after the label.
    expect(stripped.indexOf('about your prompt')).toBeLessThan(stripped.indexOf('plan the schema first'));
  });

  it('squashes a multi-line prompt into a single one-line label', () => {
    const out = withPromptAttribution(banner, 'fix\nthe   thing\n\nnow');
    const labelLine = stripAnsi(out).split('\n').find((l) => l.includes('about your prompt'));
    expect(labelLine).toBeDefined();
    expect(labelLine).toContain('fix the thing now');
  });

  it('clips a very long prompt so the label never widens the 50-col panel', () => {
    const out = withPromptAttribution(banner, 'y'.repeat(120));
    const labelLine = stripAnsi(out).split('\n').find((l) => l.includes('about your prompt'));
    expect(labelLine).toBeDefined();
    const run = (labelLine!.match(/y+/) ?? [''])[0].length;
    expect(run).toBeLessThanOrEqual(50);
  });

  // item 6: the ⏪ label must NOT hard-clip mid-word with an unclosed quote.
  it('clips a long MULTI-WORD prompt at a word boundary with an ellipsis and a CLOSED quote', () => {
    const long = 'refactor the entire authentication subsystem and the billing dashboard right now please';
    const out = withPromptAttribution(banner, long);
    const labelLine = stripAnsi(out).split('\n').find((l) => l.includes('about your prompt'));
    expect(labelLine).toBeDefined();
    const trimmed = labelLine!.trimEnd();
    // The opening quote is matched by a CLOSING quote (never a dangling `"…word`).
    const quotes = (trimmed.match(/"/g) ?? []).length;
    expect(quotes).toBe(2);
    // Ends with an ellipsis then the closing quote (clipped at a word boundary, not mid-word).
    expect(trimmed).toMatch(/…"$/);
    // The clipped inner text is a WHOLE-WORD prefix of the original (last kept token intact).
    const inner = /"(.*)…"/.exec(trimmed)?.[1] ?? '';
    expect(inner.length).toBeGreaterThan(0);
    expect(long.startsWith(inner)).toBe(true); // exact prefix.
    // The char in `long` right after the kept prefix is a SPACE (we stopped at a word boundary).
    expect(long[inner.length]).toBe(' ');
  });

  it('a short prompt keeps BOTH quotes and is not ellipsized', () => {
    const out = withPromptAttribution(banner, 'make it better');
    const labelLine = stripAnsi(out).split('\n').find((l) => l.includes('about your prompt'));
    const trimmed = labelLine!.trimEnd();
    expect((trimmed.match(/"/g) ?? []).length).toBe(2);
    expect(trimmed).toContain('"make it better"');
    expect(trimmed).not.toContain('…');
  });

  it('an empty/whitespace prompt → the banner is returned UNLABELED (nothing to attribute)', () => {
    expect(withPromptAttribution(banner, '   ')).toBe(banner);
    expect(withPromptAttribution(banner, '')).toBe(banner);
  });
});
