/**
 * src/brain/mailbox-format.ts — the ANSI filled-panel banner renderer.
 *
 * EXTRACTION (spec §14) of the formatting half of the upstream coach service
 * `pm-service/src/coach/mailbox-nudge.ts`: `formatCoachBanner` + its private helpers
 * (`panelLine`, `wrapBody`) + the consts they depend on (`ESC`, `RESET`,
 * `PANEL_WIDTH = 50`, `TITLE`, `BODY`). The in-memory FIFO (`createMailboxNudge`,
 * `deposit`/`pendingNudge`, `TTL_MS`, `MAX_KEYS`, `QUEUE_CAP`, `QueuedNudge`,
 * `MailboxNudge`) is DROPPED — the on-disk mailbox store replaces it.
 *
 * Format one nudge as a LOUD, COLOURED, FILLED-PANEL banner so it is unmissable in the
 * Claude scrollback. EVERY line is a fixed-width coloured fill, so the whole block
 * renders as one solid rectangle — a title strip over a body panel. Width is NARROW so
 * it never wraps inside Claude's hook indent.
 *
 * ANSI SGR bytes survive the JSON/printf hook stdout path; the terminal renders them as
 * colour. If a renderer strips ANSI, the padded text + 🐾 emoji still read as a loud
 * block. Explicit 256-colour fg+bg (not reverse) keeps the fill predictable across
 * themes: 231=white, 16=black, 33=bright-blue, 226=bright-yellow; 1=bold; 0=reset.
 */
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const PANEL_WIDTH = 50; // narrow enough to never wrap inside Claude's hook indent.

/** Bold white on a bright-blue fill — the title strip. */
const TITLE = `${ESC}1;38;5;231;48;5;33m`;
/** Bold black on a bright-yellow fill — the body panel. */
const BODY = `${ESC}1;38;5;16;48;5;226m`;

/**
 * item 6: build the quoted, word-boundary-clipped attribution snippet so the whole label
 * fits `lineWidth` visible chars with the CLOSING quote intact (never `"…word` cut mid-word
 * by panelLine's hard slice). `budget` is the room left for the label AFTER the fixed prefix
 * `⏪ about your prompt: ` (computed by the caller). Short prompts pass through with both
 * quotes; a long one is clipped at the last whole word that fits, then `…"` is appended.
 */
const ATTRIBUTION_PREFIX = '⏪ about your prompt: ';

function clipQuoted(text: string, lineWidth: number): string {
  // Room for the inner text = line width − prefix − the two quotes.
  const innerBudget = lineWidth - ATTRIBUTION_PREFIX.length - 2;
  if (innerBudget <= 1) return '""'; // pathological narrow panel — never throw.
  if (text.length <= innerBudget) return `"${text}"`;
  // Reserve one char for the ellipsis, then keep whole words up to that budget.
  const ellipsisBudget = innerBudget - 1;
  const words = text.split(' ');
  let kept = '';
  for (const w of words) {
    const next = kept.length === 0 ? w : `${kept} ${w}`;
    if (next.length > ellipsisBudget) break;
    kept = next;
  }
  // If even the first word overflows, hard-clip THAT word (still closes the quote).
  if (kept.length === 0) kept = text.slice(0, ellipsisBudget);
  return `"${kept}…"`;
}

/** Render one visible line as a fixed-width coloured fill (clean rectangle edge). */
function panelLine(colour: string, text: string): string {
  const clipped = text.length > PANEL_WIDTH ? text.slice(0, PANEL_WIDTH) : text;
  return `${colour}  ${clipped.padEnd(PANEL_WIDTH, ' ')}  ${RESET}`;
}

/** Soft-wrap a message body to the panel width, preserving any existing newlines. */
function wrapBody(message: string, width: number): string[] {
  return message
    .split('\n')
    .flatMap((line) => {
      const words = line.split(/\s+/).filter((w) => w.length > 0);
      const out: string[] = [];
      let cur = '';
      for (const w of words) {
        if (cur.length === 0) cur = w;
        else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
        else {
          out.push(cur);
          cur = w;
        }
      }
      if (cur.length > 0) out.push(cur);
      return out.length > 0 ? out : [''];
    });
}

/**
 * The F-FEEDBACK rate hint footer (owner choice: "thumbs in the banner"). Shown ONLY on a
 * real coaching tip — never on a bare liveness ping/sentinel (you can't rate a ping).
 */
const RATE_HINT = 'rate this: /coach 👍 or 👎  ·  /coach undo';

/**
 * Build the filled-panel banner: a title strip + body panel, every line padded to the
 * same width so it reads as one solid coloured block. A leading blank line lifts it off
 * the prompt echo; an empty title/body row gives the fill some height.
 *
 * @param message the nudge body.
 * @param opts.withRateHint append the F-FEEDBACK "rate this: 👍/👎" footer (real tips only).
 */
/**
 * M2 same-turn coaching (PLAN Step 4): label a tip that surfaces LATE — i.e. NOT on the
 * turn it judged (the UPS next-turn backstop, or a Stop drain that claimed a prior turn's
 * tip). Prepends ONE title-styled filled line `⏪ about your prompt: "<prompt>"` above the
 * already-rendered banner, so the dev always knows WHICH prompt the advice is about.
 * The prompt is squashed to one line; panelLine clips it to the 50-col panel width.
 * An empty/whitespace prompt returns the banner unchanged (nothing to attribute).
 */
export function withPromptAttribution(banner: string, aboutPrompt: string): string {
  const squashed = aboutPrompt.split(/\s+/).filter((w) => w.length > 0).join(' ');
  if (squashed.length === 0) return banner;
  const label = panelLine(TITLE, `⏪ about your prompt: ${clipQuoted(squashed, PANEL_WIDTH)}`);
  // The banner starts with a leading blank line ('\n…'); keep that lift, put the label
  // directly above the title strip.
  return banner.startsWith('\n') ? `\n${label}${banner}` : `\n${label}\n${banner}`;
}

export function formatCoachBanner(message: string, opts: { withRateHint?: boolean } = {}): string {
  const bodyLines = wrapBody(message, PANEL_WIDTH);
  const footer = opts.withRateHint === true ? [panelLine(BODY, RATE_HINT)] : [];
  return [
    '',
    panelLine(TITLE, ''),
    panelLine(TITLE, '🤖  Boris says: I\'m in your corner!'),
    panelLine(TITLE, ''),
    ...bodyLines.map((l) => panelLine(BODY, l)),
    ...footer,
    panelLine(BODY, ''),
  ].join('\n');
}
