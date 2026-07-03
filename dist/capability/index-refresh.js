import { writeJsonAtomic } from '../state/store.js';
import { loadSkillIndexPreferRuntime, runtimeIndexPath, } from './skill-index.js';
import { COMMUNITY_SOURCE, curateCommunityEntries, repoFloorsOk, } from './community-gate.js';
/** Floor cadence between refresh ATTEMPTS (success or failure). */
export const INDEX_REFRESH_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
/** Per-fetch timeout (the judge is detached, but a wedged socket must still die). */
const FETCH_TIMEOUT_MS = 10_000;
/** Upstream response size guard — a hostile/hijacked endpoint can't balloon memory. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// TS-side port of the scraper's hard caps (same constants — scripts/refresh-skill-index.mjs).
const MAX_ENTRIES = 400;
const MAX_BYTES = 300 * 1024;
/** The opt-out kill switch: set PROMPT_COACH_NO_INDEX_REFRESH non-empty to disable. */
export function refreshDisabled(env) {
    const v = env.PROMPT_COACH_NO_INDEX_REFRESH;
    return typeof v === 'string' && v.length > 0;
}
/**
 * Run one throttled, fail-silent refresh. NEVER throws / never rejects. Returns the
 * miner-shaped result; the caller persists `nextState`.
 */
export async function runIndexRefresh(input) {
    const now = (input.now ?? Date.now)();
    if (refreshDisabled(input.env)) {
        return { refreshed: false, skippedReason: 'disabled', nextState: input.state };
    }
    if (now - (input.state.lastIndexRefreshAt ?? 0) < INDEX_REFRESH_COOLDOWN_MS) {
        return { refreshed: false, skippedReason: 'throttle', nextState: input.state };
    }
    // The ATTEMPT advances the watermark whatever happens next (one touch per window).
    const nextState = { ...input.state, lastIndexRefreshAt: now };
    try {
        const refreshed = await attemptRefresh(input, now);
        return { refreshed, skippedReason: null, nextState };
    }
    catch {
        return { refreshed: false, skippedReason: null, nextState }; // fail-silent.
    }
}
/** The single attempt: 2 fetches → floors → gate → merge → caps → atomic write. */
async function attemptRefresh(input, now) {
    const fetchJson = input.fetchJson ?? defaultFetchJson;
    const fetchText = input.fetchText ?? defaultFetchText;
    // Fetch 1: repo metadata → evidence floors (stars / recency / not archived).
    const metaRaw = await fetchJson(`https://api.github.com/repos/${COMMUNITY_SOURCE.repo}`);
    if (metaRaw === null || typeof metaRaw !== 'object')
        return false;
    const m = metaRaw;
    const meta = {
        stars: typeof m.stargazers_count === 'number' ? m.stargazers_count : 0,
        pushedAt: typeof m.pushed_at === 'string' ? m.pushed_at : '',
        archived: m.archived === true,
    };
    if (!repoFloorsOk(meta, now))
        return false;
    const branch = typeof m.default_branch === 'string' && m.default_branch.length > 0
        ? m.default_branch
        : 'main';
    // Fetch 2: the community marketplace document (raw, size-guarded).
    const text = await fetchText(`https://raw.githubusercontent.com/${COMMUNITY_SOURCE.repo}/${branch}/.claude-plugin/marketplace.extended.json`);
    if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES)
        return false;
    const upstream = JSON.parse(text);
    // The official slice is carried from the newest valid index — no index, no write.
    const current = (input.loadCurrent ?? (() => loadSkillIndexPreferRuntime(input.baseDir)))();
    if (current === null)
        return false;
    const official = current.entries.filter((e) => e.trust === 'official');
    if (official.length === 0)
        return false;
    const officialFolds = new Set(official.map((e) => e.name.trim().toLowerCase()));
    const survivors = curateCommunityEntries(upstream, officialFolds, now).map((e) => ({
        ...e,
        repoStars: meta.stars,
    }));
    // A gutted community slice is never written — keep whatever the old index had.
    if (survivors.length === 0)
        return false;
    const entries = [...official, ...survivors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sources = [
        ...current.sources.filter((s) => !(s !== null && typeof s === 'object' &&
            s.repo === COMMUNITY_SOURCE.repo)),
        {
            repo: COMMUNITY_SOURCE.repo,
            marketplace: COMMUNITY_SOURCE.marketplace,
            sha: null,
            stars: meta.stars,
            trust: 'community',
        },
    ];
    const index = {
        schemaVersion: 1,
        generatedAt: new Date(now).toISOString(),
        sources,
        entries,
    };
    if (!capsOk(index))
        return false;
    (input.writeAtomic ?? writeJsonAtomic)(runtimeIndexPath(input.baseDir), index);
    return true;
}
/** TS-side port of the scraper's assertIndexValid caps (boolean, never throws). */
function capsOk(index) {
    if (index.entries.length === 0 || index.entries.length > MAX_ENTRIES)
        return false;
    for (const e of index.entries) {
        if (e.name.length === 0 ||
            e.description.length === 0 ||
            e.install.length === 0 ||
            e.sourceUrl.length === 0) {
            return false;
        }
    }
    const bytes = Buffer.byteLength(JSON.stringify(index, null, 2), 'utf8');
    return bytes <= MAX_BYTES;
}
// ── Default fetchers (global fetch — node ≥ 18 stdlib, zero deps) ─────────────
async function defaultFetchText(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'boris-says' },
    });
    if (!res.ok)
        throw new Error(`GET ${url}: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES)
        throw new Error(`GET ${url}: response too large`);
    return text;
}
async function defaultFetchJson(url) {
    return JSON.parse(await defaultFetchText(url));
}
