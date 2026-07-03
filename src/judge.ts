/**
 * src/judge.ts -> dist/judge.js — the DETACHED background worker (SPEC §8.3, §5, §7).
 *
 * The hook spawns this detached + unref'd with argv[2] = the inbox file path. It:
 *   TOP GUARD: PROMPT_COACH_JUDGING set -> exit 0 (recursion guard, decision #13).
 *   - read argv[2] = inbox path, read its JSON, UNLINK it immediately (a crash never
 *     leaves a stale payload). The current prompt is `payload.prompt` (§4) — NEVER
 *     re-derived from the .jsonl.
 *   Then, in order, EACH step independently try/caught (a failure in one never aborts the
 *   others or crashes the process):
 *     (1) QUALITY cascade (§5) on payload.prompt -> maybe deposit a `quality` tip +
 *         record the quality cooldown AND the fired lever in ONE atomic state write
 *         (the caller duty the cascade leaves to us, §15b).
 *     (2) HABIT delivery (§7.4): matchHabit on the open patterns -> if matched AND the
 *         habit cooldown elapsed AND we did NOT just deposit a quality tip this turn
 *         (yield-to-quality, §7.4/§8) -> deposit a `habit` tip + markSurfaced + record
 *         lastSurfacedPatternKey + lastHabitNudgeAt in the SAME atomic state write (§7.6).
 *     (3) MINER throttle (§7.2): runHabitMiner over the watermark-filtered corpus ->
 *         persist the returned nextState.
 *
 * Heavy bits are INJECTED (store, patterns store, backend, transcript reader, corpus
 * reader, scanners, clock) so the unit test runs without real I/O or a real LLM.
 */
import { fileURLToPath } from 'node:url';
import {
  createStore,
  type Store,
  type InboxPayload,
} from './state/store.js';
import {
  createPatternsStore,
  type PatternsStore,
  type Pattern,
} from './habit/patterns-store.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBaseDir, type ConfigEnv } from './config.js';
import { createLlmBackend, type LlmBackend } from './llm/backend.js';
import { runQualityCascade, type LocalContext } from './brain/judge-cascade.js';
import { announceMessage, isCritiqueLever, windowClosed } from './state/watch.js';
import { COACH_FIRST_RUN_TOUR } from './brain/coach-liveness.js';
import { formatCoachBanner } from './brain/mailbox-format.js';
import {
  gatherLocalContext,
  modelStringToFamily,
} from './brain/local-context-probe.js';
import { PROMPT_COACH_SKILL, resolveJudgeModel } from './brain/prompt-coach-skill.js';
import { parseFeedbackAnchors, selectTasteExamples } from './brain/taste.js';
import { recentTranscriptWindow, MAX_TRANSCRIPT } from './jsonl/session-reader.js';
import { readCorpusTypedPrompts } from './jsonl/corpus-reader.js';
import { matchHabit, fuzzyFallback, composeHabitTip } from './habit/matcher.js';
import { runHabitMiner } from './habit/miner.js';
import { createMergedSkillCatalog } from './capability/merged-skill-catalog.js';
import { scanInstalledSkills } from './capability/scan-skills.js';
import { scanInstalledCommands } from './capability/scan-commands.js';
import { claudeCliVersion } from './capability/claude-version.js';
import {
  CAPABILITY_CATALOG,
  resolveCapability,
  type Capability,
  type CapabilityModelFamily,
} from './capability/catalog.js';
import {
  loadSkillIndexPreferRuntime,
  isFresh,
  type SkillIndex,
  type ExternalCandidate,
} from './capability/skill-index.js';
import {
  runIndexRefresh,
  type IndexRefreshInput,
  type IndexRefreshResult,
} from './capability/index-refresh.js';
import { matchExternalSkills } from './capability/skill-index-matcher.js';
import type { MergedSkillCatalog } from './brain/judge-cascade.js';

/** Injected dependencies — every side effect is a seam (§8.3). */
export interface JudgeDeps {
  readonly env: ConfigEnv & {
    PROMPT_COACH_JUDGING?: string | undefined;
    /** Override the judge/advice model (default opus). e.g. `sonnet`. */
    PROMPT_COACH_JUDGE_MODEL?: string | undefined;
    /** G-M4b: set non-empty to disable the background index auto-refresh. */
    PROMPT_COACH_NO_INDEX_REFRESH?: string | undefined;
  };
  /** The inbox file path (argv[2]). */
  readonly inboxPath: string;
  readonly store?: Store;
  readonly patternsStore?: PatternsStore;
  readonly backend?: LlmBackend;
  /** PRIOR transcript reader (defaults to recentTranscriptWindow over the .jsonl). */
  readonly readTranscript?: (transcriptPath: string, max: number) => readonly string[];
  /** Skill catalog (defaults to scan-derived merged catalog). */
  readonly catalog?: MergedSkillCatalog;
  /** Available-to-this-dev capabilities (defaults to scan/version-resolved). */
  readonly capabilities?: readonly Capability[];
  /** The dev's active model family for the §5.5.5b model-gate (optional). */
  readonly activeModel?: CapabilityModelFamily;
  /**
   * Local-context probe seam (SPEC §8.6 / Part D). Defaults to the real
   * `gatherLocalContext` over the payload's transcript_path + cwd. Injected in tests.
   */
  readonly gatherLocalContext?: (deps: { transcriptPath: string; cwd: string }) => LocalContext;
  /** Corpus reader for the miner (defaults to readCorpusTypedPrompts). */
  readonly readCorpus?: (sinceWatermark: number) => ReturnType<typeof readCorpusTypedPrompts>;
  /**
   * W2-LEVEL1 taste-corpus reader seam. Defaults to reading
   * `${baseDir}/feedback-anchors.jsonl` (never throws → '' on any error). Injected in tests.
   * The raw text is parsed + selected by the pure taste.ts helpers.
   */
  readonly readFeedbackAnchorsText?: (baseDir: string) => string;
  /**
   * M4: external-skill index loader seam. Defaults to `loadSkillIndexPreferRuntime`
   * over the resolved base dir (G-M4b: a valid + newer runtime copy wins; corrupt/old
   * runtime → committed). Injected in tests. A null return (missing / malformed index)
   * or a stale index leaves the judge input byte-identical to today.
   */
  readonly loadSkillIndex?: () => SkillIndex | null;
  /**
   * G-M4b: the background index-refresh seam (step 4, after the miner). Defaults to the
   * real throttled fail-silent `runIndexRefresh`. Injected in tests.
   */
  readonly runIndexRefresh?: (input: IndexRefreshInput) => Promise<IndexRefreshResult>;
  readonly now?: () => number;
}

/**
 * Run the detached judge body. NEVER throws and never rejects: each of the three steps is
 * independently guarded, so a failure in one never aborts the others. Returns when all
 * three have been attempted.
 */
export async function runJudge(deps: JudgeDeps): Promise<void> {
  // TOP GUARD: recursion guard (decision #13).
  if (deps.env.PROMPT_COACH_JUDGING) return;

  const baseDir = resolveBaseDir(deps.env);
  const store = deps.store ?? createStore(baseDir);
  const patternsStore = deps.patternsStore ?? createPatternsStore(baseDir);
  const now = deps.now ?? Date.now;

  // Read + UNLINK the inbox immediately (a crash never leaves a stale payload, §8.3).
  const payload = store.readAndUnlinkInbox(deps.inboxPath);
  if (payload === null) return; // nothing to judge.

  const backend = deps.backend ?? (await defaultBackend(deps.env));

  // Track whether a quality tip was deposited THIS turn so the habit step can yield (§7.4).
  let qualityDeposited = false;

  // (1) QUALITY CASCADE — independently guarded.
  try {
    qualityDeposited = await runQualityStep(deps, payload, store, backend, now);
  } catch {
    // swallow — never let a cascade failure abort steps 2/3.
  }

  // (2) HABIT DELIVERY — independently guarded.
  try {
    await runHabitStep(deps, payload, store, patternsStore, backend, now, qualityDeposited);
  } catch {
    // swallow.
  }

  // M2 [A2] JUDGE-DONE MARKER — set on BOTH outcomes (deposited AND silent) so the
  // Stop-hook poll can tell "judge chose silence" from "tip still cooking" and exit
  // instantly on well-formed turns. Placed AFTER the habit step (the last mailbox
  // depositor — marking earlier could strand a same-turn habit tip) and BEFORE the
  // miner (which never deposits). Independently guarded; skipped for an old-shape
  // payload with no turn_id (the Stop poll then just caps safely).
  try {
    if (typeof payload.turn_id === 'string' && payload.turn_id.length > 0) {
      store.markTurnJudged(payload.session_id, payload.turn_id);
    }
  } catch {
    // swallow.
  }

  // (3) MINER THROTTLE — independently guarded.
  try {
    await runMinerStep(deps, store, patternsStore, backend, now);
  } catch {
    // swallow.
  }

  // (4) G-M4b INDEX AUTO-REFRESH — independently guarded, LAST: it runs strictly after
  // the mailbox deposit and the judged-marker above, so a slow (10s-timeout) fetch can
  // never delay same-turn tip delivery. Throttled to once per 7 days; fail-silent.
  try {
    await runIndexRefreshStep(deps, store, now);
  } catch {
    // swallow.
  }
}

/**
 * Step 1 — run the quality cascade and, on a fired tip, deposit it + record the quality
 * cooldown AND the fired lever in ONE atomic state write (§15b caller duty). Returns true
 * iff a quality tip was deposited this turn (so the habit step can yield).
 */
async function runQualityStep(
  deps: JudgeDeps,
  payload: InboxPayload,
  store: Store,
  backend: LlmBackend,
  now: () => number,
): Promise<boolean> {
  // M5 WATCH-FIRST: count this prompt into the watch window BEFORE markGreetedIfFirst
  // below — the greet write is itself an engagement marker for the null-watch migration,
  // so observing first keeps a fresh install's very first prompt from self-classifying
  // as "engaged" and pre-closing the window for the exact user it exists for.
  const watch = store.observeWatch(payload.session_id, now());

  const transcriptReader = deps.readTranscript ?? recentTranscriptWindow;
  const transcript = transcriptReader(payload.transcript_path, MAX_TRANSCRIPT);

  // Gather the local context ONCE per run (SPEC §8.6 / Part D). The probe never throws;
  // an all-null context is byte-identical to today's behavior.
  const probe = deps.gatherLocalContext ?? gatherLocalContext;
  const localContext = probe({
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
  });

  // Map the raw JSONL model string → CapabilityModelFamily for the §5.5.5b model-gate,
  // but ONLY when the caller did not explicitly inject `deps.activeModel` (an explicit
  // injection always wins over the probe-derived family).
  const activeModel =
    deps.activeModel ?? modelStringToFamily(localContext.activeModel);

  const catalog = deps.catalog ?? (await defaultCatalog());
  const capabilities = deps.capabilities ?? (await defaultCapabilities(activeModel));

  const stateNow = store.getState();

  // Resolve the judge model from the env (default opus; PROMPT_COACH_JUDGE_MODEL overrides).
  const skill = { ...PROMPT_COACH_SKILL, judgeModel: resolveJudgeModel(deps.env) };

  // PERSISTENT per-session first-seen check (the judge is a fresh process per prompt, so an
  // in-memory flag re-greeted every turn — the live bug). True only on the first prompt of
  // this session. Retained for the M5 announce gating (don't announce on a session's turn 1).
  //
  // ORDERING: the TOUR decision must be taken BEFORE markGreetedIfFirst writes greetedSessions
  // — that write is itself an engagement marker, so evaluating the tour after it would make a
  // genuinely fresh install self-classify as "engaged" and swallow its own tour. So we compute
  // firstSeen (a pure read of whether this session was greeted) first, decide the tour, then
  // commit the greet write.
  const firstSeenBeforeGreet = !(stateNow.greetedSessions ?? []).includes(payload.session_id);

  // Item 3: the FIRST-RUN TOUR is ONCE PER INSTALL (not per session). Show it only on a
  // session's first prompt AND only if this install has never been toured (persisted,
  // migration-guarded for engaged upgraders). markTourShownIfFirst runs ONLY on a first-seen
  // turn so a mid-session prompt never consumes the install-wide tour flag. Evaluated on the
  // pre-greet state so the fresh install is not mis-migrated as engaged. This is what the
  // cascade prepends (its `firstSeen` param); the every-session ping is dead.
  const showTour = firstSeenBeforeGreet && store.markTourShownIfFirst();

  // Commit the per-session greet AFTER the tour decision (its write is an engagement marker).
  // Called for its side effect only — the cascade's tour trigger is `showTour`, not this return.
  store.markGreetedIfFirst(payload.session_id);

  // W2-LEVEL1: load + select the owner's taste examples from the local feedback corpus.
  // Pure parse + select; cold-start (< floor) → [] → the judge input is byte-identical to
  // pre-Level-1. NEVER feeds the offline κ judge (that path is in eval/, separate).
  const tasteBaseDir = resolveBaseDir(deps.env);
  const tasteText = (deps.readFeedbackAnchorsText ?? readFeedbackAnchorsText)(tasteBaseDir);
  const tasteExamples = selectTasteExamples(parseFeedbackAnchors(tasteText), now());

  // M4: external-skill candidates. Missing/malformed index (loader → null) or a stale
  // one (> 180 days) → undefined → the judge input is byte-identical to today. The
  // exclusion set folds catalog.all (installed + curated — installed-catalog-wins at
  // match time) PLUS every capability id/trigger (pre-empts the §5.5.5f backtick
  // fail-closed landmine for a marketplace skill literally named e.g. `code-review`).
  let externalCandidates: readonly ExternalCandidate[] | undefined;
  try {
    const index = (
      deps.loadSkillIndex ?? (() => loadSkillIndexPreferRuntime(resolveBaseDir(deps.env)))
    )();
    if (index !== null && isFresh(index, now())) {
      const excludedNames = new Set<string>();
      for (const id of catalog.all) excludedNames.add(foldName(id));
      for (const cap of CAPABILITY_CATALOG) {
        excludedNames.add(foldName(cap.id));
        excludedNames.add(foldName(cap.trigger));
      }
      externalCandidates = matchExternalSkills(payload.prompt, index, excludedNames);
    }
  } catch {
    externalCandidates = undefined; // any surprise → feature silently absent.
  }

  const result = await runQualityCascade({
    prompt: payload.prompt,
    transcript,
    backend,
    skill,
    // The cascade's `firstSeen` param is the install-wide TOUR trigger (item 3), not the
    // per-session greet — it prepends the 4-line tour exactly once per install.
    firstSeen: showTour,
    state: stateNow,
    catalog,
    capabilities,
    sessionId: payload.session_id,
    now,
    activeModel,
    localContext,
    tasteExamples,
    externalCandidates,
  });

  if (result === null) {
    // M5: a silent turn right after the window closed is the natural announce moment —
    // exactly ONCE (markAnnouncedIfFirst is the atomic first-caller check), never on the
    // TOUR turn (the once-per-install tour owns that turn's meta-message slot).
    if (windowClosed(watch) && !watch.announced && !showTour && store.markAnnouncedIfFirst(now())) {
      depositAnnounce(store, payload, watch.promptsObserved);
      return true; // the announce is this turn's quality banner → habit yields.
    }
    return false;
  }

  // M5 WATCH GATE — at the SURFACING decision only (the cascade above ran unchanged).
  // A CRITIQUE lever (any lever not explicitly opportunity — fail-closed) is OBSERVE-ONLY
  // until the window is closed AND the announce has surfaced: the verdict goes to the
  // withheld log instead of the mailbox. NOTHING else moves — no cooldown (arming it
  // would suppress a later OPPORTUNITY tip via the cadence gate, violating "the window
  // only ADDS suppression"), no lever-used mark, no lastTip (the owner must never rate a
  // tip they never saw). Taste/threshold learning keeps accumulating: opportunity tips
  // stay rateable and the withheld log itself is the growing critique baseline.
  if (
    result.lever !== undefined &&
    isCritiqueLever(result.lever) &&
    !(windowClosed(watch) && watch.announced)
  ) {
    // The cascade concatenates the first-run tour into a tour-turn tip — strip it from
    // the withheld text so the log holds the bare critique.
    const pingPrefix = `${formatCoachBanner(COACH_FIRST_RUN_TOUR)}\n`;
    const tipText = result.tip.startsWith(pingPrefix)
      ? result.tip.slice(pingPrefix.length)
      : result.tip;
    store.recordWithheldTip({
      lever: result.lever,
      tip: tipText,
      prompt: payload.prompt,
      at: now(),
    });
    if (showTour) {
      // The withhold must not swallow the once-per-install tour — deposit it bare,
      // mirroring the tour-only turn (lever-less: no cooldown, not rateable).
      store.writeMailbox(payload.session_id, {
        kind: 'quality',
        message: formatCoachBanner(COACH_FIRST_RUN_TOUR),
        ...(payload.turn_id ? { turnId: payload.turn_id } : {}),
      });
    } else if (windowClosed(watch) && !watch.announced && store.markAnnouncedIfFirst(now())) {
      // The closing-turn path: the last withheld critique and the announce share the
      // turn — one banner, one meta-message.
      depositAnnounce(store, payload, watch.promptsObserved);
      return true; // the announce is this turn's quality banner → habit yields.
    }
    return false; // withheld ≠ deposited — the habit step stays eligible.
  }

  // A surface fired. Always deposit it (the additive liveness ping/sentinel still reaches the
  // human). But the quality COOLDOWN must be armed ONLY by a real coaching tip (one with a
  // fired lever) — a bare ping carries no lever. Arming the cooldown for the once-per-session
  // welcome ping was the root cause of "intro shows, then no coaching ever follows": the ping
  // set lastQualityTipAt=now (a GLOBAL value), and the cascade's cadence gate then suppressed
  // every real tip for 10 minutes. Mirror the result.lever guard used below (recordLastTip,
  // yield-to-quality) so only a genuine fire arms the cooldown + records same-lever suppression.
  // M2 attribution: carry the judged prompt on REAL coaching tips only (a lever rode) —
  // a bare welcome ping/sentinel is not "about your prompt" and must never be labeled so.
  // The turnId rides on every deposit (same-turn vs late-surface discrimination).
  store.writeMailbox(payload.session_id, {
    kind: 'quality',
    message: result.tip,
    ...(result.lever !== undefined ? { prompt: payload.prompt } : {}),
    ...(payload.turn_id ? { turnId: payload.turn_id } : {}),
  });
  if (result.lever !== undefined) {
    store.markQualityTip(now(), payload.session_id, result.lever);
  }

  // F-FEEDBACK: record the fired tip (lever + prompt) so a later `/coach 👍/👎` rates THIS
  // tip — only for a real coaching fire (a lever rode); a bare liveness ping carries none.
  if (result.lever !== undefined) {
    store.recordLastTip({
      lever: result.lever,
      prompt: payload.prompt,
      sessionId: payload.session_id,
      at: now(),
    });
  }

  // YIELD-TO-QUALITY (§7.4/§8) applies ONLY to a real quality COACHING tip (one with a
  // fired lever). A bare additive liveness ping/sentinel is NOT coaching and must NOT
  // suppress a habit nudge this turn — so habit yields only when a lever actually fired.
  return result.lever !== undefined;
}

/**
 * M5: deposit the one-time watch-window announce as a lever-less quality tip — the proven
 * meta-message channel (no cooldown armed, not rateable, rides the same-turn drain). It
 * carries the turnId (same-turn vs late discrimination) but NO prompt (it is not "about
 * your prompt"). The caller has already won markAnnouncedIfFirst.
 */
function depositAnnounce(store: Store, payload: InboxPayload, promptsObserved: number): void {
  store.writeMailbox(payload.session_id, {
    kind: 'quality',
    message: formatCoachBanner(announceMessage(promptsObserved)),
    ...(payload.turn_id ? { turnId: payload.turn_id } : {}),
  });
}

/**
 * Step 2 — habit delivery (§7.4). Match the in-hand prompt against the open patterns; if
 * matched AND the habit cooldown elapsed AND we did NOT deposit a quality tip this turn
 * (yield-to-quality), deposit a `habit` tip, markSurfaced(habitKey), and record
 * lastSurfacedPatternKey + lastHabitNudgeAt in the SAME atomic state write (§7.6).
 */
async function runHabitStep(
  _deps: JudgeDeps,
  payload: InboxPayload,
  store: Store,
  patternsStore: PatternsStore,
  backend: LlmBackend,
  now: () => number,
  qualityDeposited: boolean,
): Promise<void> {
  // Yield-to-quality: do not stack a habit on the same turn a quality tip was deposited.
  if (qualityDeposited) return;
  if (store.habitOnCooldown(now())) return;

  const open = patternsStore.readPatterns().filter((p) => p.status === 'open');
  // §7.4 deterministic lexical match FIRST (no LLM). Only when it misses AND the prompt
  // looks handoff-ish does the §5.5.6c fuzzy fallback spend ONE cheap Haiku yes/no call —
  // bounded to ~1/dev/day by the 24h habit cooldown gate we already passed above.
  const matched: Pattern | null =
    matchHabit(payload.prompt, open) ?? (await fuzzyFallback(payload.prompt, open, backend));
  if (matched === null) return;

  // ONE voice: wrap the habit body in the shared Boris banner, exactly like a quality tip
  // (the drain then applies the same ⏪-attribution when it surfaces late).
  const tip = formatCoachBanner(composeHabitTip(matched, matched.occurrenceCount));
  store.writeMailbox(payload.session_id, {
    kind: 'habit',
    message: tip,
    // M2 attribution: a habit nudge IS about the matched prompt → labeled when late.
    prompt: payload.prompt,
    ...(payload.turn_id ? { turnId: payload.turn_id } : {}),
  });
  // Atomic state write: lastHabitNudgeAt + lastSurfacedPatternKey together (§7.6).
  store.markHabitNudge(now(), matched.habit_key);
  // Flip the pattern status to surfaced (never resurfaces; dismissed wins on merge).
  patternsStore.markSurfaced(matched.habit_key, now());
}

/**
 * Step 3 — the throttled miner (§7.2). Reads the watermark-filtered corpus and runs the
 * miner; on a real mine it returns the advanced state, which we persist. The miner is a
 * no-op (zero LLM) when the throttle fails.
 */
async function runMinerStep(
  deps: JudgeDeps,
  store: Store,
  patternsStore: PatternsStore,
  backend: LlmBackend,
  now: () => number,
): Promise<void> {
  const state = store.getState();
  const corpusReader =
    deps.readCorpus ??
    ((since: number) => readCorpusTypedPrompts({ sinceWatermark: since }));
  const corpus = corpusReader(state.lastMinedWatermark);

  const result = await runHabitMiner({
    state,
    backend,
    corpus,
    store: patternsStore,
    now: now(),
  });

  if (result.mined) {
    store.saveState(result.nextState);
  }
}

/**
 * Step 4 — the G-M4b background index refresh (§D2): rides the detached judge AFTER the
 * tip deposit + judged-marker + miner. The module owns throttle/kill-switch/fail-silent
 * semantics; this step only supplies the state + env + baseDir and PERSISTS the returned
 * nextState (caller-deposits, mirroring the miner step).
 */
async function runIndexRefreshStep(
  deps: JudgeDeps,
  store: Store,
  now: () => number,
): Promise<void> {
  const state = store.getState();
  const run = deps.runIndexRefresh ?? runIndexRefresh;
  const result = await run({
    state,
    env: deps.env,
    baseDir: resolveBaseDir(deps.env),
    now,
  });
  if (result.nextState !== state) {
    store.saveState(result.nextState);
  }
}

/** M4: fold a skill/capability id for the external-exclusion set (mirrors catalog fold). */
function foldName(s: string): string {
  return s.trim().toLowerCase();
}

/** Default real backend (CLI default; §6.3). */
async function defaultBackend(env: ConfigEnv & { ANTHROPIC_API_KEY?: string }): Promise<LlmBackend> {
  return createLlmBackend(env);
}

/** Default merged skill catalog: scan installed skills + the curated seed. Never throws. */
async function defaultCatalog(): Promise<MergedSkillCatalog> {
  let installed: string[] = [];
  try {
    installed = await scanInstalledSkills();
  } catch {
    installed = [];
  }
  return createMergedSkillCatalog(installed);
}

/**
 * W2-LEVEL1 default taste-corpus reader: read `${baseDir}/feedback-anchors.jsonl` as text.
 * NEVER throws — a missing file / read error → '' (cold-start → no taste section). The pure
 * taste.ts helpers parse + select.
 */
function readFeedbackAnchorsText(baseDir: string): string {
  try {
    return readFileSync(join(baseDir, 'feedback-anchors.jsonl'), 'utf8');
  } catch {
    return ''; // no corpus yet (or unreadable) → cold start.
  }
}

/**
 * Default available-to-this-dev capabilities: resolve every catalog entry against the
 * scanned installed-commands + probed CLI version (+ optional active model), keeping only
 * the available ones. Never throws (degrades to []).
 */
async function defaultCapabilities(
  activeModel: CapabilityModelFamily | undefined,
): Promise<readonly Capability[]> {
  let installedCommands: string[] | null = null;
  try {
    installedCommands = await scanInstalledCommands();
  } catch {
    installedCommands = null;
  }
  let cliVersion: string | null = null;
  try {
    cliVersion = claudeCliVersion();
  } catch {
    cliVersion = null;
  }
  const person = { installedCommands, cliVersion, activeModel };
  const out: Capability[] = [];
  for (const cap of CAPABILITY_CATALOG) {
    const resolved = resolveCapability(cap.id, person);
    if (resolved.available && resolved.capability !== null) out.push(resolved.capability);
  }
  return out;
}

/** The real entry: argv[2] = inbox path, run the judge, exit 0. */
async function main(): Promise<void> {
  const inboxPath = process.argv[2] ?? '';
  try {
    await runJudge({ env: process.env, inboxPath });
  } catch {
    // never throw.
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
