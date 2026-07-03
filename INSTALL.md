# Installing `boris-says`

A local, zero-infra Claude Code plugin: a real-time, in-session coach (Boris Says). It reads
your own session JSONL off disk and surfaces at most one short 🤖 tip per prompt,
delivered on the **same turn** it judged via a `Stop`-hook drain (through Claude
Code's `systemMessage` channel — shown to you, never injected into the model's
context). It never blocks your prompt.

## Requirements
- Claude Code (recent build with plugin support)
- `node` on your PATH (the hook is `node ${CLAUDE_PLUGIN_ROOT}/dist/hook.js`)
- A Claude subscription (the coach's LLM calls use `claude -p` on your
  subscription — **no per-call charge**; raw API only if you set
  `PROMPT_COACH_USE_API=1`)

## Install (local marketplace)

From a clone of this repo:

```
# In Claude Code:
/plugin marketplace add /path/to/boris-says
/plugin install boris-says@boris-says
```

(`/plugin marketplace add` points at this repo root, where
`.claude-plugin/marketplace.json` lives; the plugin `source` is `./`, so it
installs the committed tree — `dist/` is committed, so there is **no build
step**.)

## Reload first

Claude Code registers hooks at session **start**. The coach will **not** fire in the
session you installed it in — **restart Claude Code** (or reload plugins) to activate
it. This is the most common "it didn't fire" cause.

## Verify it works (the 🤖 eyeball)

After installing **and reloading**, the fastest same-turn liveness check (works on a
brand-new install, no LLM call, no watch window) — type exactly:

```
when life gives you lemons
```

Boris replies `make lemonade! 🍋` on the **same turn**. If you see that, the hooks are
wired and the coach is awake.

**Then try a real coaching nudge.** Type a prompt a senior engineer would stop you on:

```
rewrite the whole billing module onto a new pricing engine
```

At the **end of that same turn** you should see the "🤖 Boris says: I'm in your corner!"
banner with a one-line nudge (e.g. "sketch the steps and the riskiest part before diving
in"). The judge runs in the background so your prompt never freezes; if it finishes after
the turn ends, the tip arrives on your next prompt with a `⏪ about your prompt: "…"` label.
Terse, expert, or continuation prompts stay silent (precision over recall).

> **Fresh install — this nudge is withheld at first.** Prompt-quality critiques are
> **observe-only for your first 3 sessions and 30 prompts** — the coach logs what it
> *would* have said (see "withheld critiques" in `/coach status`), announces itself once,
> then enables. So on a new install the billing prompt above stays silent (or shows the
> one-time first-run tour) — that is expected. Opportunity tips (skill/capability
> suggestions) fire from day one, and the lemons check above always works.

## Controls

```
/coach status     # on/off, backend, cooldowns, watch window + withheld critiques,
                  # external-index freshness, pending drafts, per-lever feedback
/coach off        # disable (kill switch)
/coach on         # re-enable
/coach build      # write the last-surfaced habit's drafted skill/rule/hook as a
                  # REVIEW file (or /coach build <habit_key>) — never activates:
                  # skills land as SKILL.md.draft, rules/hooks under
                  # ~/.claude/prompt-coach/drafts/; enabling is your manual step
/coach find <q>   # search the committed external-skill index, offline (no LLM)
/coach dismiss    # dismiss the last surfaced habit pattern (never resurfaces)
```

## Teaching the coach (live self-tuning)

After a **🤖 quality tip** fires, rate it — the coach learns from YOUR judgment:

```
/coach 👍         # that quality tip was helpful  (also: /coach up | good)
/coach 👎         # that quality tip was annoying/wrong  (also: /coach down | bad)
/coach undo       # revert the last rating
```

`/coach 👍`/`👎` rate the last **🤖 quality tip** (the lever-based nudges). **🐾 habit
nudges** are not rated this way — their control is `/coach dismiss` (the pattern never
resurfaces) or `/coach build` (write its drafted fix). Rating right after a habit nudge
would land on the previous quality tip, so stick to `dismiss`/`build` for habits.

Once a lever (e.g. plan-first, reversibility) has ≥3 ratings, its firing
threshold adapts: a lever you keep 👎-ing fires LESS; a 👍-loved one fires MORE
(bounded, so one rating never swings it). `/coach status` shows the per-lever
tallies + the learned shift. Every rated fire is also saved to a local
`feedback-anchors.jsonl` corpus, so your real ratings can sharpen the offline
accuracy eval too. Stored locally in plain JSON; your recent ratings are also
fed to the judge's own LLM calls (via your existing Claude auth) as in-context
taste examples — the same channel every judge call already uses.

## What it does
1. **Per-prompt quality judge, same-turn** — reads this session's transcript; on a
   genuinely weak prompt/process it surfaces ONE nudge (plan-first on complex work,
   definition-of-done, reversibility on destructive ops, verify-the-change,
   decompose a bundled ask, reuse-a-skill, …), delivered with the turn it judged.
   Model-aware: never recommends a flag your active model can't use (e.g.
   `--effort xhigh` only to Opus/Fable). Read-only/investigative prompts never get
   change-directed nudges.
2. **Capability + external-skill awareness** — weaves in a relevant installed
   capability/skill when one materially helps the exact gap, and can suggest at
   most ONE external skill from a committed index scraped from the official
   Anthropic repos (source URL + stars + install command shown; never
   auto-installs). `/coach find <query>` searches the same index on demand.
3. **Cross-session habit coach → drafted automation** — mines your whole
   `~/.claude/projects` corpus for workflows repeated across 3+ sessions, surfaces
   a cited (count-grounded) nudge, and background-drafts the fix; `/coach build`
   writes it as a review file. A good habit surfaces nothing.
4. **Honest outcome recap** — the first prompt back in a project can carry a
   one-line, per-signal recap of how the last session there actually ended
   ("N tests passed" / "no test run detected") — never a fabricated score.

## Privacy / cost
- All state lives under `~/.claude/prompt-coach/` (plain JSON). No boris-says server,
  no telemetry — nothing about you or your prompts is ever sent to us or a third party.
- Two kinds of outbound calls, both first-party and carrying none of your data: (1) the
  coach's own LLM call via `claude -p` on your subscription, and (2) a **once-per-7-days
  background GitHub refresh** of the public skill index (`api.github.com` +
  `raw.githubusercontent.com`, static `boris-says` user-agent, no prompt text). Opt out
  with `PROMPT_COACH_NO_INDEX_REFRESH=1` — Boris then uses only the committed static index.
- The hook is non-blocking and returns in well under the budget; the judge runs
  detached in the background.

## Uninstall
```
/plugin uninstall boris-says      # stop the hooks
rm -rf ~/.claude/prompt-coach      # delete local state (includes verbatim prompt text)
```
`/plugin uninstall` alone leaves `~/.claude/prompt-coach/` on disk. That directory holds
your rated taste examples and coach state — including prompt text you typed — so remove
it too for a clean uninstall.

## Anti-overengineering (retrospective)
When a session ends having produced an unusually large diff, the **outcome recap**
for that project (shown once, on your first prompt back) appends a short
prune-the-diff clause. It stays silent on lean diffs and outside a git repo — the
coach never fills silence with generic advice.
