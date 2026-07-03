#!/usr/bin/env node
/**
 * scripts/bump-version.mjs — bump the plugin version across ALL manifests in lockstep.
 *
 * Claude Code caches an installed plugin under ~/.claude/plugins/cache/<mkt>/<plugin>/<version>/
 * and only re-copies from the marketplace when the VERSION STRING CHANGES. If a release keeps the
 * same version, `/plugin update` reports "already latest" and users silently run stale code. So
 * EVERY release MUST bump the version — this script is the single source of that bump.
 *
 * Usage: node scripts/bump-version.mjs [patch|minor|major|<explicit x.y.z>]   (default: patch)
 * Bumps package.json, .claude-plugin/plugin.json, and BOTH version fields in
 * .claude-plugin/marketplace.json. Fails loudly if they disagree at start (they must be in sync).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];

function readJson(p) { return JSON.parse(readFileSync(join(root, p), 'utf8')); }
function currentVersions(obj, out = []) {
  if (obj && typeof obj === 'object') {
    if (typeof obj.version === 'string') out.push(obj.version);
    for (const v of Object.values(obj)) currentVersions(v, out);
  }
  return out;
}

// 1. Collect every version string; they must all agree.
const all = new Set();
for (const f of files) for (const v of currentVersions(readJson(f))) all.add(v);
if (all.size !== 1) {
  console.error(`version drift — manifests disagree: ${[...all].join(', ')}. Fix before bumping.`);
  process.exit(1);
}
const cur = [...all][0];

// 2. Compute the next version.
const arg = (process.argv[2] || 'patch').trim();
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [maj, min, pat] = cur.split('.').map((n) => parseInt(n, 10));
  if (arg === 'major') next = `${maj + 1}.0.0`;
  else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
  else if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
  else { console.error(`unknown bump: "${arg}" (use patch|minor|major|x.y.z)`); process.exit(1); }
}

// 3. Rewrite every "version": "<cur>" occurrence to <next> (string-level so nested entries all move).
for (const f of files) {
  const p = join(root, f);
  const before = readFileSync(p, 'utf8');
  const after = before.replaceAll(`"version": "${cur}"`, `"version": "${next}"`);
  writeFileSync(p, after);
}
console.log(`${cur} -> ${next}`);
