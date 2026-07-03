# Boris Says

**Boris Says — the real-time coach in your corner. Boris Cherny watches how you drive Claude Code and speaks only when it matters. Local-only, no server. He hands you the right move before you swing — and knows when to shut up.**

`/insights` tells you afterwards — if you remember to run it. Boris Says acts *while you work*: it judges the
prompt you just typed and lands its tip on the **same turn**, notices workflows you keep repeating and
drafts the skill/rule/hook for you, and surfaces the right external skill at the moment you need it.
Entirely on your own machine, no server.

It stays quiet when you're already prompting well — the survival rule is **precision over recall**: a
coach that fires weak or wrong tips gets disabled, so this one is built to shut up.

> **Status:** built and installable. Committed `dist/` (zero runtime dependencies), full test +
> conformance gate green. Install with the steps below. See [`docs/SPEC.md`](docs/SPEC.md) for the design spec.

## What it does during your session

1. **Same-turn coaching.** The judge runs detached in the background (your prompt never freezes), and a
   `Stop`-hook drain delivers the tip **with the turn it judged** — advice about prompt N appears at the
   end of turn N, not bolted onto your next question. If the judge is still thinking when the turn ends,
   the tip surfaces on your next prompt with an explicit `⏪ about your prompt: "…"` label so it's never
   confusing.

2. **Repetition → automation.** A habit miner reads your own local session history; when a workflow
   recurs across **3+ distinct sessions**, it background-drafts the fix — a skill, a CLAUDE.md rule, or a
   hook — grounded only in your own prompts. `/coach build` writes the draft as a **review file** that
   cannot auto-load (skills land as `SKILL.md.draft`, rules and hooks under
   `~/.claude/prompt-coach/drafts/`). Enabling is always your manual step; the coach never edits
   `settings.json` or your `CLAUDE.md`.

3. **Skill discovery at the moment of need.** A committed index of **372 external skills/plugins** —
   272 from the two official Anthropic repos (`anthropics/skills`, `anthropics/claude-plugins-official`)
   plus a 100-entry curated community slice (labeled `community`, held to stricter matching floors,
   install commands generated never trusted; see `NOTICE`) — is matched against your current task by a precision-walled
   matcher (multiple concordant signals required — a single generic word never triggers a match; an exact
   multi-word skill name typed verbatim does). When one genuinely fits, a
   tip shows **at most one** suggestion with its source URL, repo stars, and the install command. It
   **never auto-installs** — you review, you run the command. `/coach find <query>` searches the same
   index on demand, fully offline (no LLM call). `npm run refresh-index` re-scrapes.

4. **It earns the right to critique you.** On a fresh install, prompt-quality critiques are
   **observe-only for the first 3 sessions and 30 prompts** (both must pass): the judge logs what it
   *would* have said — visible under "withheld critiques" in `/coach status` — while it builds a baseline
   of how you actually work. Then it announces itself once and switches to conservative critique with the
   👍/👎 loop below. Opportunity tips (skills, capabilities) are active from day one. Installs that were
   already engaged skip the window entirely.

5. **Honest outcome recap.** When you come back to a project, the first prompt of the session can carry a
   one-line recap of how the last session in *that project* actually ended — per-signal and grounded only
   in what the transcript shows ("N tests passed", "no test run detected"), never a fabricated score.
   Shown once, then consumed.

**The relevance invariant:** every tip must be about the task in your current prompt. Read-only or
investigative prompts ("check X", "why does Y…") never get change-directed nudges, and a tip that would
be equally "true" on any prompt you could have typed doesn't fire. Terse, expert, and continuation
prompts stay silent on purpose.

## Install

From a clone of this repo (the committed `dist/` means there is **no build step**):

```text
# In Claude Code:
/plugin marketplace add /path/to/Claude-Coach
/plugin install boris-says@boris-says
```

**Requirements:** Claude Code (a recent build with plugin support), `node` on your `PATH`, and a Claude
login (the coach's LLM calls reuse your existing `claude -p` auth — no API key, no per-call charge; set
`PROMPT_COACH_USE_API=1` with `ANTHROPIC_API_KEY` only if you prefer the raw API).

> **Reload after installing.** Claude Code registers hooks at session **start**, so the coach won't fire in
> the session you installed it in — **restart Claude Code** (or reload plugins) to activate it. This is the
> single most common "it didn't fire" cause. See [INSTALL.md](INSTALL.md) for the full walkthrough.

## What you'll see — real transcripts

These are **actual outputs from the real pipeline** (2026-07-02), not a mock-up. At the **end of the
same turn**, a banner appears (the judge runs in the background while Claude works, so your prompt never
freezes):

> The **Boris Cherny persona is a playful homage** — this project is not affiliated with or endorsed by
> him or Anthropic.

**1. A bundled mega-ask** →

```text
build the auth system and the billing dashboard and migrate the db then deploy to prod
```
```text
  🤖  Boris says: I'm in your corner!

  This bundles four separate deliverables — the auth system, the billing
  dashboard, the DB migration, and the prod deploy — each of which needs its own
  plan, scope, and review; split them into separate asks and start with one.
  rate this: /coach 👍 or 👎  ·  /coach undo
```

**2. A vague "make it better"** →

```text
make the dashboard better
```
```text
  🤖  Boris says: I'm in your corner!

  "Better" how — is it load speed, a confusing chart, or the mobile layout?
  Name the one thing and how you'll know it improved before you start.
  rate this: /coach 👍 or 👎  ·  /coach undo
```

**3. A data-destructive op on prod** →

```text
DROP the users table in prod and re-run the migration
```
```text
  🤖  Boris says: I'm in your corner!

  Take a snapshot of users (or run it through a reversible migration with a
  rollback) BEFORE you DROP it on prod — a dropped table has no undo.
  rate this: /coach 👍 or 👎  ·  /coach undo
```

**…and the silences are the point.** The coach says **nothing** on a typo fix, a bare `continue`, or a
read-only config check — terse, expert, and continuation prompts are presumptively fine. A coach that
fires on those gets disabled; precision over recall is the survival rule.

If the judge finishes after the turn ends, the same banner arrives on your next prompt with a
`⏪ about your prompt: "…"` attribution line on top.

> **Fresh install?** Critiques like the one above are **observe-only** for your first 3 sessions and 30
> prompts (feature 4 above) — run `/coach status` to see what the coach is withholding while it watches.
> Opportunity tips (skill/capability suggestions) fire from day one.

**Liveness check:** type `when life gives you lemons` any time → it replies `make lemonade! 🍋` on the
same turn, confirming the hook is wired.

## How it works (no server)

Claude Code already writes your complete session transcript to `~/.claude/projects/.../<session>.jsonl`.
The plugin reads that directly — the per-prompt judge reads the live session; the habit miner reads your
whole local corpus. Judging runs in a detached background process; the tip is delivered via Claude Code's
`systemMessage` channel (shown to you, never injected into the model's context, so it can't steer the
agent). Same-turn delivery comes from a `Stop` hook that drains the judge's mailbox when Claude finishes
responding.

## Accuracy — how it gets good

The coach's accuracy mechanism is the **live feedback loop**, not a fixed benchmark:

```text
/coach 👍    # that tip was helpful   (also: /coach up | good)
/coach 👎    # that tip was annoying  (also: /coach down | bad)
/coach undo  # revert the last rating
```

Once a lever has ≥3 ratings, its firing threshold adapts (bounded, so one rating never swings it): a lever
you keep 👎-ing fires **less**; a 👍-loved one fires **more**. It learns *your* taste on *your* real prompts
— which is also why critique starts observe-only: on day one it has zero taste data about you.

There is also an offline eval harness (a blind judge scored against owner-ratified gold anchors). Honest
numbers: on the 60-anchor set the blind text-only judge agreed with the author's labels 52/60 (~87%),
Cohen's κ ≈ 0.56 — which does **not** clear the project's strict κ ≥ 0.60 calibration bar, partly a
structural ceiling (many real prompts are image-rich; a text judge can't see what you saw). So the shipped
quality signal is the live 👍/👎 loop, not a published precision number. See `eval/` for the methodology.

## Controls

```text
/coach status     # on/off, backend, cooldowns, watch-window + withheld critiques,
                  # external-index freshness, pending drafts, per-lever 👍/👎 tallies
/coach off        # kill switch
/coach on         # re-enable
/coach build      # write the last-surfaced habit's drafted skill/rule/hook as a REVIEW
                  # file (or: /coach build <habit_key>) — never activates anything
/coach find <q>   # search the committed external-skill index, offline
/coach dismiss    # silence the last habit suggestion (never resurfaces)
/coach 👍 | 👎    # rate the last tip (aliases: up/good, down/bad)
/coach undo       # revert the last rating
```

## Privacy

Everything stays on your machine. The only network calls are the LLM judge calls (to Anthropic, via your
own auth) — no server, no telemetry, ever.

**Exactly what leaves your machine per judge call** (and nothing else):

- your **latest prompt** (verbatim, as data);
- your **last 8 transcript prompts** (your prior typed prompts in this session — oldest first;
  the AI's replies and tool output are *not* sent);
- a short **rolling summary** of your working style (currently empty on the local build);
- up to **10 of your rated taste examples** — the prompts you gave a 👍/👎 with `/coach`, as
  advisory few-shot context (in-context only; there is no training).

The judge payload is passed to the `claude` CLI over **stdin**, not on the command line, so it is
never visible to other local processes via `ps`. The **habit miner** reads your all-project session
history **locally only** — it never leaves your machine and is never part of a judge call.

The external-skill index is a static file committed to this repo, scraped from public Anthropic +
community repos at build time; `/coach find` and the matcher never phone home, and nothing is ever
installed without you running the command yourself. State lives in plain JSON under
`~/.claude/prompt-coach/`. Delete that directory to reset.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build/test workflow and repo layout. The one hard rule:
`npm run gate` (build + tests + conformance) must stay green, and `dist/` is committed so installs need no
build step — rebuild it (`npm run build`) and commit it alongside any `src/` change.

## License

MIT — see [LICENSE](LICENSE).
