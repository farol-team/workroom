---
description: Execute Ready for AI cards via worker iterations; auto-merge or escalate to Review. Accepts an optional single-card ref, --parallel N, and --resume <card-ref> for crash recovery.
argument-hint: "[card-ref] [--parallel N] [--resume <card-ref>]"
allowed-tools: Read, Glob, Grep, Edit, Write, Bash, mcp__trello
---

# /flow-run

Role: **execution meta-agent**. Invoked manually after the user has approved
plans by dragging cards into `Ready for AI`.

Invocation arguments (verbatim, parsed per `## Invocation` below):
`$ARGUMENTS`

This file is the orchestrator. Worker prompts live in
`.claude/prompts/worker-iter1.md` and `.claude/prompts/worker-iterN.md`.
The acceptance check procedure lives in
`.claude/prompts/acceptance-check.md`. PLAN format lives in
`.claude/prompts/plan-format.md`.

The model is **not one-shot**. Meta spawns a worker, runs an acceptance
check, and if gaps remain, spawns the worker again (up to 3 iterations).
After acceptance passes, meta decides whether to auto-merge the PR or
leave it for human `Review`.

## Invocation

Four forms, all run from a Claude Code session in the repo:

- `/flow-run` — process every card currently in `Ready for AI`,
  sequentially.
- `/flow-run <card-ref>` — process exactly one card in `Ready for AI`.
  `<card-ref>` accepts any of:
  - the tracker's native short id (e.g. Trello shortLink `aBcDeF12`,
    GitHub issue `#42`)
  - `<prefix>-<N>`, e.g. `ACME-3` (prefix from `.claude/tracker.json`
    `card_prefix`)
  - the card's URL in the tracker

  Exact patterns and precedence per provider:
  `.claude/providers/<provider>.md` → "Ref resolution".

  If the resolved card is NOT in `Ready for AI` → reply
  `Card <ref> is not in Ready for AI (currently in <list>). Move it to Ready for AI first.`
  and exit without changes.

- `/flow-run --parallel N` (also accepted: `-p N`, `--p N`, `--pN`,
  `-pN`) — process every Ready-for-AI card with up to **N** workers
  running concurrently. `N` is clamped to `[1, 4]`. Default without the
  flag is `N=1` (sequential). The flag is allowed together with a
  card-ref, but for a single-card invocation it's a no-op (one card =
  at most one worker).

- `/flow-run --resume <card-ref>` — continue a card whose run was
  interrupted mid-card (meta session died, machine rebooted). Only for a
  DEAD run: if the original meta session may still be alive, do not
  resume — two metas double-drive the card (duplicate paid spawns,
  duplicate comments). Requires BOTH: the card is in `In Progress`, and
  its state file `<target.worker_log_dir>/<card-short>-state.json`
  exists (see "State persistence" in Phase 2); otherwise exit with
  `Nothing to resume for <ref>: <which precondition failed>.`
  If the state file exists but is not valid JSON (torn write from the
  crash itself) → exit with `State file for <ref> is unreadable —
  inspect <path> and the worker logs manually.` No state change.
  Meta reloads the state, verifies the worktree and branch still exist
  (either missing → `Blocked` with `[meta] Resume failed: <what>. Manual
  cleanup.`), re-fetches the prompt inputs the journal does not carry —
  the `[meta] PLAN` comment and, for `iter > 1`, the `<gaps-list>` from
  the last `[meta] Iteration` audit comment — from the card, then
  re-enters at the recorded `next_action`:
  `spawn_iter_1` → the Step 2.1a TDD-gate eligibility check (NOT
  straight to Step 2.1 — a gated card must not silently lose its
  spec-first path); `spawn_iter_<N≥2>` → Step 2.1 with `iter = N`;
  `tdd_critic` → Step 2.1a.2; `tdd_impl` → Step 2.1a.4 (phase B,
  `--resume` the journaled `session_id`); `acceptance` → Step 2.3;
  `merge_decision` → Phase 3; `done` → report the last `iter_log`
  outcome (the card reached a terminal decision; if its list disagrees,
  the final state move failed — finish it manually) and exit.
  `--parallel` is ignored with `--resume`.

Combinations:
- `/flow-run ACME-3` → exactly that card, sequential by construction.
- `/flow-run -p2` → all Ready cards, up to 2 in flight.
- `/flow-run --parallel 3 ACME-3` → single card; flag ignored with a
  warning line.

## Contract (what you must NOT do)

- Do NOT write code yourself — only the worker (a `claude -p` process in a
  git worktree) writes code.
- Do NOT open the PR yourself — only the worker (iteration 1) does that.
- Do NOT move a card to `Done` or `Review` without first running the
  acceptance check.
- Do NOT comment in cards without the `[meta] ` or `[worker] ` prefix.
- Do NOT continue working on a card after `Blocked` — the next action is
  the human's.
- Do NOT auto-merge if any auto-merge criterion fails — escalate to `Review`.

## Sources of truth

- `.claude/tracker.json` — board, list IDs, `branch_prefix`, `worktree_root`,
  `worker_log_dir`, `auto_merge_criteria`, `session_log`.
- `.claude/prompts/worker-iter1.md`, `worker-iterN.md` — worker prompt templates.
- `.claude/prompts/acceptance-check.md` — verification procedure.
- `.claude/prompts/plan-format.md` — PLAN parsing contract.
- `.claude/providers/<tracker.provider>.md` — how THIS tracker performs
  the semantic ops, resolves refs, and defines `<card-short>`.
- `.claude/bin/` — the mechanical halves meta MUST call instead of
  improvising: `parse-verdict` (verdict extraction + fingerprints),
  `harvest-learnings`, `render-learnings`. Unit-tested in the kit repo
  (`tests/kit-bin.test.sh`).
- `flow-workflow.md` — optional project-owned workflow doc; absent
  by default (this command is self-contained without it).
- `CLAUDE.md` — commit style (worker reads it).
- `.gilb/session-log.md` — recent automation history.
- Project learnings file — `tracker.json` `learnings` (default
  `.claude/learnings.jsonl`): one JSON object per line,
  `{date, card, type, key, insight, confidence, files}`. Meta appends
  (single writer); subagents contribute via their verdicts.

## Algorithm

### Bootstrap (once)

0. Verify `jq` is available (`command -v jq`) — it parses the worker
   result envelopes and powers the guardrail hooks. Missing → stop with
   `jq is required by /flow-run. Install it first.`
   Read `tracker.provider` from `.claude/tracker.json` and read the
   provider doc `.claude/providers/<provider>.md` — it defines how every
   tracker operation (`list_items`, `read_item`, `create_item`,
   `move_state`, `add_comment`, `set_labels`, `checklist`,
   `archive_item`, `update_title`), the ref
   resolution and `<card-short>` work for this tracker. Missing config,
   unknown provider, or missing provider doc → stop with
   `Tracker provider '<name>' is not configured/supported. See .claude/providers/.`
   Verify the kit bin scripts exist and are executable
   (`.claude/bin/parse-verdict`, `harvest-learnings`,
   `render-learnings`). Missing → stop with
   `Kit bin scripts missing: <path>. Re-run bin/workflow-kit-sync.`
   Do not inline a fallback — hand-parsing verdicts is exactly the
   failure mode these scripts pin down.

1. Parse the invocation (see `## Invocation`):
   - Detect `--resume`. It requires a `<card-ref>` positional; `--resume`
     without one → exit with `--resume requires a card ref.`
   - Detect `--parallel N` / `-p N` / `--p N` / `--pN` / `-pN`. Clamp to
     `[1, 4]`. Default `N=1`. Reject non-integer / out-of-range with
     `Invalid --parallel value: <raw>. Expected integer in [1, 4].` and
     exit.
   - The remaining non-flag positional, if any, is `<card-ref>`. Reject
     `≥2` positionals with
     `Multiple card refs given. /flow-run accepts at most one card ref.`
     and exit.
2. Read the rest of `.claude/tracker.json`. Extract
   `states.{ready, in_progress, review, blocked, done}`, `branch_prefix`,
   `worktree_root`, `worker_log_dir`, `auto_merge_criteria`, `session_log`,
   `card_prefix`, the `research` block (`marker`, `doc_dir`, `target_repo`,
   `route`), the **runtime** config — `worker.{max_turns, model,
   resume_sessions}` (defaults: `100`, unset, `true`) and
   `acceptance.{max_turns, model}` (defaults: `50`, unset; empty-string
   `model` means "CLI default") and `tdd_gate.{enabled, min_size,
   min_risk, max_spec_iterations}` (defaults: `false`, `M`, `medium`, `2`
   — governs Step 2.1a) — and the **execution-target** config: the
   `targets` map (each: `repo_root`, `worktree_root`, `worker_log_dir`,
   `branch_prefix`, `toolchain`), `default_target`, and `repo_label_prefix`.
   The top-level `branch_prefix` / `worktree_root` / `worker_log_dir` are
   the back-compat default (equal to `targets[default_target]`).
3. Read last 30 lines of `.gilb/session-log.md` — skim for patterns
   (e.g., a card you're about to work on was just BLOCKED — check why).
4. Via the tracker (`list_items` per the provider doc), fetch open
   cards from all pipeline states except `icebox` for cross-card view,
   AND specifically the contents of the `ready` state. From these:
   - **If `<card-ref>` was given:** resolve it (see "Card ref resolution"
     below). If the resolved card isn't in `ready` → exit per the
     Invocation rules. Targets list = `[that card]`. (With `--resume` the
     expected list is `in_progress` instead of `ready`, and the card
     enters directly at its recorded `next_action` — Phase 1 is skipped.)
   - **Otherwise:** targets list = all cards currently in `ready`. If
     empty → reply "Ready for AI empty" and exit.
5. Directories are created per resolved target in Phase 1.e
   (`mkdir -p <target.worktree_root> <target.worker_log_dir>`), so a run that
   only touches gilb-recorder never creates gilb-web's dirs and vice versa.

#### Card ref resolution

Resolve `<card-ref>` per the provider doc's "Ref resolution" section
(URL → native short id → `<prefix>-<N>`, in that order). An
unrecognized ref → exit with
`Unrecognized card ref: <ref>. Expected <the provider's accepted forms>.`
A ref that resolves to no card → exit with
`Card <ref> not found.`. The provider doc also defines `<card-short>`
(used in branch names and log/state filenames).

### Per card

First classify the card: it is a **research card** if its title contains
`research.marker` (default `[research]`, case-insensitive) — equivalently,
if its approved comment is a `[meta] RESEARCH PLAN`. Research cards follow
the same four phases but with the deltas in `## Research cards` below
(meta-repo worktree, research worker prompt, doc-only acceptance, always
→ Review). Everything not overridden there is identical to a code card.

Then resolve the card's **execution target** (which repo + toolchain the work
lands in): if the card carries a `<repo_label_prefix><name>` label (default
`repo:`, e.g. `repo:gilb-web`) → `targets[name]`; a research card →
`targets.meta`; otherwise → `targets[default_target]` (gilb-recorder). All
repo-shaped values below — `repo_root`, `worktree_root`, `worker_log_dir`,
`branch_prefix`, `toolchain` — come from the resolved target (falling back to
the top-level keys when `targets` is absent, for back-compat). If a `repo:`
label names a target missing from `targets` → `Blocked` with
`[meta] Unknown execution target '<name>' (no targets.<name> in tracker.json).`

For each card in the resolved targets list:

1. **Phase 1: Prepare** (see below).
2. **Phase 2: Iteration loop** (see below).
3. **Phase 3: Auto-merge decision** (only if Phase 2 ended in acceptance;
   for research cards this always resolves to `Review` — see below).
4. **Phase 4: Finalize** (session-log entry; card already moved by prior phases).

Execution order:
- **`N == 1`** — strictly sequential: one card finishes (through Phase 4)
  before the next begins.
- **`N > 1`** — meta keeps up to `N` cards "in flight" (each in its own
  Phase 2 iteration loop, with its own worktree/branch/PR/log). Cards
  enter and leave in flight independently. See `## Parallel execution`
  for the orchestration contract.

### Summary

Print once at the end (after all in-flight cards have finished):

```
Execution complete (parallelism N=<N>):
- Cards processed: <count>
  - → Done (auto-merged): <M>
  - → Review (escalated): <R>
  - → Blocked: <K>
- Mean iterations: <num>
- Total cost: $<sum of all cards' cost_usd>
```

For single-card invocation, replace `Cards processed: <count>` with the
card title + short ref.

---

## Parallel execution

Only applies when `N > 1` AND the targets list has more than one card.

### Concurrency model

Meta keeps a queue of pending cards and a set of in-flight cards (size
≤ `N`). The unit of concurrency is **one card's Phase 1+2 pipeline** —
the meta-agent never runs two iteration loops in series for the same
card simultaneously, only across different cards.

Per-card pipeline is unchanged: Phase 1 → Phase 2 (iter loop) → Phase 3
(auto-merge decision) → Phase 4 (finalize). The acceptance check
(Phase 2.3) and the worker spawn (Phase 2.1) are both per-card, so they
run interleaved across the in-flight set.

### Spawning loop

```
pending  = targets list (FIFO)
in_flight = {}            # cardId → {worktree, branch, pr_url, iter, log_path, ...}

while pending or in_flight:
    while pending and len(in_flight) < N:
        card = pending.pop(0)
        run Phase 1 for card           # sync, fast (worktree create + state move)
        spawn iter 1 worker for card   # async (background)
        in_flight[card.id] = state

    wait for ANY in-flight worker to finish    # harness notification
    for each finished card:
        run Phase 2.2 (parse) + 2.3 (acceptance) + 2.4 (decide)
        if needs another iteration:
            spawn iter <iter+1> worker for card    # stays in_flight
        else:
            run Phase 3 (auto-merge decision) + Phase 4
            remove from in_flight
```

### Concurrency-specific rules

- **Phase 1 is serialized.** Worktree creation, the `In Progress` move,
  and the `[meta] Starting work` comment for the next card all happen
  on the meta-agent's main thread before the next worker spawn. This
  keeps the board ordered and avoids `git` racing itself in
  the parent repo.
- **Worker spawns are async.** Each is `claude -p ... &` (background)
  with its own result/stderr files in `<worker_log_dir>`.
- **Acceptance checks are serialized** per finished worker. Meta runs
  one acceptance procedure at a time (it competes for the same `cargo`
  / `gh` / tracker tools as Phase 1 and Phase 3); this prevents
  cargo registry locks and tracker rate-limit storms.
- **Auto-merge decisions are serialized.** Only one `gh pr merge` at a
  time. If two cards both reach Phase 3, the second waits.
- **Per-card iteration counter is independent.** Card A's iter 3 does
  not affect card B's iter limits.
- **Stop condition.** A `Blocked` decision for one card never aborts
  in-flight work on other cards. The summary at the end reports per-card
  outcomes.

### Cross-card conflicts (best-effort handling)

- Two PRs that both touch overlapping files in `main`: when the second
  one tries `gh pr merge` after the first has merged, conflicts may
  appear. Treat as an auto-merge blocker per "Phase 3" → escalate to
  `Review` with the `gh` error message in the comment.
- Two workers running cargo against the same workspace from different
  worktrees: each worktree has its own `target/`, so this is allowed.
  If RAM pressure is a concern, lower `N`.
- Tracker rate-limit: on HTTP 429 retry once after 5s; on second
  failure, treat as `tracker fails mid-card` per Failure modes → stop.
  Leave already-spawned workers to finish but do not start new ones.

---

## Phase 1: Prepare

a. Extract the `[meta] PLAN` comment from the card (latest one if multiple).
   If absent → move card to `Blocked` with
   `[meta] No PLAN comment. Run /flow-check first.` Append session-log
   `BLOCKED | no PLAN`. Skip.

b. Parse PLAN per `.claude/prompts/plan-format.md`. Extract `## Metrics`:
   `confidence`, `risk`, `expected_iterations`. If `## Metrics` missing or
   unparseable → `Blocked` with
   `[meta] PLAN has no parseable ## Metrics. Re-triage required.` Skip.
   Also read the optional `Base:` line directly under the `[meta] PLAN` first
   line (`^Base:\s*(\S+)$`) into `<base>`; if absent, `<base> = main`. Verify
   it exists on the remote (`git -C <target.repo_root> ls-remote --exit-code
   --heads origin <base>`); a `Base:` naming a missing branch → `Blocked` with
   `[meta] PLAN Base branch '<base>' not found on origin.` Skip. `<base>` drives
   the worktree checkout (e), the PR base (worker prompt), and the acceptance
   diff (Phase 2.3).

c. Generate `<slug>` from card title: lowercase, replace `[^a-z0-9-]` with
   `-`, collapse repeats, trim to 40 chars. `<card-short>` = per the provider
   doc (Trello: first 8 chars of the shortLink; GitHub: `i<number>`).

d. Branch: `<target.branch_prefix><card-short>-<slug>`. Worktree path:
   `<target.worktree_root>/<card-short>-<slug>` (meta-repo-relative, e.g.
   `gilb-web/.gilb/worktrees/...` — i.e. under the target repo's own `.gilb/`).

e. Create the worktree **in the target repo** (each repo holds its own
   worktrees under its own `.gilb/`):
   ```bash
   mkdir -p <target.worktree_root> <target.worker_log_dir>
   git -C <target.repo_root> fetch origin <base>
   git -C <target.repo_root> worktree add <abs-worktree-path> -b <branch> origin/<base>
   ```
   (`<base>` from step b; `main` unless the PLAN carries a `Base:` line.)
   Use the **absolute** worktree path (so `-C` doesn't resolve it relative to
   `repo_root`). For the default gilb-recorder target this is identical to the
   old behavior. If branch already exists → Blocked,
   `[meta] Branch <branch> already exists. Manual cleanup.` Skip.

f. **Toolchain preflight** (from `target.toolchain`), in the worktree:
   - `rust` → none (cargo resolves deps at build time).
   - `rails` → `bundle install` then `bin/rails db:test:prepare` (needs the
     repo's Ruby per `.ruby-version` and a reachable Postgres). On failure →
     Blocked with `[meta] Rails preflight failed: <cmd> — <tail of output>`;
     do not spawn the worker.
   - `docs` → none.

f2. **Provision worker guardrails** in the worktree — hooks that
   deterministically enforce the plan contract (scope + git safety),
   shipped with the kit under the meta project's `.claude/hooks/`:
   ```bash
   mkdir -p <worktree>/.claude/hooks
   cp <meta-project>/.claude/hooks/scope-guard.sh \
      <meta-project>/.claude/hooks/git-guard.sh \
      <worktree>/.claude/hooks/
   chmod +x <worktree>/.claude/hooks/*.sh
   cp <meta-project>/.claude/hooks/worker-settings.json \
      <worktree>/.claude/settings.local.json
   ```
   Then write `<worktree>/.claude/plan-allowed-files.txt` — the
   scope-guard manifest, one glob per line:
   - every path from the PLAN's `## Files` (strip the ` — what changes`
     tail; keep `(new)` entries — the path itself);
   - the standing exceptions: `.gitignore` and the target toolchain's
     lockfile (`Cargo.lock` / `Gemfile.lock` / the node lockfile);
   - for research cards: `<research.doc_dir>/*` instead of code paths.

   These four files (`settings.local.json`, two hook scripts, the
   manifest) are untracked by design; workers are instructed never to
   commit them, and the acceptance check flags them if committed.
   If the kit hooks are missing from `<meta-project>/.claude/hooks/` →
   proceed WITHOUT guardrails and note it once in chat (the acceptance
   check still enforces scope post-hoc); do not stop the run.

g. Move card to `In Progress`. Comment:
   ```
   [meta] Starting work
   Branch: <branch>
   Worktree: <worktree-path>
   Base branch: <base>
   PLAN confidence: <conf>/10, risk: <risk>, expected iters: <N>
   Iteration limit: 3
   ```
   Then write the card's initial state journal with
   `next_action: "spawn_iter_1"` (see "State persistence" in Phase 2) —
   the iteration-1 worker run is the longest crash window and must be
   covered before the spawn, not after its result is parsed.

---

## Phase 2: Iteration loop

In-memory state for this card:
- `iter` = 1
- `MAX_ITER` = 3
- `pr_url` = null
- `session_id` = null   // CLI session of the last worker run (for --resume)
- `cost_usd` = 0.0      // accumulated over worker + acceptance runs
- `agent_runs` = 0
- `iter_log` = []  // list of dicts: {iter, outcome, gaps_count, gaps_summary, log_path}
- `finding_history` = {}  // fingerprint → {first_iter, last_iter, times_in_gaps, status: open|fixed|ledgered}
- `prev_gap_fps` = []  // gap fingerprints of the PREVIOUS iteration (for the no-progress check)

**State persistence (crash recovery).** This state lives in meta's
context; a dead meta session loses it while the worktree and PR live on.
So meta journals the whole card state as one JSON object to
`<target.worker_log_dir>/<card-short>-state.json` — all fields above plus
`card_short`, `branch`, `worktree`, `base`, `pr_url`,
`tdd_critic_rejected` (has the test critic already used its one
rejection — so a resume at `tdd_critic` cannot grant a second respawn
budget), and `next_action`.
Write ATOMICALLY (write to `<path>.tmp`, then `mv` over) at each of
these points, with the `next_action` that names the step a resume should
re-enter:

| after | `next_action` |
|---|---|
| Phase 1.g (card moved to In Progress) | `spawn_iter_1` |
| Step 2.1a.1 (TDD phase-A result parsed) | `tdd_critic` |
| Step 2.1a.4 (critic approved, before phase B) | `tdd_impl` |
| Step 2.2 (worker result parsed OK) | `acceptance` |
| Step 2.4 needs-fix decision | `spawn_iter_<N+1>` |
| Step 2.4 accepted (before Phase 3) | `merge_decision` |
| Phase 3 / Phase 4 finished (card moved to its final list) | `done` |

`done` means the card actually reached its terminal list (Done / Review
/ Blocked) — an accepted verdict alone is `merge_decision`, so a crash
inside the auto-merge decision stays resumable. `/flow-run --resume
<card-ref>` reloads this file (see Invocation). Writing is best-effort:
a failed write never changes the iteration outcome — note it once in
chat and continue.

### Step 2.1a — TDD gate (spec-first, conditional)

Applies only when ALL hold: `iter == 1`, code card (not research),
`tdd_gate.enabled` in `tracker.json` is true, and the PLAN's Metrics meet
the gate threshold (`Estimated size` ≥ `tdd_gate.min_size` OR `Risk` ≥
`tdd_gate.min_risk`). Otherwise skip to Step 2.1 (worker-iter1.md already
carries inline test-first discipline for ungated cards).

1. **Spawn phase A** — same mechanics as Step 2.1 but the body is
   `.claude/prompts/worker-specs.md` (substitute `<learnings>` the same
   way as Step 2.1). Expected `result`: first line
   `SPECS_READY` (+ a `failing:` line). `BLOCKED:` / crash → handle
   exactly as Step 2.2. Store `session_id`.

   A phase-A `BLOCKED` that indicts the PLAN rather than the code —
   "cannot write any runnable failing spec for this card" on a move-only
   plan is the field case (agent-flow#12) — is not a terminal state.
   The sanctioned loop after the protocol Blocked: amend the PLAN (a
   fresh `[meta] PLAN` comment — correct the authored-delta size so the
   gate no longer applies, or name phase A's red per card-eval's
   move-only row), remove the worktree and branch, move the card back to
   `Ready for AI`, and re-enter Phase 1. Both field cases resolved in
   one pass this way; neither needed a third.
2. **Spawn test critic** — same mechanics as the acceptance check
   (Step 2.3: versatile+formatting roles, edit tools disallowed, fresh
   session, `acceptance.model` if set) with body
   `.claude/prompts/test-critic.md`. Extract its verdict with
   `.claude/bin/parse-verdict critic <result-json>` (exit 0 →
   `{verdict, findings, summary, learnings}` + `_`-meta; exit 3 →
   `BLOCKED` path; exit 4 → untrustworthy, Blocked) and pipe the
   output through `harvest-learnings` (max 1) per the Learnings
   harvest rule in Step 2.3.
3. **verdict == "rejected"** → respawn phase A ONCE via
   `--resume <session_id>` with a short body: the critic's `findings`
   list + "revise the specs, same rules, finish with SPECS_READY".
   Re-run the critic. If it rejects AGAIN → move card to `Blocked`,
   comment `[meta] Test critic rejected specs twice: <summary>` +
   findings; exit loop (a plan whose done-definition can't be encoded in
   two tries needs a human).
4. **verdict == "approved"** → comment on the card:
   ```
   [meta] TDD gate passed
   Specs: <failing: line from phase A>
   Critic: <summary>  (findings relayed to phase B: <N>)
   ```
   Then **spawn phase B** via `--resume <session_id>` with body
   `.claude/prompts/worker-impl.md` (`<critic-findings>` = the approved
   verdict's findings, or `none`). Its result is parsed by Step 2.2 as
   the iteration-1 result (expect `PR_URL=<url>`).

Costs: add every spawn's `total_cost_usd` to `cost_usd`, increment
`agent_runs` each time.

### Step 2.1 — Spawn worker

Result path: `<target.worker_log_dir>/<card-short>-iter<iter>.result.json`
(the CLI's JSON envelope). Stderr path:
`<target.worker_log_dir>/<card-short>-iter<iter>.stderr.log`.

Build the worker prompt by concatenating role blocks with the
iteration-specific template body, in this order:

1. `.claude/prompts/roles/engineering.md`
2. `.claude/prompts/roles/formatting.md`
3. The iteration body:
   - `iter == 1` → `.claude/prompts/worker-iter1.md`, substitute
     `<card-url>`, `<branch>`, `<base>`, `<PLAN-comment>`, `<learnings>`
     placeholders.
   - `iter > 1` → `.claude/prompts/worker-iterN.md`, substitute
     `<card-url>`, `<iter>`, `<MAX_ITER>`, `<pr_url>`, `<branch>`,
     `<PLAN-comment>`, `<gaps-list>` (from previous iteration's
     audit comment).

**Rendering `<learnings>`** (also used by phase A in Step 2.1a): write
the PLAN's `## Files` paths (tails stripped) to a temp file, then run,
from the TARGET REPO ROOT:
```bash
.claude/bin/render-learnings <learnings-file> <plan-files-tmp> "<card title>"
```
Its stdout IS the substitution value: up to the 5 highest-confidence
relevant entries (`[<type> <confidence>/10] <key>: <insight> (files: …)`
one per line), or the literal `none`. Selection: file/directory overlap
with the plan, or a key word matching the card title — a cheap
grep-class filter, not semantic search (a false positive costs the
worker one read; a false negative costs nothing that wasn't already
lost). Stale entries — every anchored file gone from `git ls-files` —
are dropped and reported as `stale: <key>` on stderr; relay those into
your working output (pruning candidates, not silently forgotten).

The role files are appended verbatim (no placeholder substitution);
only the body has placeholders. If any role file is missing → stop
with `Role prompt file missing: <path>`. Do not inline a fallback.

**Session resume policy.** When `worker.resume_sessions` is true
(default) AND `iter == 2` AND `session_id` from iter 1 is known, add
`--resume <session_id>` to the spawn — the worker keeps its iteration-1
context (cheaper, faster, no re-reading the repo). Iteration 3 always
starts a FRESH session: after two failed attempts a clean perspective
beats accumulated context. The iterN prompt body is the same either way.

Spawn:
```bash
cd <worktree-path>
claude -p "<prompt>" \
  --permission-mode bypassPermissions \
  --output-format json \
  --max-turns <worker.max_turns> \
  > <result-json> 2> <stderr-log>
CLI_EXIT=$?
```
Add `--model <worker.model>` when `worker.model` is non-empty, and
`--resume <session_id>` per the resume policy above. (The worktree's
`.claude/settings.local.json` from Phase 1.f2 arms the scope/git
guard hooks; they run even under `bypassPermissions`.)

### Step 2.2 — Parse worker result

Parse the JSON envelope from `<result-json>` (use `jq`):
`result` (the worker's final response text), `session_id` (store it),
`total_cost_usd` (add to `cost_usd`), `num_turns`, `is_error`.
Increment `agent_runs`.

- `CLI_EXIT != 0`, or `is_error == true`, or the file is missing /
  not valid JSON / has an empty `result` → **crash**:
  - Move to `Blocked`. Comment:
    `[worker] Worker crashed (iter <iter>, exit <CLI_EXIT>)\nLog: <stderr-log>`.
  - Append iter_log entry. Exit loop.
- `result` is the single line `PR_URL=<url>`:
  - If `iter == 1` → store `pr_url = <url>`.
  - If `iter > 1` → verify URL matches stored `pr_url`. Mismatch → Blocked
    `[worker] Iter <iter> opened NEW PR <new> instead of pushing to <pr_url>.`
  - Proceed to Step 2.3.
- `result` is the single line `BLOCKED: <reason>`:
  - Move to `Blocked`. Comment:
    `[worker] BLOCKED (iter <iter>): <reason>\nLog: <result-json>`.
  - Append iter_log entry. Exit loop, skip Phase 3, go to Phase 4 (Blocked path).
- Any other `result` (extra prose, multiple lines, hit `--max-turns`):
  - Move to `Blocked`. Comment:
    `[worker] Worker produced ambiguous output (iter <iter>)\nLog: <result-json>`.
  - Append iter_log entry. Exit loop.

Note the worker cannot set the CLI exit code; classification is by the
`result` text. `CLI_EXIT != 0` means the CLI itself failed (API error,
crash), never a worker decision.

### Step 2.3 — Acceptance check (subagent)

Spawn the acceptance check as a separate subagent — meta does NOT run
the procedure inline. This keeps verification isolated from
orchestration and leaves room for multi-model consensus later.

Build the acceptance prompt by concatenating, in order:

1. `.claude/prompts/roles/versatile.md` (the audit subagent is doing
   analysis, not code edits — `engineering.md` is the wrong role here)
2. `.claude/prompts/roles/formatting.md`
3. `.claude/prompts/acceptance-check.md` with placeholders substituted:
   `<card-url>`, `<pr_url>`, `<worktree-path>`, `<branch>`, `<base>`,
   `<PLAN-comment>`, `<prior-findings>`.

`<prior-findings>` renders `finding_history` — the literal string `none`
when it is empty (always on iteration 1), else one line per fingerprint:

```
<fingerprint> — <status> (first seen iter <first_iter>, in gaps <times_in_gaps>×)
```

Spawn (note the audit role is enforced by tooling, not just prompt —
edit tools are disallowed, and an acceptance-specific cheaper model
can be configured via `acceptance.model`):
```bash
cd <worktree-path>
claude -p "<acceptance-prompt>" \
  --permission-mode bypassPermissions \
  --disallowedTools Edit Write MultiEdit NotebookEdit \
  --output-format json \
  --max-turns <acceptance.max_turns> \
  > <target.worker_log_dir>/<card-short>-iter<iter>-acceptance.result.json \
  2> <target.worker_log_dir>/<card-short>-iter<iter>-acceptance.stderr.log
CLI_EXIT=$?
```
Add `--model <acceptance.model>` when non-empty. Acceptance never
resumes a session — an independent verdict requires a fresh context.

Then extract the verdict mechanically — do NOT parse `result` yourself:
```bash
.claude/bin/parse-verdict acceptance <acceptance-result-json>
PV_EXIT=$?
```
- **exit 0** — stdout is the normalized verdict: `gaps[]`,
  `gaps_summary`, `minor[]`, `verdicts`, `learnings` (contract defaults
  already filled — tolerant of the legacy two-key shape and of prose
  around the JSON line), plus `_fingerprints.{gaps,minor}` (entry-wise,
  `null` where unparseable), `_fps.{parsed,total}`, `_session_id`,
  `_cost_usd` (add to `cost_usd`), `_num_turns`. Empty `gaps` means
  acceptance passes; `minor` never blocks.
- **exit 3** — the subagent said `BLOCKED:`; stdout carries the reason.
  Move card to `Blocked` with
  `[meta] Acceptance subagent failed (iter <iter>): <reason>. Log: <acceptance-result-json>`.
  Skip Phase 3, go to Phase 4 (Blocked path).
- **exit 4, any other nonzero exit, or `CLI_EXIT != 0`** — the verdict
  is untrustworthy (envelope error, no verdict-shaped line, script
  failure). Blocked, comment with the log path and the script's stderr,
  skip Phase 3.

The `gaps[]` / `gaps_summary` fed into Step 2.4 below come from this
output.

**Fingerprints** come from `_fingerprints` (first `[...]` group per
entry, after the severity prefix — computed by the script). Entries with
`null` fingerprints are tolerated: they count as gaps/minors normally
but do not participate in history tracking or the no-progress check
(fail-open on format drift). Because every fail-open here silently
disables the anti-loop machinery, `_fps.parsed`/`_fps.total` is surfaced
as a `Fingerprints: <parsed>/<total>` line in the Step 2.4 iteration
comments — when parsed < total, that line is the only signal a human
gets that history tracking is partially blind (a persistent gap between
the two numbers means the acceptance prompt's output contract has
drifted and needs fixing).

**Learnings harvest.** Pipe the normalized verdict through the harvest
script (meta stays the single writer by being the only caller):
```bash
printf '%s' "<normalized-verdict-json>" \
  | .claude/bin/harvest-learnings <learnings-file> <card-short> <max>
```
`<max>` = 2 for acceptance, 1 for the test critic. The script enforces
the contract (required fields, allowed types, non-empty `files`; adds
`date` + `card`; dedup by `key` — replace only on strictly higher
confidence) and is best-effort by construction: it exits 0 even when it
writes nothing, and any failure never changes the iteration outcome.
Relay its stdout (`harvested <key> …` lines) into your working output.

### Step 2.4 — Decide outcome of this iteration

First update `finding_history` from the parsed verdict:

- every fingerprint in `gaps[]` → status `open`, `times_in_gaps += 1`,
  `last_iter = iter` (create with `first_iter = iter` when new);
- every fingerprint in `minor[]` → status `ledgered` (create when new;
  do not overwrite an `open` entry — a gap wrongly re-filed as minor
  stays `open`);
- every fingerprint previously `open` that appears in NEITHER array →
  status `fixed`.

**`gaps == []`** → acceptance passed.
- Append iter_log: `{iter, outcome: "accepted", gaps_count: 0, gaps_summary: "—", log_path}`.
- Comment in card:
  ```
  [meta] Iteration <iter>: ACCEPTED ✓
  Verdicts: spec=<verdicts.spec>, quality=<verdicts.quality>
  Fingerprints: <fps_parsed>/<fps_total>
  Log: <result-json>
  ```
- If `minor != []`, post ONE additional comment (the ledger — recorded,
  not blocking; the human triages it at Review or after merge):
  ```
  [meta] LEDGER — minor findings (non-blocking)
  1. <minor 1>
  2. <minor 2>
  ...
  ```
- **break** out of loop. Proceed to Phase 3.

**`gaps != []` and `iter < MAX_ITER`**:

**No-progress escalation (check before retrying).** If `iter >= 2`, all
current `gaps[]` entries carry fingerprints, and the current gap
fingerprint set is IDENTICAL to `prev_gap_fps` (nothing fixed, nothing
new), the worker is not converging — a third pass over the same
instructions will not help. Do not retry: treat this as the
`iter == MAX_ITER` branch below (Blocked path), with the comment header
`[meta] BLOCKED — no progress between iterations ✗`, an extra line
`Identical gap set across iter <iter-1> and iter <iter>: <fingerprints>`,
iter_log outcome `no_progress` (not `max_iter_reached`), and Phase 4
session-log form `BLOCKED | no progress, <N> gaps: <gaps_summary>`.
If any entry lacks a fingerprint, skip this check (fail-open) and retry
normally.

Otherwise:
- Set `prev_gap_fps` = current gap fingerprints.
- Append iter_log: `{iter, outcome: "needs_fix", gaps_count: <N>, gaps_summary, log_path}`.
- Comment in card (full audit so user need not open PR). For any gap
  whose fingerprint has `times_in_gaps >= 2`, append
  ` (REPEAT — unresolved since iter <first_iter>)`:
  ```
  [meta] Iteration <iter>: <N> gap(s), retrying
  Fingerprints: <fps_parsed>/<fps_total>

  **Acceptance gaps:**
  1. <gap 1 — file/line/command>
  2. <gap 2> (REPEAT — unresolved since iter <first_iter>)
  ...

  **Worker log:** <result-json>
  **Will retry as iteration <iter+1>.**
  ```
- Mirror to PR via `gh pr comment <pr-num> --body "..."`:
  ```
  [meta] Review (iter <iter>) — fixes required:

  1. <gap 1>
  2. <gap 2>
  ...

  Iteration <iter+1> will be spawned automatically.
  ```
- Increment `iter`, continue loop.

**`gaps != []` and `iter == MAX_ITER`**:
- Append iter_log: `{iter, outcome: "max_iter_reached", gaps_count: <N>, gaps_summary, log_path}`.
- Move card to `Blocked`. Comment (full history):
  ```
  [meta] BLOCKED after <MAX_ITER> iterations ✗
  Fingerprints: <fps_parsed>/<fps_total>

  **Iteration history:**
  - iter 1: <iter_log[0].outcome> — <gaps_count>: <gaps_summary>
  - iter 2: <iter_log[1].outcome> — <gaps_count>: <gaps_summary>
  - iter 3: <iter_log[2].outcome> — <gaps_count>: <gaps_summary>

  **Remaining gaps after iter <MAX_ITER>:**
  1. <gap 1>
  ...

  **PR:** <pr_url>
  **Logs:** <target.worker_log_dir>/<card-short>-iter*

  Manual intervention needed. After fixing, move card to Ready for AI or
  Backlog.
  ```
- Mirror short gap list to PR via `gh pr comment`.
- Exit loop. Skip Phase 3. Go to Phase 4 (Blocked path).

---

## Phase 3: Auto-merge decision

Only runs if Phase 2 ended with acceptance passing (gaps empty).

Read `auto_merge_criteria` from `.claude/tracker.json`:
- `min_confidence` (default 7)
- `max_risk` (default "medium")
- `require_ci_green` (default true)
- `strategy` (default "merge")

Collect failures into `merge_blockers[]`.

### Check 1: Confidence
- From PLAN `## Metrics: Confidence: <N>`.
- Pass if `confidence >= min_confidence`.
- Fail: `Confidence <N> < required <min_confidence>`.

### Check 2: Risk
- From PLAN `## Metrics: Risk: <low|medium|high>`.
- Pass if `risk` is at or below `max_risk` (order: low < medium < high).
- Fail: `Risk <risk> > max allowed <max_risk>`.

### Check 3: CI green
- If `require_ci_green` is false → skip.
- `gh pr checks <pr_url>` or `gh pr view <pr_url> --json statusCheckRollup`.
- Pass if all required checks are SUCCESS. If no checks are configured for
  the repo at all → treat as pass and note "no CI configured" in audit.
- Fail per failing check: `CI: <check name>: <status>`.

### Decision

**`merge_blockers == []`** → **auto-merge**.
```bash
gh pr merge <pr_url> --merge --delete-branch
```
(Strategy: `merge` = merge commit, per user choice. If `auto_merge_criteria.strategy`
is something else, adjust the flag: `--squash` or `--rebase`.)

Move card to `Done`. Comment:
```
[meta] AUTO-MERGED ✓
PR: <pr_url>
Strategy: <strategy>
Iterations: <iter> / 3
Confidence: <N>/10, Risk: <risk>
Cost: $<cost_usd> across <agent_runs> agent runs
Branch deleted (origin).

Iteration history:
- iter 1: <outcome> — <gaps_summary>
- iter 2: <outcome> — <gaps_summary>  (if applicable)
```

Append session-log: `<ts> <card-short> MERGED | iter=<N> conf=<N> cost=$<cost_usd> PR#<num>`.

Skip Phase 4 (finalized here).

**`merge_blockers != []`** → **escalate to Review**.

Move card to `Review`. Comment:
```
[meta] READY FOR REVIEW — auto-merge skipped

**Auto-merge blockers:**
1. <blocker 1>
2. <blocker 2>
...

PR: <pr_url>
Iterations: <iter> / 3
Cost: $<cost_usd> across <agent_runs> agent runs

Iteration history:
- iter 1: <outcome> — <gaps_summary>
- iter 2: <outcome> — <gaps_summary>  (if applicable)

Acceptance check passed; the criteria above kept this from auto-merge. Please review.
```

Append session-log: `<ts> <card-short> REVIEW | iter=<N> cost=$<cost_usd> blockers=<count>: <comma-joined>`.

Skip Phase 4 (finalized here).

---

## Phase 4: Finalize

Catch-all: append the session-log entry if not yet written. Paths from
Phase 2 (Blocked due to crash, blocked, or max-iter) come here without
writing — handle them:

- Crash/blocked: `<ts> <card-short> BLOCKED | <reason short form> cost=$<cost_usd>`
- Max-iter: `<ts> <card-short> BLOCKED | max-iter exhausted, <N> gaps: <gaps_summary> cost=$<cost_usd>`

For long-running cards, also write `STARTED` at the end of Phase 1 (gives
visibility into in-flight work). Then the terminal event (`MERGED` /
`REVIEW` / `BLOCKED`) replaces or follows.

**Publish harvested learnings.** If this card's run appended or replaced
entries in the learnings file, commit THAT FILE ONLY in the meta
checkout: `git add <learnings-file> && git commit -m "chore(learnings):
harvest from <card-short>"`, and push if the current branch is one meta
may push to (follow the host repo's convention; otherwise leave the
commit local, note it in chat, and fold it into the next PR or a
dedicated learnings PR — do not let it sit). Memory that stays uncommitted is
host-local and dies with the machine — the commit is what makes it
project memory. Never bundle other dirty files into this commit.

**Do not** remove the worktree. It stays for human inspection / re-iteration.

---

## Research cards

A card whose title contains `research.marker` (default `[research]`) is a
research card: the deliverable is a markdown report, not code. It runs the
four phases with these deltas only — everything else is unchanged.

- **Phase 1 (Prepare).** Parse `[meta] RESEARCH PLAN` (not `[meta] PLAN`);
  `## Metrics` is still required (same parser). The worktree is created
  from **`research.target_repo`** (default `.`, the meta repo — that is
  where `research.doc_dir` lives), NOT the code repo: run the
  `git fetch` / `git worktree add` from that repo's root, and place the
  worktree under that repo's `.gilb/worktrees/`. Branch/slug scheme is
  unchanged.
- **Phase 2.1 (Worker).** Build the worker prompt from
  `roles/versatile.md` + `roles/formatting.md` +
  `.claude/prompts/worker-research.md` (NOT `engineering.md` /
  `worker-iter1.md` / `worker-iterN.md`). Substitute `<iter>`, `<pr_url>`,
  `<gaps-list>`, `<RESEARCH-PLAN-comment>`, `<doc_dir>`. The same
  `worker-research.md` body is used for every iteration.
- **Phase 2.3 (Acceptance).** Same spawn, but the acceptance subagent
  follows the "Research mode" checklist in `acceptance-check.md`
  (doc-only diff, deliverable exists, question answered, sources cited).
  No `cargo` commands.
- **Phase 3 (Decision).** Research cards **never auto-merge**
  (`research.route` = `review`). When Phase 2 ends in acceptance, skip the
  auto-merge checks and move the card straight to `Review` with:
  ```
  [meta] READY FOR REVIEW — research deliverable

  Report: <doc path> (PR: <pr_url>)
  Conclusion: <one line from the PR body>
  Iterations: <iter> / 3

  Research is never auto-merged — please read the report and merge.
  ```
  Append session-log: `<ts> <card-short> REVIEW | research: <doc path>`.
  The `Blocked` / max-iter paths are unchanged.

Research's meta-repo worktree is just the `targets.meta` case of the general
execution-target mechanism (Bootstrap step 2 + "Per card" target resolution):
`research.target_repo` `"."` ≡ `targets.meta.repo_root`, `toolchain: docs`. The
broader multi-board vision (several boards → repos) is
deliberately deferred until a second board exists.

## Failure modes

| Situation | Action |
|---|---|
| `gh` not authenticated | Stop. Already-processed cards keep their status. |
| Research card: worker changed non-doc files | Acceptance gap (R1) → iteration; do not merge code from a research card. |
| Worktree path occupied by remnants | Blocked: "worktree exists, manual cleanup". Do not delete. |
| Worker needs env vars (secrets) not in worktree env | Blocked. Don't forward secrets yourself. |
| `repo:<name>` label names a target absent from `targets` | Blocked: `Unknown execution target '<name>'`. Add it to `tracker.json` or fix the label. |
| Rails preflight (`bundle install` / `bin/rails db:test:prepare`) fails | Blocked: `Rails preflight failed: <cmd>`. Do not spawn the worker; the toolchain/DB isn't ready on this host. |
| PR conflicts with main by acceptance time | Gap: "PR has merge conflicts with main. Rebase needed." → iteration. |
| Worker iter N opened NEW PR instead of pushing existing | Blocked: explicit message. |
| Tracker (MCP/CLI) fails mid-card | Stop. Card stays in current state. |
| Worker result JSON missing / empty / unparseable | Blocked: crash path per Step 2.2. Point to the stderr log. |
| `jq` not installed | Stop at bootstrap. It is required to parse worker result envelopes and by the guardrail hooks. |
| Kit hooks missing from `<meta-project>/.claude/hooks/` | Proceed without guardrails; note once in chat. Acceptance still enforces scope post-hoc. |
| `--resume <session_id>` fails (session expired / missing) | Retry the same spawn once WITHOUT `--resume` (fresh session); do not count the failed spawn as an iteration. |
| Auto-merge succeeds but card move to Done fails | Comment in card that merge happened; chat error. Manual card move. |
| `gh pr merge` fails (branch protection, conflicts) | Treat as auto-merge blocker; move to Review with `gh` error in comment. |
| Worker prompt template file (`worker-iter1.md`, `worker-iterN.md`) missing | Stop. Don't inline a fallback. |
| Role prompt file missing (`roles/engineering.md` or `roles/formatting.md` for worker; `roles/versatile.md` or `roles/formatting.md` for acceptance) | Stop with `Role prompt file missing: <path>`. Don't inline a fallback. |
| `acceptance-check.md` missing | Stop. Don't skip acceptance. |
| `.claude/bin/` script missing or not executable | Stop at bootstrap: `Re-run bin/workflow-kit-sync.` Don't hand-parse verdicts as a fallback. |
| `<card-ref>` not in `Ready for AI` | Exit early per Invocation rules; no state change. |
| `<card-ref>` resolves to no card on the board | Exit with `Card <ref> not found on board.` |
| `--parallel N` with `N` outside `[1, 4]` or non-integer | Exit with `Invalid --parallel value: <raw>. Expected integer in [1, 4].` |
| `--parallel N` set but only one card in targets | Treat as `N=1`; no warning needed. |
| Parallel run, one card hits `Blocked` | Other in-flight cards continue. Pending queue continues to drain. |
| `--resume` but card not in `In Progress`, or no state file | Exit with `Nothing to resume for <ref>: <why>.` No state change. |
| `--resume` and the state file is not valid JSON (torn write) | Exit: `State file unreadable — inspect manually.` No state change. |
| `--resume` and worktree/branch from the state file are gone | Blocked: `Resume failed`. Manual cleanup; do not recreate silently. |
| `--resume` a card whose original meta session is still alive | Undetectable by meta — the human must ensure the old run is dead first (two metas double-drive the card: duplicate spawns, duplicate comments). |
| State says `done` but the card is still in `In Progress` | The final state move failed after the terminal decision. Report the last iter_log outcome; the human finishes the move. |
| State-file write fails (disk, permissions) | Continue the iteration normally; note once in chat. Resume just won't be available for this card. |
