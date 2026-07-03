/**
 * Capability-awareness — the zero-dependency strict semver gate.
 *
 * pm-service has NO semver dependency (Codex blocker #5), and the version gate is
 * tiny + pure, so we hand-roll a strict `x.y.z` numeric compare here. It version-
 * gates the universal Claude capabilities (keywords/modes/flags/built-in slash
 * commands) the coach may surface: a capability with a `minVersion` is available only
 * when the dev's probed `claude --version` is at or above it.
 *
 * Contract (spec §4c):
 *  - minVersion === null         -> always true (long-stable feature, no lower gate).
 *  - minVersion set, cli null OR  -> false (FAIL-CLOSED: never surface a version-gated
 *    unparseable                     capability when we cannot confirm the dev's build).
 *  - both parse                  -> numeric major/minor/patch compare, cli >= min.
 *
 * Any trailing ` (Claude Code)` / `-prerelease` / `+build` suffix is ignored — only
 * the LEADING strict `x.y.z` triplet is parsed.
 */

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse the LEADING strict `x.y.z` from a version string, or null. */
function parseSemver(value: string | null): Semver | null {
  if (typeof value !== 'string') return null;
  // Anchored at the start so a two-segment '2.1' (no patch) does NOT match — strict
  // x.y.z only. A trailing suffix (space, '-', '+', '(') is allowed and ignored.
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Numeric compare: negative if a<b, 0 if equal, positive if a>b. */
function compare(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * True iff `cliVersion` satisfies the lower bound `minVersion` per the §4c contract.
 * Fail-closed: a set minVersion with a null/unparseable cliVersion is NOT satisfied.
 */
export function satisfiesMinVersion(cliVersion: string | null, minVersion: string | null): boolean {
  if (minVersion === null) return true; // no lower gate (a deliberate null = long-stable).
  const min = parseSemver(minVersion);
  // A NON-null but unparseable minVersion is a catalog DATA ERROR (e.g. a typo '2.1'
  // instead of '2.1.0'). Fail-CLOSED rather than silently ungate the capability for
  // everyone — a broken gate that hides the capability is far safer than one that
  // surfaces it to users below the intended floor. (Codex H1.)
  if (min === null) return false;
  const cli = parseSemver(cliVersion);
  if (cli === null) return false; // fail-closed: gated, but version unknown/unparseable.
  return compare(cli, min) >= 0;
}
