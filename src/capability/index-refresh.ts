/**
 * src/capability/index-refresh.ts — G-M4b BACKGROUND auto-refresh of the external-skill
 * index (the "always-updating" design). Runs INSIDE the already-detached judge process,
 * AFTER the tip deposit + judged-marker (never the UserPromptSubmit hot path, never
 * blocks a turn). Exactly TWO fetches per attempt (repo metadata + the community
 * marketplace JSON), floor cadence 7 days, kill-switchable, and FAIL-SILENT: every
 * failure path (offline, 404, rate-limited, floors fail, gate empties, caps bust,
 * writer error) leaves the old index untouched and never throws.
 *
 * D2: only the trust:'community' slice is rebuilt; official entries are CARRIED FORWARD
 * from the newest valid index (`loadCurrent`, default the prefer-runtime loader). The
 * result is written atomically (tmp+rename) to the RUNTIME copy
 * `${baseDir}/skill-index.json` — the committed data/skill-index.json is NEVER touched
 * at runtime.
 *
 * THROTTLE ACCOUNTING: `lastIndexRefreshAt` advances on the ATTEMPT (success or
 * failure), so an offline machine makes at most one network touch per 7 days. Unlike
 * the miner's retry-on-failure, an index miss costs nothing against the 180-day
 * freshness window — per-prompt retries would just hammer the network.
 *
 * Zero runtime deps: global fetch + AbortSignal.timeout (node ≥ 18 stdlib). Every side
 * effect is an injectable seam (miner-style caller-deposits result).
 */
import type { CoachState } from '../state/store.js';
import { writeJsonAtomic } from '../state/store.js';
import {
  loadSkillIndexPreferRuntime,
  runtimeIndexPath,
  type SkillIndex,
  type SkillIndexEntry,
} from './skill-index.js';
import {
  COMMUNITY_SOURCE,
  curateCommunityEntries,
  repoFloorsOk,
} from './community-gate.js';

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
export function refreshDisabled(env: {
  PROMPT_COACH_NO_INDEX_REFRESH?: string | undefined;
}): boolean {
  const v = env.PROMPT_COACH_NO_INDEX_REFRESH;
  return typeof v === 'string' && v.length > 0;
}

/** Miner-shaped result: the CALLER persists nextState (caller-deposits pattern). */
export interface IndexRefreshResult {
  /** True iff a fresh runtime copy was actually written. */
  readonly refreshed: boolean;
  /** Why no attempt ran; null when an attempt ran (whatever its outcome). */
  readonly skippedReason: 'disabled' | 'throttle' | null;
  /** The state to persist (watermark advanced on ATTEMPT; unchanged on skip). */
  readonly nextState: CoachState;
}

export interface IndexRefreshInput {
  readonly state: CoachState;
  readonly env: { PROMPT_COACH_NO_INDEX_REFRESH?: string | undefined };
  readonly baseDir: string;
  /** GET a JSON document (default: global fetch, 10s timeout, 2 MB guard). */
  readonly fetchJson?: (url: string) => Promise<unknown>;
  /** GET a text document (default: global fetch, 10s timeout, 2 MB guard). */
  readonly fetchText?: (url: string) => Promise<string>;
  /** The newest valid index to carry the official slice from (default prefer-runtime). */
  readonly loadCurrent?: () => SkillIndex | null;
  /** Atomic tmp+rename writer (default writeJsonAtomic). */
  readonly writeAtomic?: (path: string, obj: unknown) => void;
  readonly now?: () => number;
}

/**
 * Run one throttled, fail-silent refresh. NEVER throws / never rejects. Returns the
 * miner-shaped result; the caller persists `nextState`.
 */
export async function runIndexRefresh(input: IndexRefreshInput): Promise<IndexRefreshResult> {
  const now = (input.now ?? Date.now)();

  if (refreshDisabled(input.env)) {
    return { refreshed: false, skippedReason: 'disabled', nextState: input.state };
  }
  if (now - (input.state.lastIndexRefreshAt ?? 0) < INDEX_REFRESH_COOLDOWN_MS) {
    return { refreshed: false, skippedReason: 'throttle', nextState: input.state };
  }

  // The ATTEMPT advances the watermark whatever happens next (one touch per window).
  const nextState: CoachState = { ...input.state, lastIndexRefreshAt: now };

  try {
    const refreshed = await attemptRefresh(input, now);
    return { refreshed, skippedReason: null, nextState };
  } catch {
    return { refreshed: false, skippedReason: null, nextState }; // fail-silent.
  }
}

/** The single attempt: 2 fetches → floors → gate → merge → caps → atomic write. */
async function attemptRefresh(input: IndexRefreshInput, now: number): Promise<boolean> {
  const fetchJson = input.fetchJson ?? defaultFetchJson;
  const fetchText = input.fetchText ?? defaultFetchText;

  // Fetch 1: repo metadata → evidence floors (stars / recency / not archived).
  const metaRaw = await fetchJson(`https://api.github.com/repos/${COMMUNITY_SOURCE.repo}`);
  if (metaRaw === null || typeof metaRaw !== 'object') return false;
  const m = metaRaw as Record<string, unknown>;
  const meta = {
    stars: typeof m.stargazers_count === 'number' ? m.stargazers_count : 0,
    pushedAt: typeof m.pushed_at === 'string' ? m.pushed_at : '',
    archived: m.archived === true,
  };
  if (!repoFloorsOk(meta, now)) return false;
  const branch = typeof m.default_branch === 'string' && m.default_branch.length > 0
    ? m.default_branch
    : 'main';

  // Fetch 2: the community marketplace document (raw, size-guarded).
  const text = await fetchText(
    `https://raw.githubusercontent.com/${COMMUNITY_SOURCE.repo}/${branch}/.claude-plugin/marketplace.extended.json`,
  );
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) return false;
  const upstream: unknown = JSON.parse(text);

  // The official slice is carried from the newest valid index — no index, no write.
  const current = (input.loadCurrent ?? (() => loadSkillIndexPreferRuntime(input.baseDir)))();
  if (current === null) return false;
  const official = current.entries.filter((e) => e.trust === 'official');
  if (official.length === 0) return false;

  const officialFolds = new Set(official.map((e) => e.name.trim().toLowerCase()));
  const survivors = curateCommunityEntries(upstream, officialFolds, now).map((e) => ({
    ...e,
    repoStars: meta.stars,
  }));
  // A gutted community slice is never written — keep whatever the old index had.
  if (survivors.length === 0) return false;

  const entries: SkillIndexEntry[] = [...official, ...survivors].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const sources = [
    ...current.sources.filter(
      (s) =>
        !(s !== null && typeof s === 'object' &&
          (s as Record<string, unknown>).repo === COMMUNITY_SOURCE.repo),
    ),
    {
      repo: COMMUNITY_SOURCE.repo,
      marketplace: COMMUNITY_SOURCE.marketplace,
      sha: null,
      stars: meta.stars,
      trust: 'community',
    },
  ];
  const index: SkillIndex = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    sources,
    entries,
  };

  if (!capsOk(index)) return false;

  (input.writeAtomic ?? writeJsonAtomic)(runtimeIndexPath(input.baseDir), index);
  return true;
}

/** TS-side port of the scraper's assertIndexValid caps (boolean, never throws). */
function capsOk(index: SkillIndex): boolean {
  if (index.entries.length === 0 || index.entries.length > MAX_ENTRIES) return false;
  for (const e of index.entries) {
    if (
      e.name.length === 0 ||
      e.description.length === 0 ||
      e.install.length === 0 ||
      e.sourceUrl.length === 0
    ) {
      return false;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(index, null, 2), 'utf8');
  return bytes <= MAX_BYTES;
}

// ── Default fetchers (global fetch — node ≥ 18 stdlib, zero deps) ─────────────

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'boris-says' },
    // A redirect off our two hardcoded HTTPS hosts is a compromise/hijack signal — refuse
    // it outright rather than silently follow it to an attacker-chosen origin.
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  // Pre-buffer size guard: reject on the advertised Content-Length BEFORE reading the body,
  // so a hostile (or compromised-host) multi-GB response never balloons this background
  // process's memory. res.text() still enforces the post-read cap as a backstop for a
  // missing/lying Content-Length.
  const advertised = Number(res.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    throw new Error(`GET ${url}: response too large (${advertised} bytes advertised)`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`GET ${url}: response too large`);
  return text;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  return JSON.parse(await defaultFetchText(url)) as unknown;
}
