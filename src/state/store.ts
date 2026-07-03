/**
 * Atomic JSON state store for the prompt-coach plugin.
 *
 * All state lives under ~/.claude/prompt-coach/ (SPEC §2). Writes are
 * temp-sibling-then-rename so a crash never leaves a partial file. Reads never
 * throw: a missing or corrupt file yields the caller's fallback.
 *
 * Single user, single machine — these files are the source of truth (SPEC §0).
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendWithheld,
  recordObservation,
  resolveWatch,
  stateShowsEngagement,
  windowClosed,
  type WatchState,
  type WithheldTip,
} from './watch.js';

// ── Constants (SPEC §5.1 step 3, §7.4) ──────────────────────────────────────
export const QUALITY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between quality tips
export const HABIT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours between habit nudges
export const MAILBOX_CAP = 3; // cap tips queued per session (SPEC §8.2)
/** Cap the per-session quality-cooldown map (most-recent N by timestamp) so state.json can't
 *  grow unbounded across many sessions (mirrors the greetedSessions cap). */
export const QUALITY_TIP_SESSIONS_CAP = 500;
/**
 * M2 [A2]: cap on the judged-turn ring (`state.judgedTurns`). Each entry is one turnId;
 * the Stop poll only ever asks about the CURRENT turn, so a small ring is plenty.
 */
export const JUDGED_TURNS_CAP = 200;

// ── F-FEEDBACK tunables (live self-tuning from owner 👍/👎 ratings) ───────────
/**
 * The per-lever adaptive floor only kicks in after this many TOTAL ratings on a lever
 * (owner choice: "after N ratings" — a single rating never swings firing).
 */
export const FEEDBACK_MIN_RATINGS = 3;
/**
 * The MAX confidence-floor delta a lever's feedback can apply, in EITHER direction. A lever
 * the owner keeps marking 👎 raises its firing floor by up to +this (fires less); a 👍-loved
 * lever lowers it by up to -this (fires more). Bounded so feedback nudges, never flips.
 */
export const FEEDBACK_MAX_DELTA = 0.2;

export const DEFAULT_BASE_DIR = join(homedir(), '.claude', 'prompt-coach');

/**
 * Owner-only permission bits for everything the coach writes under ~/.claude/prompt-coach/.
 * These files carry the user's VERBATIM prompt text (state.json, mailbox/inbox tips, the
 * feedback-anchor corpus, habit drafts), so on a shared multi-user host a co-tenant local
 * user must not be able to read them. Directories are 0700 (owner rwx only); files are 0600
 * (owner rw only). The default umask (022) would otherwise leave these world+group readable.
 */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

// ── Types ───────────────────────────────────────────────────────────────────
/**
 * F-FEEDBACK: the last quality tip surfaced (lever + prompt), so a `/coach 👍/👎` rating can
 * attribute to it. Set when a real coaching tip fires (a lever rode); cleared on rating/undo.
 */
export interface LastTip {
  readonly lever: string;
  readonly prompt: string;
  readonly sessionId: string;
  readonly at: number;
}

/** F-FEEDBACK: per-lever rating tally — the basis for the adaptive firing floor. */
export interface LeverFeedback {
  readonly good: number;
  readonly bad: number;
}

export interface CoachState {
  enabled: boolean;
  /**
   * The GLOBAL last-quality-tip time (kept for the `/coach` status display + back-compat).
   * The CADENCE gate uses the PER-SESSION map below, not this — a tip in one session must not
   * throttle coaching in another (the cross-session "intro then nothing" bleed).
   */
  lastQualityTipAt: number | null;
  /** sessionId → the time that session last fired a real quality tip (the per-session cooldown). */
  lastQualityTipBySession: Record<string, number>;
  lastHabitNudgeAt: number | null;
  lastMinedAt: number | null;
  lastMinedWatermark: number;
  /** sessionId → primary levers already fired this session (SPEC §5.1 step 7). */
  leversUsedBySession: Record<string, string[]>;
  lastSurfacedPatternKey: string | null;
  /** F-FEEDBACK: the last fired quality tip (for 👍/👎 attribution), or null. */
  lastTip: LastTip | null;
  /** F-FEEDBACK: per-lever 👍/👎 tallies — drives the adaptive per-lever confidence floor. */
  feedbackByLever: Record<string, LeverFeedback>;
  /** F-FEEDBACK: the last rating applied (for `/coach undo`), or null. */
  lastRating: { readonly lever: string; readonly rating: 'good' | 'bad'; readonly tip: LastTip } | null;
  /**
   * Session ids that have already received the one-time "Boris connected" welcome ping.
   * PERSISTED (the judge runs as a fresh process per prompt, so an in-memory flag would
   * re-greet every turn — the live bug). The ping fires once per session, then stays quiet.
   */
  greetedSessions: string[];
  /**
   * Item 3: has the ONCE-PER-INSTALL first-run tour been shown? Persisted install-wide (NOT
   * per-session — the every-session ping died). Defaults false; an ENGAGED legacy install
   * (stateShowsEngagement) is treated as already-toured at read time so upgraders never get a
   * surprise tour (mirrors the M5 watch migration rule). A legacy state.json without the key
   * parses as false via the defaultState merge, then the engagement guard closes it.
   */
  tourShown: boolean;
  /**
   * W2-OUTCOME: session ids that have already shown the once-per-session "Last session" recap.
   * SEPARATE from `greetedSessions` on purpose — the recap and the welcome ping both gate on
   * "first prompt of this session," so they must not consume EACH OTHER's flag. Fixes the
   * mid-session recap pop (a compact / 2nd prompt must not re-surface it).
   */
  outcomeRecapShownSessions: string[];
  /**
   * M2 [A2]: turnIds the judge has FINISHED judging (deposited OR silent). The Stop-hook
   * poll exits the instant it sees the current turn's id here with no tip waiting — a
   * silent (well-formed) turn therefore never stalls the turn end. Capped ring.
   */
  judgedTurns: string[];
  /**
   * G-M4b: when the runtime external-skill-index auto-refresh last ATTEMPTED a fetch
   * (success or failure — the attempt advances it, so an offline machine makes at most
   * one network touch per cooldown). null = never attempted (legacy state parses null
   * by the defaultState merge). Milliseconds since epoch.
   */
  lastIndexRefreshAt: number | null;
  /**
   * M5 watch-first critique mode: the observe-only window state, or null = "not yet
   * initialized." null resolves LAZILY (watch.ts resolveWatch): an install whose state
   * already shows engagement (ratings / greeted sessions / prior tips) is pre-closed +
   * pre-announced (the owner sees zero change); a fresh install gets an open window.
   * Back-compat by construction — a legacy state.json without the key parses unchanged.
   */
  watch: WatchState | null;
}

export type TipKind = 'quality' | 'habit';

export interface Tip {
  kind: TipKind;
  message: string;
  /**
   * M2: the VERBATIM judged prompt this tip is about (real coaching tips only — a bare
   * liveness ping/sentinel carries none). Lets a LATE surface (next-turn backstop) render
   * the `about your prompt: "…"` attribution label. Optional for back-compat.
   */
  prompt?: string;
  /** M2: `${session_id}#<nonce>` of the judged turn — attribution + dedupe. Optional (back-compat). */
  turnId?: string;
}

export interface InboxPayload {
  prompt: string;
  transcript_path: string;
  session_id: string;
  cwd: string;
  /** M2: the turn id minted by the UPS hook for THIS prompt (rides to the judge). Optional (back-compat). */
  turn_id?: string;
}

export function defaultState(): CoachState {
  return {
    enabled: true,
    lastQualityTipAt: null,
    lastQualityTipBySession: {},
    lastHabitNudgeAt: null,
    lastMinedAt: null,
    lastMinedWatermark: 0,
    leversUsedBySession: {},
    lastSurfacedPatternKey: null,
    lastTip: null,
    feedbackByLever: {},
    lastRating: null,
    greetedSessions: [],
    tourShown: false,
    outcomeRecapShownSessions: [],
    judgedTurns: [],
    lastIndexRefreshAt: null,
    watch: null,
  };
}

// ── F-FEEDBACK: the adaptive per-lever floor delta (PURE) ─────────────────────
/**
 * Compute the confidence-floor DELTA for a lever from its 👍/👎 tally. The owner's design:
 * apply nothing until ≥ FEEDBACK_MIN_RATINGS total ratings on the lever (no single-rating
 * swing); then shift the floor toward the owner's verdict, bounded to ±FEEDBACK_MAX_DELTA.
 *   - mostly 👎 → POSITIVE delta (raise the floor → the lever fires LESS)
 *   - mostly 👍 → NEGATIVE delta (lower the floor → the lever fires MORE)
 * The magnitude scales with the net signal fraction (bad-good)/total, capped. PURE.
 */
export function adaptiveFloorDelta(fb: LeverFeedback | undefined): number {
  if (!fb) return 0;
  const total = fb.good + fb.bad;
  if (total < FEEDBACK_MIN_RATINGS) return 0; // not enough signal yet (owner: "after N ratings").
  const net = (fb.bad - fb.good) / total; // +1 = all bad → raise floor; -1 = all good → lower.
  const delta = net * FEEDBACK_MAX_DELTA;
  // Clamp defensively (net ∈ [-1,1] already, but guard rounding).
  return Math.max(-FEEDBACK_MAX_DELTA, Math.min(FEEDBACK_MAX_DELTA, delta));
}

// ── Primitive atomic IO ──────────────────────────────────────────────────────
/** Write `obj` as JSON via a temp sibling + atomic rename. Never leaves a partial. */
export function writeJsonAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  // Unique temp suffix so two concurrent writers to the same target never
  // share a temp file (the rename is the atomic commit point).
  const tmp = `${path}.tmp.${process.pid}.${monotonic()}`;
  // mode 0600: the committed file carries verbatim prompt text — owner-only.
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: FILE_MODE });
  renameSync(tmp, path);
}

/** Read JSON at `path`, returning `fallback` on missing/corrupt/empty. Never throws. */
export function readJson<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
  if (raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Monotonic suffix for collision-free file names (SPEC §8.1) ────────────────
let counter = 0;
function monotonic(): string {
  counter += 1;
  const hr = process.hrtime.bigint();
  return `${Date.now()}-${hr}-${counter}`;
}

// ── Store factory ─────────────────────────────────────────────────────────────
export interface Store {
  getState(): CoachState;
  saveState(state: CoachState): void;

  markQualityTip(now: number, sessionId?: string, lever?: string): void;
  markHabitNudge(now: number, patternKey: string): void;
  qualityOnCooldown(now: number): boolean;
  habitOnCooldown(now: number): boolean;
  leverUsedInSession(sessionId: string, lever: string): boolean;

  writeMailbox(sessionId: string, tip: Tip): void;
  readAndClearMailbox(sessionId: string): Tip[];
  /**
   * M2: ATOMICALLY claim the session's mailbox via rename (mailbox/<safe>.json →
   * a unique .claim sibling), then read + unlink the claim file. A concurrent judge
   * `writeMailbox` (read-append-write) either lands BEFORE the rename (claimed here) or
   * AFTER it (a fresh mailbox for the next drain) — no torn read, no lost tip. The
   * rename IS the consume-once: whichever of Stop/UPS wins it surfaces the tip.
   * Never throws; no mailbox → []. Quality-before-habit ordering, same as readAndClear.
   */
  claimMailbox(sessionId: string): Tip[];
  /** M2: record the turn id the UPS hook minted for THIS prompt (the Stop hook reads it). */
  beginTurn(sessionId: string, turnId: string): void;
  /** M2: the turn id recorded by beginTurn for this session, or null. Never throws. */
  currentTurn(sessionId: string): string | null;
  /** M2 [A2]: the judge marks a turn FINISHED (deposited OR silent) at the end of its run. */
  markTurnJudged(sessionId: string, turnId: string): void;
  /** M2 [A2]: has the judge finished judging this turn? (Stop-poll fast-exit on silent turns.) */
  wasTurnJudged(sessionId: string, turnId: string): boolean;

  writeInbox(payload: InboxPayload): string;
  readAndUnlinkInbox(path: string): InboxPayload | null;

  /** F-FEEDBACK: record the last fired quality tip (lever + prompt) for 👍/👎 attribution. */
  recordLastTip(tip: LastTip): void;
  /**
   * F-FEEDBACK: rate the LAST tip 👍 (good) or 👎 (bad). Increments that lever's tally, stores
   * the prior tally for undo, and CLEARS lastTip (one rating per tip). Returns the rated
   * LastTip (for the feedback-anchor corpus) + the rating, or null when there is nothing to rate.
   */
  rateLastTip(rating: 'good' | 'bad'): { tip: LastTip; rating: 'good' | 'bad' } | null;
  /** F-FEEDBACK: undo the last rating (decrement its lever tally), or null if none. */
  undoLastRating(): { lever: string; rating: 'good' | 'bad' } | null;
  /**
   * Returns true the FIRST time a session id is seen (and records it), false thereafter —
   * the persistent, cross-process replacement for the in-memory first-seen Map. Used to fire
   * the "Boris connected" welcome exactly once per session.
   */
  markGreetedIfFirst(sessionId: string): boolean;
  /**
   * Item 3: true EXACTLY ONCE PER INSTALL — the first call on a fresh install (sets
   * tourShown=true in the same write), false forever after and false when the save fails.
   * An ENGAGED legacy install (stateShowsEngagement) that predates the flag returns false
   * (no surprise tour on upgrade — the M5 migration rule). No sessionId: it is install-wide.
   */
  markTourShownIfFirst(): boolean;
  /**
   * W2-OUTCOME: true the FIRST time this session asks to show the "Last session" recap; false
   * after (once-per-session). SEPARATE flag from the welcome ping so neither consumes the
   * other's first-prompt gate.
   */
  markOutcomeRecapShownIfFirst(sessionId: string): boolean;
  /** F-FEEDBACK: the current adaptive floor delta for a lever (0 until ≥ N ratings). */
  floorDeltaForLever(lever: string): number;

  /**
   * M5: count one observation (a typed prompt in `sessionId`) into the watch window,
   * resolving a null watch migration-aware first (watch.ts resolveWatch). Persists and
   * returns the updated window. NEVER throws — a failed save returns the computed value
   * unpersisted (an under-count, harmless).
   */
  observeWatch(sessionId: string, now: number): WatchState;
  /** M5: append one withheld critique to the capped log (count + last few). Never throws. */
  recordWithheldTip(entry: WithheldTip): void;
  /**
   * M5: true exactly ONCE — on the first call where the window is closed and the announce
   * has not yet surfaced (sets announced=true in the same write). False while open, false
   * forever after, and false when the save fails (the announce must never repeat).
   */
  markAnnouncedIfFirst(now: number): boolean;
}

/**
 * Keep only the `cap` entries with the highest (most-recent) numeric values. PURE. Used to
 * bound the per-session quality-cooldown map; entries below the cooldown horizon are stale.
 */
export function capByValue(map: Record<string, number>, cap: number): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= cap) return map;
  const kept = keys.sort((a, b) => map[b] - map[a]).slice(0, cap);
  const out: Record<string, number> = {};
  for (const k of kept) out[k] = map[k];
  return out;
}

export function createStore(baseDir: string = DEFAULT_BASE_DIR): Store {
  const statePath = join(baseDir, 'state.json');
  const mailboxPath = (sessionId: string) =>
    join(baseDir, 'mailbox', `${safeName(sessionId)}.json`);
  const inboxDir = join(baseDir, 'inbox');
  const turnPath = (sessionId: string) =>
    join(baseDir, 'turns', `${safeName(sessionId)}.json`);

  function getState(): CoachState {
    // Merge over defaults so a partial/older state file is forward-compatible.
    return { ...defaultState(), ...readJson<Partial<CoachState>>(statePath, {}) };
  }

  function saveState(state: CoachState): void {
    writeJsonAtomic(statePath, state);
  }

  function markQualityTip(now: number, sessionId?: string, lever?: string): void {
    const s = getState();
    // Update BOTH the global field (for /coach status) and the per-session cooldown map (the
    // gate). The per-session stamp is what prevents one session throttling another.
    const next: CoachState = { ...s, lastQualityTipAt: now };
    if (sessionId) {
      // ?? guards an old on-disk state missing the field. Cap to the most-recent
      // QUALITY_TIP_SESSIONS_CAP sessions by timestamp so the map can't grow unbounded on a
      // long-lived state.json (mirrors the greetedSessions .slice(-500) cap); entries older
      // than the 10-min cooldown are never read-relevant anyway.
      next.lastQualityTipBySession = capByValue(
        { ...(s.lastQualityTipBySession ?? {}), [sessionId]: now },
        QUALITY_TIP_SESSIONS_CAP,
      );
    }
    if (sessionId && lever) {
      const used = next.leversUsedBySession[sessionId] ?? [];
      if (!used.includes(lever)) {
        next.leversUsedBySession = {
          ...next.leversUsedBySession,
          [sessionId]: [...used, lever],
        };
      }
    }
    saveState(next);
  }

  function markHabitNudge(now: number, patternKey: string): void {
    const s = getState();
    saveState({ ...s, lastHabitNudgeAt: now, lastSurfacedPatternKey: patternKey });
  }

  function qualityOnCooldown(now: number): boolean {
    const at = getState().lastQualityTipAt;
    return at !== null && now - at < QUALITY_COOLDOWN_MS;
  }

  function habitOnCooldown(now: number): boolean {
    const at = getState().lastHabitNudgeAt;
    return at !== null && now - at < HABIT_COOLDOWN_MS;
  }

  function leverUsedInSession(sessionId: string, lever: string): boolean {
    return (getState().leversUsedBySession[sessionId] ?? []).includes(lever);
  }

  function writeMailbox(sessionId: string, tip: Tip): void {
    const path = mailboxPath(sessionId);
    const existing = readJson<Tip[]>(path, []);
    // Keep the newest MAILBOX_CAP tips (drop the oldest on overflow).
    const next = [...existing, tip].slice(-MAILBOX_CAP);
    writeJsonAtomic(path, next);
  }

  function readAndClearMailbox(sessionId: string): Tip[] {
    // M2: delegate to the atomic claim so BOTH drains (UPS + Stop) share ONE
    // consume-once mechanism — the rename. (The old read-then-overwrite-with-[]
    // implementation had a torn-read window against a concurrent judge write.)
    return claimMailbox(sessionId);
  }

  function claimMailbox(sessionId: string): Tip[] {
    const path = mailboxPath(sessionId);
    // Unique claim name: two concurrent claimers can never collide, and only ONE
    // rename of the same source can succeed — that rename is the consume-once.
    const claimPath = `${path}.claim.${process.pid}.${monotonic()}`;
    try {
      renameSync(path, claimPath);
    } catch {
      return []; // no mailbox (or lost the race) → nothing to claim.
    }
    const tips = readJson<Tip[]>(claimPath, []);
    try {
      unlinkSync(claimPath);
    } catch {
      // best effort — a leaked claim file is inert (unique name, never re-read).
    }
    // Quality before habit on a tie; otherwise preserve insertion order (stable sort).
    return [...tips].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  }

  // ── M2: per-session turn marker (UPS writes it; the Stop poll reads it) ────────
  function beginTurn(sessionId: string, turnId: string): void {
    if (!sessionId || !turnId) return;
    writeJsonAtomic(turnPath(sessionId), { turnId });
  }

  function currentTurn(sessionId: string): string | null {
    if (!sessionId) return null;
    const rec = readJson<{ turnId?: unknown } | null>(turnPath(sessionId), null);
    return rec !== null && typeof rec.turnId === 'string' && rec.turnId.length > 0
      ? rec.turnId
      : null;
  }

  // ── M2 [A2]: the judge-done ring ───────────────────────────────────────────────
  function markTurnJudged(_sessionId: string, turnId: string): void {
    if (!turnId) return;
    const s = getState();
    const ring = s.judgedTurns ?? [];
    if (ring.includes(turnId)) return;
    saveState({ ...s, judgedTurns: [...ring, turnId].slice(-JUDGED_TURNS_CAP) });
  }

  function wasTurnJudged(_sessionId: string, turnId: string): boolean {
    if (!turnId) return false;
    return (getState().judgedTurns ?? []).includes(turnId);
  }

  function writeInbox(payload: InboxPayload): string {
    // Include process.pid so two SEPARATE `node dist/hook.js` processes firing in
    // the same millisecond cannot produce an identical inbox name (counter resets
    // to 0 and hrtime is process-relative across processes). pid disambiguates the
    // cross-process case; monotonic() the in-process case (SPEC §8.4).
    const path = join(
      inboxDir,
      `${safeName(payload.session_id)}-${process.pid}-${monotonic()}.json`,
    );
    writeJsonAtomic(path, payload);
    return path;
  }

  // ── F-FEEDBACK ───────────────────────────────────────────────────────────────
  function recordLastTip(tip: LastTip): void {
    saveState({ ...getState(), lastTip: tip });
  }

  function rateLastTip(rating: 'good' | 'bad'): { tip: LastTip; rating: 'good' | 'bad' } | null {
    const s = getState();
    const tip = s.lastTip;
    if (tip === null) return null; // nothing to rate.
    const prior = s.feedbackByLever[tip.lever] ?? { good: 0, bad: 0 };
    const next: LeverFeedback =
      rating === 'good' ? { good: prior.good + 1, bad: prior.bad } : { good: prior.good, bad: prior.bad + 1 };
    saveState({
      ...s,
      feedbackByLever: { ...s.feedbackByLever, [tip.lever]: next },
      lastTip: null, // one rating per tip — clear so a second 👍 doesn't double-count.
      lastRating: { lever: tip.lever, rating, tip },
    });
    return { tip, rating };
  }

  function undoLastRating(): { lever: string; rating: 'good' | 'bad' } | null {
    const s = getState();
    const last = s.lastRating;
    if (last === null) return null;
    const cur = s.feedbackByLever[last.lever] ?? { good: 0, bad: 0 };
    const reverted: LeverFeedback =
      last.rating === 'good'
        ? { good: Math.max(0, cur.good - 1), bad: cur.bad }
        : { good: cur.good, bad: Math.max(0, cur.bad - 1) };
    saveState({
      ...s,
      feedbackByLever: { ...s.feedbackByLever, [last.lever]: reverted },
      lastTip: last.tip, // restore so the owner can re-rate it.
      lastRating: null,
    });
    return { lever: last.lever, rating: last.rating };
  }

  /** Greet a session exactly once: true on first sight (records it), false thereafter. */
  function markGreetedIfFirst(sessionId: string): boolean {
    if (!sessionId) return false; // no id → never greet (avoid a blank-key greet-loop).
    const s = getState();
    const seen = s.greetedSessions ?? [];
    if (seen.includes(sessionId)) return false;
    // Cap the list so it can't grow unbounded across many sessions (keep the most-recent 500).
    const next = [...seen, sessionId].slice(-500);
    saveState({ ...s, greetedSessions: next });
    return true;
  }

  function markTourShownIfFirst(): boolean {
    const s = getState();
    // Already toured on this install → never again.
    if (s.tourShown === true) return false;
    // MIGRATION (mirror M5): an engaged legacy install that predates the flag must NOT get a
    // surprise tour. Treat it as already-toured and persist the flag so this resolves once.
    if (stateShowsEngagement(s)) {
      saveState({ ...s, tourShown: true });
      return false;
    }
    // A genuinely fresh install: show the tour exactly once.
    saveState({ ...s, tourShown: true });
    return true;
  }

  function markOutcomeRecapShownIfFirst(sessionId: string): boolean {
    if (!sessionId) return false; // no id → never surface (avoid a blank-key loop).
    const s = getState();
    const seen = s.outcomeRecapShownSessions ?? [];
    if (seen.includes(sessionId)) return false;
    const next = [...seen, sessionId].slice(-500);
    saveState({ ...s, outcomeRecapShownSessions: next });
    return true;
  }

  function floorDeltaForLever(lever: string): number {
    return adaptiveFloorDelta(getState().feedbackByLever[lever]);
  }

  // ── M5: watch-first critique window ─────────────────────────────────────────
  function observeWatch(sessionId: string, now: number): WatchState {
    const s = getState();
    const next = recordObservation(resolveWatch(s, now), sessionId, now);
    try {
      saveState({ ...s, watch: next });
    } catch {
      // Save failed → the observation is lost (an under-count) — never throw.
    }
    return next;
  }

  function recordWithheldTip(entry: WithheldTip): void {
    const s = getState();
    const next = appendWithheld(resolveWatch(s, entry.at), entry);
    try {
      saveState({ ...s, watch: next });
    } catch {
      // Best effort — a lost log entry must never abort the judge.
    }
  }

  function markAnnouncedIfFirst(now: number): boolean {
    const s = getState();
    const w = resolveWatch(s, now);
    if (!windowClosed(w) || w.announced) return false;
    try {
      saveState({ ...s, watch: { ...w, announced: true } });
    } catch {
      return false; // unpersisted announce would repeat forever — suppress instead.
    }
    return true;
  }

  function readAndUnlinkInbox(path: string): InboxPayload | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    try {
      unlinkSync(path);
    } catch {
      // Already gone — fine; we still return what we read.
    }
    try {
      return JSON.parse(raw) as InboxPayload;
    } catch {
      return null;
    }
  }

  return {
    getState,
    saveState,
    markQualityTip,
    markHabitNudge,
    qualityOnCooldown,
    habitOnCooldown,
    leverUsedInSession,
    writeMailbox,
    readAndClearMailbox,
    claimMailbox,
    beginTurn,
    currentTurn,
    markTurnJudged,
    wasTurnJudged,
    writeInbox,
    readAndUnlinkInbox,
    recordLastTip,
    rateLastTip,
    undoLastRating,
    floorDeltaForLever,
    markGreetedIfFirst,
    markTourShownIfFirst,
    markOutcomeRecapShownIfFirst,
    observeWatch,
    recordWithheldTip,
    markAnnouncedIfFirst,
  };
}

function kindRank(kind: TipKind): number {
  return kind === 'quality' ? 0 : 1;
}

/** Defensive: keep session ids that contain path separators from escaping the dir. */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}
