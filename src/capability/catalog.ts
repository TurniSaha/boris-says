import { satisfiesMinVersion } from './version.js';

/**
 * THE CLAUDE CAPABILITY CATALOG — the descriptive knowledge base the coach draws on
 * to surface Claude Code's OWN capabilities the dev may not know exist, INSIDE the
 * nudges it already fires. Sibling of skill-catalog.ts (which owns SKILLS); this owns
 * CAPABILITIES (slash commands, keywords, modes, authoring primitives, CLI flags).
 *
 * TWO SOURCES OF TRUTH (the /design-sync lesson):
 *  - AVAILABILITY = the dev's machine. For per-dev-variable custom/plugin slash
 *    commands we require the id to be in person.installedCommands (scanned on disk).
 *    For the UNIVERSAL features (keywords/modes/flags) + built-in slash commands we
 *    version-gate against the dev's probed `claude --version` (people.cliVersion).
 *    We NEVER surface a capability we cannot confirm THIS dev has (the trust-hazard
 *    invariant).
 *  - KNOWLEDGE (what/when/cost/min-version/kind) = Anthropic's official docs index
 *    (code.claude.com/docs/llms.txt) + the weekly whats-new digests. This seed is
 *    drawn from that snapshot (tasks/claude-docs-llms-index.txt) + the local
 *    `claude --help`/`--version` ground truth (tasks/claude-feature-catalog-research.md).
 *    Refresh via tasks/refresh-capability-catalog.mjs (spec §9).
 *
 * COST is DISCLOSURE, not a gate (owner decision): billed / expensive_multiagent
 * capabilities ARE eligible to surface; the nudge composer just MENTIONS the cost.
 * costClass never excludes a capability from resolving as available.
 *
 * §5.5.5 SHAPE additions (capability-fitness):
 *  - appliesAt: 'launch' | 'in_turn' — a launch-only flag (effort-xhigh, worktree, any
 *    cli_flag needing a fresh process) is dropped mid-session by the cascade (§5.5.5a).
 *  - modelFamily?: 'opus' | 'opus46' | 'fable' | 'sonnet5' | 'sonnet' | 'mythos' | 'codex'
 *    (or modelFamilies?: a SET) — a model-scoped capability resolves available:false when the
 *    dev's active model is out of scope (§5.5.5b). effort-xhigh is scoped to {opus, fable,
 *    sonnet5, mythos} per the official effort matrix (so `opus46`/`sonnet`/`codex` are excluded).
 */

/** The five capability kinds — each is invoked differently, so each is phrased differently. */
export type CapabilityKind = 'slash_command' | 'keyword' | 'mode' | 'authoring' | 'cli_flag';

/** Cost disclosure tiers. Drives the appended cost clause, NOT eligibility. */
export type CapabilityCostClass = 'cheap' | 'billed' | 'expensive_multiagent';

/** How we establish THIS dev has the capability. */
export type CapabilityAvailability =
  /** A slash command detected in person.installedCommands (custom/plugin, per-dev). */
  | 'disk_command'
  /** A built-in slash command; available by version range only (no per-dev list API). */
  | 'builtin_version'
  /** A keyword/mode/cli_flag/authoring feature; universal on a recent build. */
  | 'universal_version';

/**
 * When a capability is actually usable (§5.5.5a). A `launch` capability needs a fresh
 * process (relaunching discards the loaded session) so it is dropped mid-session.
 */
export type CapabilityAppliesAt = 'launch' | 'in_turn';

/**
 * Model family a capability is scoped to (§5.5.5b). Omitted = model-agnostic.
 * `fable` (Fable 5), `sonnet5` (Sonnet 5), and `mythos` (Mythos 5) are first-class
 * xhigh-capable families per the official effort matrix
 * (platform.claude.com/docs/en/build-with-claude/effort, fetched 2026-06-30):
 * `xhigh` is scoped to Fable 5 + Mythos 5 + Opus 4.8/4.7 + Sonnet 5 — NOT Sonnet 4.6 /
 * Opus 4.6 / Codex.
 *
 * `sonnet5` (Sonnet 5) is a SEPARATE family from `sonnet` (Sonnet 4.x). This split is the
 * load-bearing W2-MODELGATE fix: Sonnet 5 IS xhigh-capable, Sonnet 4.6 is NOT. `sonnet`
 * (Sonnet 4.x) is a KNOWN family that is OUT of the xhigh scope, so the gate actively HIDES
 * `--effort xhigh` from a Sonnet 4.6 dev (closing the over-fire) — as opposed to leaving it
 * `undefined`/ungated, which would fail open and keep wrongly offering xhigh to Sonnet 4.6.
 *
 * `opus` (Opus 4.7/4.8) vs `opus46` (Opus 4.5/4.6) is the SAME split for the Opus line: the
 * effort matrix lists Opus 4.8 + 4.7 as xhigh-capable but NOT Opus 4.6 (it is max-only, where
 * `xhigh` silently falls back to `high`). `opus46` is a KNOWN out-of-scope family so the gate
 * hides `--effort xhigh` from an Opus 4.6/4.5 dev too. `opus` stays the xhigh-capable family
 * (4.7/4.8) — the catalog scopes xhigh to `opus`, not `opus46`.
 */
export type CapabilityModelFamily = 'opus' | 'opus46' | 'fable' | 'sonnet5' | 'sonnet' | 'mythos' | 'codex';

export interface Capability {
  /** Canonical id, e.g. 'design-sync', 'ultracode', 'plan-mode', 'effort-xhigh'. */
  readonly id: string;
  readonly kind: CapabilityKind;
  /** Exact invocation surface: '/design-sync', 'ultracode', 'Shift+Tab', '--effort xhigh'. */
  readonly trigger: string;
  /** One line, from the docs — what it does. */
  readonly what: string;
  /** When it materially helps (the coach's fit criterion). */
  readonly when: string;
  readonly costClass: CapabilityCostClass;
  readonly availability: CapabilityAvailability;
  /** Lower version gate (e.g. '2.1.154'); null = long-stable (no lower gate). */
  readonly minVersion: string | null;
  /** A version where it was REMOVED (e.g. /vim removed 2.1.92); null = still present. */
  readonly removedIn: string | null;
  /**
   * When the capability is usable (§5.5.5a). A `launch` capability needs a fresh
   * process; the cascade drops launch-only capabilities mid-session.
   */
  readonly appliesAt: CapabilityAppliesAt;
  /**
   * Model family this capability is scoped to (§5.5.5b). Omitted = model-agnostic.
   * A model-scoped capability resolves available:false when the dev's active model
   * is out of scope. Use `modelFamily` for a single-family scope; use `modelFamilies`
   * for a capability valid on a SET of families (e.g. `--effort xhigh` on Opus + Fable).
   */
  readonly modelFamily?: CapabilityModelFamily;
  /**
   * The SET of model families this capability is scoped to (§5.5.5b / §10 effort matrix).
   * When present it supersedes the scalar `modelFamily`: the gate hides the capability iff
   * the KNOWN active model is not in this set. UNKNOWN active model never gates (fail-safe).
   */
  readonly modelFamilies?: readonly CapabilityModelFamily[];
  /** Citation. */
  readonly docUrl: string;
}

/** The minimal person shape the resolver reads (decoupled from the full repo Person). */
export interface CapabilityPerson {
  readonly installedCommands: readonly string[] | null;
  readonly cliVersion: string | null;
  /**
   * The session runtime's active model family (§5.5.5b). When provided, a
   * model-scoped capability whose `modelFamily` differs resolves available:false.
   * Omitted = no model gate applied (the resolver cannot confirm the model).
   */
  readonly activeModel?: CapabilityModelFamily;
}

/** The resolver result — mirrors the skill-catalog action resolution shape. */
export interface ResolvedCapability {
  readonly available: boolean;
  readonly capability: Capability | null;
}

const DOCS = 'https://code.claude.com/docs/en';

/**
 * THE SEED. Drawn from the official llms.txt snapshot + local `claude --help` (v2.1.185
 * ground truth). minVersion is set ONLY for version-volatile features the research
 * confirmed as recent (ultracode/ultrathink/agent-teams/code-review-ultra); long-stable
 * features carry null (no lower gate). removedIn carries the changelog-confirmed removals
 * (/vim, /output-style) so the coach never names a dead command.
 *
 * NOTE on built-in slash commands: they are 'builtin_version' (version-gated, not
 * per-dev disk-scanned) because there is no per-dev built-in list API. The dev's OWN
 * custom/plugin slash commands (like /design-sync) are 'disk_command' (resolved from
 * person.installedCommands). A built-in is therefore surfaced to everyone on a recent
 * build; a custom command only to a dev who actually has it on disk.
 */
export const CAPABILITY_CATALOG: readonly Capability[] = [
  // ── slash_command: per-dev DISK detection (custom/plugin) ─────────────────────────
  {
    id: 'design-sync',
    kind: 'slash_command',
    trigger: '/design-sync',
    what: 'pushes a React design system to claude.ai/design, bundling the real component code',
    when: 'the dev is hand-maintaining design tokens or a component library by hand',
    costClass: 'cheap',
    availability: 'disk_command',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'goal',
    kind: 'slash_command',
    trigger: '/goal',
    what: 'sets an explicit session goal the agent steers toward',
    when: 'a fresh, fuzzy task with no stated definition of done',
    costClass: 'cheap',
    availability: 'disk_command',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'loop',
    kind: 'slash_command',
    trigger: '/loop',
    what: 'runs a prompt or command on a recurring interval (or self-paced)',
    when: 'a repetitive check or poll the dev keeps doing by hand',
    costClass: 'cheap',
    availability: 'disk_command',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },

  // ── slash_command: BUILT-IN (version-gated) ───────────────────────────────────────
  {
    id: 'agents',
    kind: 'slash_command',
    trigger: '/agents',
    what: 'creates and manages custom subagents (their own context + tools)',
    when: 'the dev keeps re-explaining the same specialized role to the agent',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/sub-agents.md`,
  },
  {
    id: 'code-review',
    kind: 'slash_command',
    trigger: '/code-review',
    what: 'reviews the current branch or a PR for bugs, security, and quality',
    when: 'about to commit or open a PR with no review pass',
    costClass: 'billed',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'code-review-ultra',
    kind: 'slash_command',
    trigger: '/code-review ultra',
    what: 'runs a multi-agent CLOUD review of the branch or PR (deeper, adversarial)',
    when: 'a high-stakes change (auth, migration, money) deserves a thorough review',
    costClass: 'expensive_multiagent',
    availability: 'builtin_version',
    minVersion: '2.1.150',
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/code-review.md`,
  },
  {
    id: 'security-review',
    kind: 'slash_command',
    trigger: '/security-review',
    what: 'audits changed code for OWASP-class vulnerabilities',
    when: 'the change touches auth, user input, secrets, or external calls',
    costClass: 'billed',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'compact',
    kind: 'slash_command',
    trigger: '/compact',
    what: 'summarizes and compacts the conversation to free context',
    when: 'the session context is nearly full mid-task',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'context',
    kind: 'slash_command',
    trigger: '/context',
    what: 'shows what is currently consuming the context window',
    when: 'the dev suspects context bloat or wants to budget it',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'rewind',
    kind: 'slash_command',
    trigger: '/rewind',
    what: 'restores files (and optionally the conversation) to an earlier checkpoint',
    when: 'the agent took a wrong turn and the dev wants to back out cleanly',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/checkpointing.md`,
  },
  {
    id: 'btw',
    kind: 'slash_command',
    trigger: '/btw',
    what: 'adds a side note to the running session without derailing the main task',
    when: 'the dev wants to add context mid-task without a new prompt',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: '2.1.140',
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  {
    id: 'batch',
    kind: 'slash_command',
    trigger: '/batch',
    what: 'runs a task across many inputs in one batched, cheaper pass',
    when: 'the same operation must repeat over many files/items',
    costClass: 'expensive_multiagent',
    availability: 'builtin_version',
    minVersion: '2.1.150',
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
  // NOTE (item 5, verified against the installed claude 2.1.199): there is NO `/deep-research`
  // SLASH command. The bundled "deep-research" is a WORKFLOW the agent invokes internally
  // (Workflow({name:'deep-research', args:'<question>'})), not something the dev types — so a
  // `/deep-research` slash_command entry would name a nonexistent command and is DROPPED. The
  // four kept commands here (/btw, /batch, ultracode, /fast) were confirmed present as real
  // literals in the installed CLI binary + its --help contexts.
  // Removed built-ins — kept ONLY so the resolver excludes them on a build past removal
  // (the coach must never name a dead command). removedIn from the changelog.
  {
    id: 'vim',
    kind: 'slash_command',
    trigger: '/vim',
    what: 'vim editing mode for the prompt',
    when: '(removed — never surfaced on a current build)',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: '2.1.92',
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/changelog.md`,
  },
  {
    id: 'output-style',
    kind: 'slash_command',
    trigger: '/output-style',
    what: 'switched the response output style',
    when: '(removed — never surfaced on a current build)',
    costClass: 'cheap',
    availability: 'builtin_version',
    minVersion: null,
    removedIn: '2.1.92',
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/changelog.md`,
  },

  // ── keyword: UNIVERSAL (version-gated, no disk scan) ──────────────────────────────
  {
    id: 'ultrathink',
    kind: 'keyword',
    trigger: 'ultrathink',
    what: 'allocates a large extended-thinking budget for deeper reasoning',
    when: 'a genuinely hard design/debugging problem that needs more reasoning',
    costClass: 'billed',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/best-practices.md`,
  },
  {
    id: 'ultracode',
    kind: 'keyword',
    trigger: 'ultracode',
    what: 'opts the turn into multi-agent orchestration (fan-out workflows)',
    when: 'a large migration, audit, or sweep one context cannot hold',
    costClass: 'expensive_multiagent',
    availability: 'universal_version',
    minVersion: '2.1.154',
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/changelog.md`,
  },

  // ── mode: UNIVERSAL ───────────────────────────────────────────────────────────────
  {
    id: 'plan-mode',
    kind: 'mode',
    trigger: 'Shift+Tab (plan mode)',
    what: 'enters a read-only plan-first mode that proposes a plan before any edit',
    when: 'a multi-step or risky change where diving straight in is unwise',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/plan-mode.md`,
  },
  {
    id: 'fast-mode',
    kind: 'mode',
    trigger: '/fast (fast mode)',
    what: 'runs Opus with faster output (no model downgrade)',
    when: 'an interactive, iterative session where latency matters',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: '2.1.150',
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/changelog.md`,
  },

  // ── cli_flag: UNIVERSAL ───────────────────────────────────────────────────────────
  {
    id: 'effort-xhigh',
    kind: 'cli_flag',
    trigger: '--effort xhigh',
    // §5.5.5a: launch-time guidance — reconcile the `when` to read explicitly as a
    // launch-time choice (recommending it mid-session means killing the loaded session).
    what: 'raises the coding effort/reasoning level for the session',
    when: 'AT LAUNCH for a gnarly task on an xhigh-capable model (Opus 4.8/4.7, Fable 5, Mythos 5, Sonnet 5) started at the default effort; a launch-time choice, not a mid-session one',
    costClass: 'billed',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'launch', // §5.5.5a: needs a fresh process.
    // §5.5.5b: `xhigh` is scoped to the Fable 5 + Mythos 5 + Opus 4.8/4.7 + Sonnet 5 families
    // per the official effort matrix (platform.claude.com/docs/en/build-with-claude/effort,
    // fetched 2026-06-30) — NOT Sonnet 4.6 / Opus 4.6 / Codex. Set-scoped so a Fable/Sonnet-5
    // dev is not wrongly denied it AND a Sonnet 4.6 dev is never wrongly offered it.
    modelFamilies: ['opus', 'fable', 'sonnet5', 'mythos'],
    docUrl: `${DOCS}/cli-reference.md`,
  },
  {
    id: 'worktree',
    kind: 'cli_flag',
    trigger: '--worktree',
    what: 'runs the session in an isolated git worktree',
    when: 'parallel work that should not collide on the main checkout',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'launch', // §5.5.5a: needs a fresh process.
    docUrl: `${DOCS}/cli-reference.md`,
  },

  // ── authoring: UNIVERSAL (how the dev EXTENDS Claude) ─────────────────────────────
  {
    id: 'create-subagent',
    kind: 'authoring',
    trigger: 'create a subagent',
    what: 'authors a reusable subagent with its own instructions, tools, and context',
    when: 'the dev keeps re-describing the same specialized role',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/sub-agents.md`,
  },
  {
    id: 'create-skill',
    kind: 'authoring',
    trigger: 'create a skill',
    what: 'authors a SKILL.md so Claude auto-loads that expertise when relevant',
    when: 'the dev keeps pasting the same domain knowledge or procedure',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/skills.md`,
  },
  {
    id: 'create-hook',
    kind: 'authoring',
    trigger: 'create a hook',
    what: 'authors a PreToolUse/PostToolUse/Stop hook to automate a repeated step',
    when: 'the dev asks for the same thing to happen every time (e.g. format-on-edit)',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/hooks.md`,
  },
  {
    id: 'create-command',
    kind: 'authoring',
    trigger: 'create a custom command',
    what: 'authors a ~/.claude/commands/*.md slash command for a repeated workflow',
    when: 'the dev repeats the same multi-step prompt across sessions',
    costClass: 'cheap',
    availability: 'universal_version',
    minVersion: null,
    removedIn: null,
    appliesAt: 'in_turn',
    docUrl: `${DOCS}/slash-commands.md`,
  },
];

/** Case-fold + trim so a catalog id and an on-disk scanned id compare cleanly. */
const fold = (s: string): string => s.trim().toLowerCase();

/**
 * Resolve a capability id to { available, capability } for ONE dev. The judge may
 * only surface an `available` capability. Unknown id -> { available:false,
 * capability:null }. Cost NEVER excludes — a billed/expensive capability resolves
 * available exactly like a cheap one.
 */
export function resolveCapability(
  idOrTrigger: string,
  person: CapabilityPerson,
  catalog: readonly Capability[] = CAPABILITY_CATALOG,
): ResolvedCapability {
  // Match on EITHER the canonical id OR the exact trigger (fold-insensitive). The
  // judge sees the list rendered as triggers ("- /design-sync (slash_command): …") and
  // naturally echoes the TRIGGER form ('/design-sync'), not the bare id ('design-sync')
  // — a real-key run confirmed this. Without trigger-matching every slash_command /
  // cli_flag capability (where trigger !== id) would silently resolve "not found" and be
  // dropped from the nudge. Id-match is tried first (canonical), then trigger-match.
  const key = fold(idOrTrigger);
  const capability =
    catalog.find((c) => fold(c.id) === key) ?? catalog.find((c) => fold(c.trigger) === key) ?? null;
  if (capability === null) return { available: false, capability: null };

  // §5.5.5b: model-scoped gate. When the capability declares a model scope (a SET via
  // `modelFamilies`, else the scalar `modelFamily`) AND the person's active model is KNOWN
  // and out of scope, it is not usable — hide it. (When the active model is unknown we
  // cannot apply the gate — fail-safe — so we fall through to the availability rules below;
  // the disk/version gates still apply.) The SET form supersedes the scalar so a capability
  // valid on several families (e.g. `--effort xhigh` on Opus + Fable) is not wrongly hidden.
  const scopedFamilies: readonly CapabilityModelFamily[] | null =
    capability.modelFamilies !== undefined
      ? capability.modelFamilies
      : capability.modelFamily !== undefined
        ? [capability.modelFamily]
        : null;
  if (
    scopedFamilies !== null &&
    person.activeModel !== undefined &&
    !scopedFamilies.includes(person.activeModel)
  ) {
    return { available: false, capability };
  }

  if (capability.availability === 'disk_command') {
    const installed = person.installedCommands;
    if (installed == null) return { available: false, capability }; // never scanned -> can't confirm.
    const has = installed.some((c) => fold(c) === fold(capability.id));
    return { available: has, capability };
  }

  // builtin_version / universal_version -> version-gated: available in [min, removedIn).
  // FAIL-CLOSED on an unconfirmable version: if the capability has a removedIn (it is a
  // REMOVED command kept in the catalog ONLY to suppress it) and we cannot confirm the
  // dev's version, we must NOT surface it — otherwise a null/unparseable cliVersion would
  // make `!satisfiesMinVersion(null, removedIn)` fail OPEN and name a DEAD command (the
  // trust-hazard the catalog exists to prevent). A removedIn capability is therefore
  // available ONLY when the version parses AND lands in [minVersion, removedIn).
  const cliParses = satisfiesMinVersion(person.cliVersion, '0.0.0'); // true iff cliVersion is a real semver.
  if (capability.removedIn !== null && !cliParses) {
    return { available: false, capability }; // can't confirm we're before the removal -> hide it.
  }
  const inLowerRange = satisfiesMinVersion(person.cliVersion, capability.minVersion);
  const notYetRemoved =
    capability.removedIn === null || !satisfiesMinVersion(person.cliVersion, capability.removedIn);
  return { available: inLowerRange && notYetRemoved, capability };
}
