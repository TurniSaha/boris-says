---
description: Control + teach the local prompt coach (off|on|status|build|find|dismiss|👍|👎|undo).
argument-hint: "[off|on|status|build|find|dismiss|👍|👎|undo]"
allowed-tools: Bash(node:*)
---

# /coach — control the local prompt coach

The coach mutates on-disk state, so this command does NOT just inject a prompt —
it runs a tiny path-anchored node script that read-merge-writes `state.json` /
`patterns.json` under `~/.claude/prompt-coach/` directly (SPEC §11.3).

Run the coach CLI with the requested subcommand and report its output verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/coach-cmd.js" '$ARGUMENTS'`

> The bare `node` invocation matches the declared `Bash(node:*)` permission so fresh installs
> never hit an approval wall (if node is missing the command errors visibly — install node).
> If bare `/coach` does not resolve on your build, use the namespaced form `/boris-says:coach <sub>`.
>
> Note: `$ARGUMENTS` is SINGLE-QUOTED above so the shell never runs command substitution
> on it (e.g. `find $(rm -rf x)` is passed as literal text, never executed). It arrives as
> ONE argv element; the CLI splits it into subcommand + query itself. A literal single
> quote in your arguments will break this one quoting — the command errors harmlessly
> (a no-op) rather than doing anything unsafe; just re-run without the stray quote.

Subcommands:

- `/coach status` — enabled state, last tip time, quality/habit cooldown remaining,
  count of discovered patterns, and the backend in use (and whether metered API
  billing is active).
- `/coach off` / `/coach on` — toggle the kill switch (`state.enabled`).
- `/coach build [habit_key]` — write the drafted primitive (skill / CLAUDE.md rule / hook)
  for the last-surfaced habit (or the named `habit_key`) as a REVIEW file — it never
  activates anything: skills land as `SKILL.md.draft`, rules/hooks under
  `~/.claude/prompt-coach/drafts/`, and enabling is always a printed manual step.
- `/coach find <query>` — search the committed external-skill index (372
  entries: 272 official + 100 curated community) on demand — top matches with source URL, stars, and the install command.
  Fully offline, no LLM call; never installs anything.
- `/coach dismiss` — mark the last-surfaced HABIT pattern dismissed (never resurfaces).
- `/coach 👍` (or `up`/`good`) — rate the last 🐾 tip HELPFUL → that lever fires more (after ≥3 ratings).
- `/coach 👎` (or `down`/`bad`) — rate the last tip UNHELPFUL → that lever fires less. Each rating also
  appends a labeled anchor to the local feedback corpus.
- `/coach undo` — revert the most recent rating.
