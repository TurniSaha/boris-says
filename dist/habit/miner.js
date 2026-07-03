import { parseMinerPatterns } from './miner-parse.js';
import { anchorTokens, matchHabit } from './matcher.js';
import { DRAFT_SYSTEM, MAX_DRAFTS_PER_MINE, renderDraftRequest, parseDraft, isDraftGrounded, } from './draft.js';
// ── Throttle constants (SPEC §7.2) ───────────────────────────────────────────
/** Minimum new typed prompts since the last mine before mining again. */
export const MIN_NEW_EVENTS = 5;
/** 24h between mines. */
export const MINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A habit must recur across at least this many DISTINCT sessions (§7.5 #1). */
export const MIN_DISTINCT_SESSIONS = 3;
/** §5.5.6b dismissal-similarity Jaccard threshold (start 0.6, tune on pilot). */
export const DISMISSAL_JACCARD_THRESHOLD = 0.6;
/** The miner system prompt — source-spec §4 wording + the §5.5.6a desirability rule. */
export const MINER_SYSTEM = 'You analyze a developer\'s recent TYPED prompts for RECURRING HABITS worth coaching. ' +
    'A habit = a recurring TYPED ask/behavior that appears across at least 3 DISTINCT sessions ' +
    'AND has a concrete process/tooling fix.\n\n' +
    'Only surface habits that are INEFFICIENT or COUNTERPRODUCTIVE. A recurring BEST PRACTICE ' +
    '(writing tests first / TDD, running the linter, asking for a plan, adding acceptance criteria) ' +
    'is NOT a coachable habit — emit nothing for it. The fix must REMOVE friction or PREVENT a ' +
    'recurring mistake, never formalize a habit that is already good. ' +
    'Example: input = "write the test first" x 3 sessions -> output [].\n\n' +
    'The canonical coachable case: the dev keeps TYPING a request for "the prompt for the next session" ' +
    '(often right after a handoff). Mine that recurring typed ask and suggest baking a prompt-handoff ' +
    'into their /context-handoff command so it is automatic. Slash commands are INVISIBLE to you (you ' +
    'only ever see human-typed prose); detect + trigger on the TYPED prose only — the fix it SUGGESTS ' +
    'may still name a slash command (that is just advice text).\n\n' +
    'Output ONLY a JSON array (no prose, no markdown) of objects:\n' +
    '{ "habit_key": "<stable normalized <topic>:<behavior> slug, e.g. context-handoff:next-session-prompt>", ' +
    '"match_phrases": ["3 to 6 representative typed phrasings of the ask"], ' +
    '"anchorSignature": ["optional normalized anchor tokens"], ' +
    '"habit": "<human-readable habit description>", ' +
    '"fix": "<concrete suggested process/tooling fix — non-empty>", ' +
    '"why_inefficient": "<short string naming the concrete waste/risk the fix removes — non-empty>", ' +
    '"occurrences": [{ "sessionId": "...", "ts": 0, "evidence": "<verbatim cited prompt text>" }], ' +
    '"confidence": 0.0 }\n\n' +
    'Every occurrence MUST cite a real event you were given; occurrences MUST span at least 3 DISTINCT ' +
    'sessionIds. habit_key is a STABLE dedup key separate from the habit prose. Emit an empty array [] ' +
    'if there are no inefficient recurring habits.';
/** Resolve the corpus whether passed as an array or a lazy reader fn. */
function resolveCorpus(corpus) {
    return typeof corpus === 'function' ? corpus() : corpus;
}
/** Render the typed-prompt slice with session boundaries for the model. */
function renderCorpus(corpus) {
    return corpus
        .map((p) => `[session ${p.sessionId} @ ${p.ts}] ${p.text}`)
        .join('\n');
}
/** Jaccard overlap between two token sets (0..1; empty-vs-empty -> 0). */
function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 0;
    let inter = 0;
    for (const t of a)
        if (b.has(t))
            inter += 1;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}
/** The normalized anchor-token signature of a pattern's match_phrases. */
function signatureOf(phrases) {
    const sig = new Set();
    for (const phrase of phrases)
        for (const tok of anchorTokens(phrase))
            sig.add(tok);
    return sig;
}
/** Count DISTINCT sessionIds across a mined pattern's occurrences. */
function distinctSessions(p) {
    return new Set(p.occurrences.map((o) => o.sessionId)).size;
}
/**
 * §5.5.6c self-match calibration: how many of the pattern's OWN occurrences self-match
 * its stored match_phrases via the §7.4 deterministic matcher. The matcher only sees
 * this one pattern (as an `open` candidate) so a match is necessarily against its own
 * phrases.
 */
function selfMatchCount(p) {
    const probe = toPattern(p, 'open', 0);
    let n = 0;
    for (const occ of p.occurrences) {
        if (matchHabit(occ.evidence, [probe]) !== null)
            n += 1;
    }
    return n;
}
/** Build a full persisted Pattern from a mined one. */
function toPattern(p, status, createdAt) {
    return {
        habit_key: p.habit_key,
        trigger: `prompt_recurring:${p.habit_key}`,
        match_phrases: p.match_phrases,
        anchorSignature: [...signatureOf(p.match_phrases)],
        habit: p.habit,
        fix: p.fix,
        why_inefficient: p.why_inefficient,
        occurrences: p.occurrences,
        occurrenceCount: p.occurrences.length,
        confidence: p.confidence,
        status,
        createdAt,
        surfacedAt: null,
    };
}
/**
 * Run the throttled miner. Pure-ish: it reads the corpus + the existing patterns
 * store (for the dismissal gate), may make ONE Sonnet call, upserts survivors, and
 * RETURNS the advanced state for the caller to persist.
 */
export async function runHabitMiner(input) {
    const { state, backend, store, now } = input;
    const corpus = resolveCorpus(input.corpus);
    // ── THROTTLE (a): new-event count since the watermark. The watermark is a
    // monotonic event COUNTER (SPEC §7.2); the corpus reader returns new-since events,
    // so the count of fresh typed prompts is corpus.length here (the caller feeds a
    // watermark-filtered corpus) — but we also gate defensively on the persisted count.
    const newEventCount = corpus.length;
    if (newEventCount < MIN_NEW_EVENTS) {
        return noop(state, 'throttle_events');
    }
    // ── THROTTLE (b): 24h cooldown.
    if (state.lastMinedAt !== null && now - state.lastMinedAt < MINE_COOLDOWN_MS) {
        return noop(state, 'throttle_cooldown');
    }
    // Null/unconfigured backend -> no LLM, no-op (but advance NOTHING; nothing mined).
    if (!backend.configured) {
        return noop(state, 'no_backend');
    }
    const response = await backend.complete({
        model: 'sonnet',
        maxTokens: 1500,
        system: MINER_SYSTEM,
        user: renderCorpus(corpus),
    });
    // A null response (any failure) or a malformed parse -> no-op, do NOT advance the
    // watermark (so the next eligible tick retries).
    if (response === null) {
        return noop(state, null);
    }
    const mined = parseMinerPatterns(response);
    // ── Structural guardrails (§5.5.6a / §7.5): drop < 3 distinct sessions, empty fix,
    // empty why_inefficient.
    const structurallyValid = mined.filter((p) => distinctSessions(p) >= MIN_DISTINCT_SESSIONS &&
        p.fix.trim().length > 0 &&
        p.why_inefficient.trim().length > 0);
    // ── Self-match calibration (§5.5.6c): the phrases must generalize across the dev's
    // own observed phrasings — require >= 3 occurrences to self-match.
    const calibrated = structurallyValid.filter((p) => selfMatchCount(p) >= MIN_DISTINCT_SESSIONS);
    // ── Dismissal-similarity gate (§5.5.6b): drop any NEW-keyed open pattern whose
    // anchor signature is Jaccard >= 0.6 to any DISMISSED pattern's signature.
    const existing = store.readPatterns();
    const existingKeys = new Set(existing.map((p) => p.habit_key));
    const dismissedSignatures = existing
        .filter((p) => p.status === 'dismissed')
        .map((p) => signatureOf(p.match_phrases));
    const survivors = [];
    for (const p of calibrated) {
        const isNewKey = !existingKeys.has(p.habit_key);
        if (isNewKey) {
            const sig = signatureOf(p.match_phrases);
            const tooSimilar = dismissedSignatures.some((d) => jaccard(sig, d) >= DISMISSAL_JACCARD_THRESHOLD);
            if (tooSimilar)
                continue; // treat as the dismissed behavior — drop, never reopen.
        }
        survivors.push(toPattern(p, 'open', now));
    }
    // ── M3 drafting (D1/D2): survivors ONLY — a pattern that passed every gate
    // above may get ONE extra Sonnet call proposing a draft primitive (capped at
    // MAX_DRAFTS_PER_MINE per mine, riding this same 24h throttle). Skip keys the
    // store already dismissed (never draft a dismissed habit) or that already
    // carry a draft (first draft wins). ANY failure → draft-less survivor; the
    // detection/upsert path is never blocked by drafting.
    const priorByKey = new Map(existing.map((p) => [p.habit_key, p]));
    const drafted = await draftSurvivors(survivors, priorByKey, backend, now);
    if (drafted.length > 0) {
        store.upsertPatterns(drafted);
    }
    // Advance the watermark (monotonic counter) + lastMinedAt. The watermark moves
    // forward by the number of new events consumed this run.
    const nextState = {
        ...state,
        lastMinedAt: now,
        lastMinedWatermark: state.lastMinedWatermark + newEventCount,
    };
    return { mined: true, skippedReason: null, upserted: drafted, nextState };
}
/**
 * M3: attach a drafted primitive to each draft-eligible survivor (D1 eligibility:
 * not dismissed in the store, no existing draft; capped at MAX_DRAFTS_PER_MINE
 * calls per mine). Returns NEW pattern objects — never mutates the inputs. Every
 * failure (null response, parse fail, groundedness fail) yields the survivor
 * unchanged (draft-less): when in doubt, no draft.
 */
async function draftSurvivors(survivors, priorByKey, backend, now) {
    const out = [];
    let calls = 0;
    for (const survivor of survivors) {
        const prior = priorByKey.get(survivor.habit_key);
        const eligible = calls < MAX_DRAFTS_PER_MINE && prior?.status !== 'dismissed' && !prior?.draft;
        if (!eligible) {
            out.push(survivor);
            continue;
        }
        calls += 1;
        const response = await backend.complete({
            model: 'sonnet',
            maxTokens: 1200,
            system: DRAFT_SYSTEM,
            user: renderDraftRequest(survivor),
        });
        const proposal = response === null ? null : parseDraft(response);
        if (proposal !== null && isDraftGrounded(proposal, survivor)) {
            out.push({ ...survivor, draft: { ...proposal, createdAt: now } });
        }
        else {
            out.push(survivor); // fail-open to advice-only — detection unharmed.
        }
    }
    return out;
}
/** A no-op result: nothing mined, state unchanged. */
function noop(state, reason) {
    return { mined: false, skippedReason: reason, upserted: [], nextState: state };
}
