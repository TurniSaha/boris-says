/**
 * Atomic JSON state store for the prompt-coach plugin.
 *
 * All state lives under ~/.claude/prompt-coach/ (SPEC §2). Writes are
 * temp-sibling-then-rename so a crash never leaves a partial file. Reads never
 * throw: a missing or corrupt file yields the caller's fallback.
 *
 * Single user, single machine — these files are the source of truth (SPEC §0).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendWithheld, recordObservation, resolveWatch, stateShowsEngagement, windowClosed, } from './watch.js';
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
export function defaultState() {
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
export function adaptiveFloorDelta(fb) {
    if (!fb)
        return 0;
    const total = fb.good + fb.bad;
    if (total < FEEDBACK_MIN_RATINGS)
        return 0; // not enough signal yet (owner: "after N ratings").
    const net = (fb.bad - fb.good) / total; // +1 = all bad → raise floor; -1 = all good → lower.
    const delta = net * FEEDBACK_MAX_DELTA;
    // Clamp defensively (net ∈ [-1,1] already, but guard rounding).
    return Math.max(-FEEDBACK_MAX_DELTA, Math.min(FEEDBACK_MAX_DELTA, delta));
}
// ── Primitive atomic IO ──────────────────────────────────────────────────────
/** Write `obj` as JSON via a temp sibling + atomic rename. Never leaves a partial. */
export function writeJsonAtomic(path, obj) {
    mkdirSync(dirname(path), { recursive: true });
    // Unique temp suffix so two concurrent writers to the same target never
    // share a temp file (the rename is the atomic commit point).
    const tmp = `${path}.tmp.${process.pid}.${monotonic()}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, path);
}
/** Read JSON at `path`, returning `fallback` on missing/corrupt/empty. Never throws. */
export function readJson(path, fallback) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        return fallback;
    }
    if (raw.trim() === '')
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
// ── Monotonic suffix for collision-free file names (SPEC §8.1) ────────────────
let counter = 0;
function monotonic() {
    counter += 1;
    const hr = process.hrtime.bigint();
    return `${Date.now()}-${hr}-${counter}`;
}
/**
 * Keep only the `cap` entries with the highest (most-recent) numeric values. PURE. Used to
 * bound the per-session quality-cooldown map; entries below the cooldown horizon are stale.
 */
export function capByValue(map, cap) {
    const keys = Object.keys(map);
    if (keys.length <= cap)
        return map;
    const kept = keys.sort((a, b) => map[b] - map[a]).slice(0, cap);
    const out = {};
    for (const k of kept)
        out[k] = map[k];
    return out;
}
export function createStore(baseDir = DEFAULT_BASE_DIR) {
    const statePath = join(baseDir, 'state.json');
    const mailboxPath = (sessionId) => join(baseDir, 'mailbox', `${safeName(sessionId)}.json`);
    const inboxDir = join(baseDir, 'inbox');
    const turnPath = (sessionId) => join(baseDir, 'turns', `${safeName(sessionId)}.json`);
    function getState() {
        // Merge over defaults so a partial/older state file is forward-compatible.
        return { ...defaultState(), ...readJson(statePath, {}) };
    }
    function saveState(state) {
        writeJsonAtomic(statePath, state);
    }
    function markQualityTip(now, sessionId, lever) {
        const s = getState();
        // Update BOTH the global field (for /coach status) and the per-session cooldown map (the
        // gate). The per-session stamp is what prevents one session throttling another.
        const next = { ...s, lastQualityTipAt: now };
        if (sessionId) {
            // ?? guards an old on-disk state missing the field. Cap to the most-recent
            // QUALITY_TIP_SESSIONS_CAP sessions by timestamp so the map can't grow unbounded on a
            // long-lived state.json (mirrors the greetedSessions .slice(-500) cap); entries older
            // than the 10-min cooldown are never read-relevant anyway.
            next.lastQualityTipBySession = capByValue({ ...(s.lastQualityTipBySession ?? {}), [sessionId]: now }, QUALITY_TIP_SESSIONS_CAP);
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
    function markHabitNudge(now, patternKey) {
        const s = getState();
        saveState({ ...s, lastHabitNudgeAt: now, lastSurfacedPatternKey: patternKey });
    }
    function qualityOnCooldown(now) {
        const at = getState().lastQualityTipAt;
        return at !== null && now - at < QUALITY_COOLDOWN_MS;
    }
    function habitOnCooldown(now) {
        const at = getState().lastHabitNudgeAt;
        return at !== null && now - at < HABIT_COOLDOWN_MS;
    }
    function leverUsedInSession(sessionId, lever) {
        return (getState().leversUsedBySession[sessionId] ?? []).includes(lever);
    }
    function writeMailbox(sessionId, tip) {
        const path = mailboxPath(sessionId);
        const existing = readJson(path, []);
        // Keep the newest MAILBOX_CAP tips (drop the oldest on overflow).
        const next = [...existing, tip].slice(-MAILBOX_CAP);
        writeJsonAtomic(path, next);
    }
    function readAndClearMailbox(sessionId) {
        // M2: delegate to the atomic claim so BOTH drains (UPS + Stop) share ONE
        // consume-once mechanism — the rename. (The old read-then-overwrite-with-[]
        // implementation had a torn-read window against a concurrent judge write.)
        return claimMailbox(sessionId);
    }
    function claimMailbox(sessionId) {
        const path = mailboxPath(sessionId);
        // Unique claim name: two concurrent claimers can never collide, and only ONE
        // rename of the same source can succeed — that rename is the consume-once.
        const claimPath = `${path}.claim.${process.pid}.${monotonic()}`;
        try {
            renameSync(path, claimPath);
        }
        catch {
            return []; // no mailbox (or lost the race) → nothing to claim.
        }
        const tips = readJson(claimPath, []);
        try {
            unlinkSync(claimPath);
        }
        catch {
            // best effort — a leaked claim file is inert (unique name, never re-read).
        }
        // Quality before habit on a tie; otherwise preserve insertion order (stable sort).
        return [...tips].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
    }
    // ── M2: per-session turn marker (UPS writes it; the Stop poll reads it) ────────
    function beginTurn(sessionId, turnId) {
        if (!sessionId || !turnId)
            return;
        writeJsonAtomic(turnPath(sessionId), { turnId });
    }
    function currentTurn(sessionId) {
        if (!sessionId)
            return null;
        const rec = readJson(turnPath(sessionId), null);
        return rec !== null && typeof rec.turnId === 'string' && rec.turnId.length > 0
            ? rec.turnId
            : null;
    }
    // ── M2 [A2]: the judge-done ring ───────────────────────────────────────────────
    function markTurnJudged(_sessionId, turnId) {
        if (!turnId)
            return;
        const s = getState();
        const ring = s.judgedTurns ?? [];
        if (ring.includes(turnId))
            return;
        saveState({ ...s, judgedTurns: [...ring, turnId].slice(-JUDGED_TURNS_CAP) });
    }
    function wasTurnJudged(_sessionId, turnId) {
        if (!turnId)
            return false;
        return (getState().judgedTurns ?? []).includes(turnId);
    }
    function writeInbox(payload) {
        // Include process.pid so two SEPARATE `node dist/hook.js` processes firing in
        // the same millisecond cannot produce an identical inbox name (counter resets
        // to 0 and hrtime is process-relative across processes). pid disambiguates the
        // cross-process case; monotonic() the in-process case (SPEC §8.4).
        const path = join(inboxDir, `${safeName(payload.session_id)}-${process.pid}-${monotonic()}.json`);
        writeJsonAtomic(path, payload);
        return path;
    }
    // ── F-FEEDBACK ───────────────────────────────────────────────────────────────
    function recordLastTip(tip) {
        saveState({ ...getState(), lastTip: tip });
    }
    function rateLastTip(rating) {
        const s = getState();
        const tip = s.lastTip;
        if (tip === null)
            return null; // nothing to rate.
        const prior = s.feedbackByLever[tip.lever] ?? { good: 0, bad: 0 };
        const next = rating === 'good' ? { good: prior.good + 1, bad: prior.bad } : { good: prior.good, bad: prior.bad + 1 };
        saveState({
            ...s,
            feedbackByLever: { ...s.feedbackByLever, [tip.lever]: next },
            lastTip: null, // one rating per tip — clear so a second 👍 doesn't double-count.
            lastRating: { lever: tip.lever, rating, tip },
        });
        return { tip, rating };
    }
    function undoLastRating() {
        const s = getState();
        const last = s.lastRating;
        if (last === null)
            return null;
        const cur = s.feedbackByLever[last.lever] ?? { good: 0, bad: 0 };
        const reverted = last.rating === 'good'
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
    function markGreetedIfFirst(sessionId) {
        if (!sessionId)
            return false; // no id → never greet (avoid a blank-key greet-loop).
        const s = getState();
        const seen = s.greetedSessions ?? [];
        if (seen.includes(sessionId))
            return false;
        // Cap the list so it can't grow unbounded across many sessions (keep the most-recent 500).
        const next = [...seen, sessionId].slice(-500);
        saveState({ ...s, greetedSessions: next });
        return true;
    }
    function markTourShownIfFirst() {
        const s = getState();
        // Already toured on this install → never again.
        if (s.tourShown === true)
            return false;
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
    function markOutcomeRecapShownIfFirst(sessionId) {
        if (!sessionId)
            return false; // no id → never surface (avoid a blank-key loop).
        const s = getState();
        const seen = s.outcomeRecapShownSessions ?? [];
        if (seen.includes(sessionId))
            return false;
        const next = [...seen, sessionId].slice(-500);
        saveState({ ...s, outcomeRecapShownSessions: next });
        return true;
    }
    function floorDeltaForLever(lever) {
        return adaptiveFloorDelta(getState().feedbackByLever[lever]);
    }
    // ── M5: watch-first critique window ─────────────────────────────────────────
    function observeWatch(sessionId, now) {
        const s = getState();
        const next = recordObservation(resolveWatch(s, now), sessionId, now);
        try {
            saveState({ ...s, watch: next });
        }
        catch {
            // Save failed → the observation is lost (an under-count) — never throw.
        }
        return next;
    }
    function recordWithheldTip(entry) {
        const s = getState();
        const next = appendWithheld(resolveWatch(s, entry.at), entry);
        try {
            saveState({ ...s, watch: next });
        }
        catch {
            // Best effort — a lost log entry must never abort the judge.
        }
    }
    function markAnnouncedIfFirst(now) {
        const s = getState();
        const w = resolveWatch(s, now);
        if (!windowClosed(w) || w.announced)
            return false;
        try {
            saveState({ ...s, watch: { ...w, announced: true } });
        }
        catch {
            return false; // unpersisted announce would repeat forever — suppress instead.
        }
        return true;
    }
    function readAndUnlinkInbox(path) {
        let raw;
        try {
            raw = readFileSync(path, 'utf8');
        }
        catch {
            return null;
        }
        try {
            unlinkSync(path);
        }
        catch {
            // Already gone — fine; we still return what we read.
        }
        try {
            return JSON.parse(raw);
        }
        catch {
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
function kindRank(kind) {
    return kind === 'quality' ? 0 : 1;
}
/** Defensive: keep session ids that contain path separators from escaping the dir. */
function safeName(sessionId) {
    return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}
