# Card evaluation procedure

Sub-prompt called by `/flow-check` for each card it triages. Given one
card, produce one of three outcomes: **PLAN**, **QUESTIONS**, or **SPLIT
proposal**. The orchestrator (flow-check.md) handles column moves and
session-log writes; this file is the decision logic.

## Input

When this procedure starts:
- The card has just been moved to `Triage in progress` (lock against double
  processing).
- You have the board snapshot from the orchestrator's bootstrap (all cards
  in all columns except `Icebox`, which is excluded as raw ideas) and
  recent `.gilb/session-log.md` entries.
- You have the card itself (id, name, desc, comments, attachments, labels).

## Steps

### A. Read the card

- `name` and `desc` fields.
- All `comments` — anything without `[meta]`/`[worker]` prefix is human input.
- All `attachments` — if they link to repo files or external resources,
  open or fetch them.
- `labels`, `due`, `members` — side context.

### A2. Research-card detection (special type)

A card is a **research card** if its title contains the
`research.marker` from `.claude/tracker.json` (default `[research]`,
case-insensitive), independent of the `[<card_prefix>-N]` prefix —
e.g. `[ACME-32] [research] Competitor pricing pages — extraction approach`.

Research cards produce **knowledge, not code**: the deliverable is a
markdown report under `research.doc_dir` (default `research/`) in
`research.target_repo` (default `.`, the meta repo — that's where the
existing `research/NN-*.md` docs live), plus a short summary comment.
No production code is written.

If the card is research:
- Skip the code-oriented parts of step B (no crate/`Cargo.toml` dig);
  instead verify the research *question* is answerable and note which
  repos/docs/external sources are relevant.
- In step D, the gaps that matter are **What** (is the question
  concrete?), **Why** (decision it informs), **Scope** (boundary of the
  investigation), and **Dependencies**. There is no "Size→SPLIT by
  files"; split only if the question is really several independent
  investigations.
- The outcome is **F4 RESEARCH PLAN** (not F3 PLAN) when clear, or F2
  QUESTIONS when the question is too vague to investigate.

A card that is clearly research but NOT marked → F2 QUESTIONS asking the
human to add the `[research]` marker (so it routes correctly), rather
than silently planning code.

### A3. Execution-target detection (which repo + toolchain)

A card's **execution target** decides which repo the work lands in and which
build toolchain its `## Tests` gates use. Resolve it from `.claude/tracker.json`:

- If the card carries a `<repo_label_prefix><name>` label (default prefix
  `repo:`, e.g. `repo:gilb-web`) → target = `targets[name]`.
- Else → `default_target` (`gilb-recorder`, toolchain `rust`).
- A research card (A2) is doc-only and targets the meta repo
  (`targets.meta`, toolchain `docs`) regardless of any `repo:` label.

The target's `toolchain` (`rust` | `rails` | `docs`) is **NOT a gap and never a
reason for QUESTIONS**: a `rails` card (e.g. gilb-web) is a first-class code
PLAN — it simply authors Rails gates (`bin/rubocop` + `bin/rails test`) instead
of cargo (see `plan-format.md`). The only target-related QUESTIONS are genuine
gaps: e.g. a `repo:<name>` whose `name` is absent from `targets`, or a card that
clearly spans two target repos at once (ask the human to split by repo).

### B. Gather repo context

Before deciding, read `.claude/constitution.md` — the non-negotiable
articles every code PLAN must gate against (step F3 requires a
`## Constitution gate` verdict per article). The applicable articles are
the universal ones + the project section matching the card's execution
target from A3 (`## Project articles (<target>)`) + any `(all targets)`
section; a single unnamed `## Project articles` section applies to every
target. If the card as written cannot satisfy an applicable article (e.g.
it asks for a full-table scan in a recurring job, or an outbound write to
a banned external API), that is a **QUESTIONS gap**, not something to
plan around silently.

Then verify the relevant slice of the **target repo** (from A3 —
the `default_target` unless a `repo:` label points elsewhere):

- If the card mentions filenames / modules / functions — open them with
  Read; confirm they exist now (not just in plans or your memory).
- If the task is architectural — check the project's planning/architecture
  docs (the paths in `tracker.json` → `project_context_docs`, plus
  `.claude/project-context.md`) for existing decisions on the topic.
- Glance at the target's layout and manifest for the toolchain — Rust:
  the crate's `Cargo.toml` + `src/`; Rails: `config/routes.rb`,
  `app/`, `Gemfile`, `spec/`|`test/`; Node: `package.json` + the package
  dir; etc. Confirm the test/lint commands match the target's
  `test_cmd` / `lint_cmd` in `tracker.json`.
- If the card references a milestone/phase named in the project's planning
  docs — find it and understand its pre-conditions.
- If the task touches the frontend AND the project provides an optional
  UI guide at `.claude/prompts/ui-design.md` — read it BEFORE writing the
  PLAN and cite it in the PLAN's `## Approach`.
- Read the project learnings file (`tracker.json` `learnings`, default
  `.claude/learnings.jsonl`; skip silently if missing). Filter to entries
  whose `files[]` overlap the card's likely scope or whose `key` matches
  the card's topic. Let matching `pitfall` entries inform `## Tests` /
  `## Out of scope` and the Risk metric; let `pattern`/`architecture`
  entries inform `## Approach` — and cite applied keys there
  (`per learning <key>: …`). A high-confidence pitfall the card would
  re-trigger is a legitimate reason to lower Confidence or raise a
  QUESTIONS gap.

Stop when you've verified:
- Files you'll reference in the plan exist (or are explicitly new).
- Features you'll treat as "done" really are done.
- Decisions you'll treat as "made" are documented in the project's planning
  docs / commit history.

Do not go infinitely deep. Enough context to make a confident plan, not
exhaustive.

### C. Cross-card scan

Using the board snapshot from the orchestrator's bootstrap + recent
session-log entries:

- Is there a card in `Plan Proposed` / `Ready for AI` / `In Progress` /
  `Review` that overlaps with this one (same files, same feature, same
  module)? If yes → flag as dependency or duplicate (see Edge cases below).
- Was a related card recently in `Done` (per session-log)? Its outcome
  might inform the plan (e.g., a constraint surfaced during execution).
- Same author / label cluster active right now?

One mental scan, not a deep dive. Only fetch full content of another card
if a strong overlap suspicion arises.

### D. Gap analysis

Walk each category. Each is a potential QUESTION if no sensible default
exists.

| # | Category | What to check | Default OK when | Ask when |
|---|---|---|---|---|
| 1 | **What** | What behavior changes/is added? | title + desc describe one concrete observable change. | "Improve X", "Refactor Y" without a "better means what" criterion. |
| 2 | **Where** | Which files/crates/layers? | obvious from context. | Multiple candidate sites; selection needed. |
| 3 | **Why** | What user/system impact? | obvious from desc or general project context. | Unclear — risk of solving the wrong problem. |
| 4 | **Verify** | How will we know it's done? | a concrete `cargo test` / observable check can be written. | only "test manually" with no scenario described. |
| 5 | **Scope boundary** | What is NOT in scope? | task is atomic; nothing to cut. | wording is broad ("Add Windows support") and hides sub-tasks. |
| 6 | **Dependencies** | Depends on other in-flight work? | no cross-card deps (per step C), or deps already merged. | depends on something open — order it first. |
| 7 | **Edge cases** | Obvious branches (empty, error, permission denied) addressed? | simple logic with no significant branching. | complex flow without error-path notes. |
| 8 | **Size** | Fits in one PR? | 3-7 files, localized feature. | broad scope, "half the system" (see SPLIT signs below). |

**Rule of thumb:** ask only when the answer actually changes the plan. If a
default is reasonable, describe it in the PLAN (e.g., "Buffer size: 4096,
matches ACTION_CHANNEL_CAPACITY") and don't ask.

### E. Detect SPLIT

If the task is too big for one PR, you produce a split proposal instead of
a plan. Signs of "too big":
- Plan would touch >5 distinct top-level directories.
- Naturally divides into independently testable stages.
- desc already contains a numbered list of 3+ significant steps.
- Touches multiple phases from `tauri-plan.md`.
- Your would-be Confidence in a single PLAN would be < 7 purely because of
  scope (not unknowns).

### F. Decide outcome

If this is a **research card** (step A2): the outcome is **F4 RESEARCH
PLAN** when the question is clear, or **F2 QUESTIONS** when it is too
vague — skip F1/F3 (no code split, no code PLAN).

Otherwise, first check SPLIT (F1). Then walk the gaps from step D:

- **No gaps** → take F3 PLAN.
- **Some gaps, but every one is auto-answerable** per the policy below → take
  F3 PLAN, prefacing it with one `[meta] ASSUMED` comment per gap so the
  audit trail records each guess.
- **Any gap is NOT auto-answerable** → take F2 QUESTIONS for all gaps (don't
  mix; partial auto-answers fragment the audit and the human has to read both
  branches).

#### Auto-answer policy

Apply ALL four conditions per gap. If any fails, the gap is not
auto-answerable and the whole card goes F2 QUESTIONS.

1. **Category is on the safe list.** Auto-answerable: `Where`, `Verify`,
   `Edge`, `Scope` (boundary, i.e. what's NOT in scope; not "Scope is too
   broad — split it"). Not auto-answerable: `What` (epic-shaping product
   call), `Why` (motivation/incident), `Dependencies` (cross-card
   coordination), `Size` when it implies SPLIT.
2. **Personal confidence on the answer is ≥ 8/10** AND the resulting PLAN's
   overall Confidence stays ≥ 7. If guessing forces overall confidence to 7
   only by stretching, drop to QUESTIONS — the threshold is "I'd defend this
   in code review", not "it's probably fine".
3. **The guess is reversible in one follow-up PR.** Reversible: a file-path
   choice, a test-command shape, a default value, a state-machine variant
   name. NOT reversible without serious churn: a schema/migration shape, a
   public API contract (trait signature, wire format), a dependency or
   crate choice that pulls in transitive deps, a UI palette / typography
   pick. Use the rule "if I'm wrong, can a follow-up PR fix it without a
   migration?" — if no, that's an F2 question.
4. **Cap: ≤2 auto-answers per card.** Three or more guesses on one card is
   substantial accumulated uncertainty; route to F2 QUESTIONS instead so
   the human weighs in once before all the choices compound.

#### Outcomes

**F1. SPLIT** — too big for one card.

Comment in card (orchestrator moves to `Human Questions`):

```
[meta] TOO BIG — proposed split

This task is larger than one PR. I suggest splitting it into:

1. **<sub-task 1 title>** — <one-line scope>
2. **<sub-task 2 title>** — <one-line scope>
3. **<sub-task 3 title>** — <one-line scope>

To confirm: comment the exact phrase `split confirmed` (case-insensitive)
on this card. On the next /flow-check I will create the sub-cards in
Backlog (labeled `ai-generated`) and archive this one.

To reject: refine the scope in a comment so it fits one PR, then move
back to Backlog.
```

Do not create or archive cards yourself in this step. The split-execution
phase of `/flow-check` handles that when it sees the confirmation
phrase.

**F2. QUESTIONS** — at least one gap is not auto-answerable.

Comment in card (orchestrator moves to `Human Questions`):

```
[meta] QUESTIONS

1. **<category>** — <concrete question with proof from file/code/spec>
   Context: <1-2 lines on why this matters>

2. **<category>** — <…>

I cannot produce a plan without these answers — skipping this card.
```

Categories from step D table: `What`, `Where`, `Why`, `Verify`, `Scope`,
`Dependencies`, `Edge`, `Size`. Tag each question so the human grasps the
gap type quickly. Include every gap from this card here — don't mix with
auto-answers (see the rule at the top of step F).

**F3. PLAN** — everything clear, OR every gap was auto-answerable.

Produce a `[meta] PLAN` comment following the canonical format and
self-check in `plan-format.md`. The orchestrator moves the card to `Plan
Proposed`.

Non-negotiables when authoring the PLAN (all from `plan-format.md`
self-check — restated here because they are new and easy to skip):
- `## Constitution gate` with a verdict for every article of
  `.claude/constitution.md`; `violates` requires a human-approvable
  justification, else → F2 QUESTIONS.
- Zero `[NEEDS CLARIFICATION: …]` markers survive into the published
  PLAN — each becomes an `[meta] ASSUMED` (if auto-answerable) or an F2
  question.
- No placeholders ("TBD", "appropriate error handling", "similar to
  task N") — a placeholder is an unmade decision, and the plan must leave
  the worker none.
- `## Files` includes the test/spec paths (Article I: tests are planned
  work, not an afterthought).

If any gap was auto-answered, post one `[meta] ASSUMED` comment per gap
BEFORE the PLAN comment (so they appear above PLAN in the card's
chronological view):

```
[meta] ASSUMED (gap: <category>)

Answer: <one-line specific choice>
Reasoning: <one-to-two lines on why this default is safe — cite file paths or
research docs when relevant>
Override: comment with the alternative and move the card back to Backlog;
the next /flow-check will re-evaluate.
```

If self-check fails (especially overall Confidence < 7) → downgrade the
whole card to F2 QUESTIONS instead, including any gaps you'd planned to
auto-answer.

**F4. RESEARCH PLAN** — research card (see step A2), question is clear.

Produce a `[meta] RESEARCH PLAN` comment per the RESEARCH PLAN format in
`plan-format.md`. The orchestrator moves the card to `Plan Proposed`
(same gate as a code PLAN — the human approves by dragging to `Ready for
AI`). Key differences from F3: the deliverable is a doc, `## Out of
scope` MUST state "no production code", and on execution the card always
goes to `Review` (research is never auto-merged). If the question is too
vague to scope an investigation → F2 QUESTIONS instead.

## Edge cases

| Situation | Outcome |
|---|---|
| Card has only a title, no desc | F2 QUESTIONS: "Expand the task. Title is not enough." |
| Card references a non-existent file | F2 QUESTIONS: "File `X` does not exist on `main`. Did you mean another?" |
| Looks like a duplicate of an existing card (from step C) | F2 QUESTIONS: "Possible duplicate of `<url>`. Close this one or merge?" |
| Card overlaps a card in In Progress / Review | F2 QUESTIONS: "This overlaps `<url>` currently in <column>. Wait for that to merge, or coordinate?" |
| Refactoring with no user-visible change | F3 PLAN is fine, but Scope must explicitly say "no functional change". Tests: include commands that confirm existing behavior is preserved. |
| Move-only card (splits/relocations; plan says "no behavior change" and lists no new spec paths) | Size the Metrics by AUTHORED delta, not relocated lines, and say so in the size Why — a 900-line move with seven authored lines is S, and an S under the TDD-gate threshold spares phase A a red it cannot write. If the card stays gated (risk, or genuine new surface like an extraction's factories), the PLAN must name phase A's red explicitly: specs that import the not-yet-existing module and pin its behavior, red on `Cannot find module` (field-proven on workroom#279/#283; the ungated-size path on workroom#281). |
| Card is marked `[research]` (see step A2) | F4 RESEARCH PLAN (or F2 QUESTIONS if the question is too vague). Deliverable is a doc under `research/`, never code. |
| Card is clearly research/spike but NOT marked `[research]` | F2 QUESTIONS: "This looks like research, not code. Add the `[research]` marker to the title so it routes to a RESEARCH PLAN, or reformulate as 'on the basis of X — implement Y'." |
| Tracker (MCP/CLI) does not respond | Stop, error to chat. Do not use a raw REST fallback. |
| `.gilb/session-log.md` missing or unreadable | Create it (touch + header from existing template); proceed. Log the recovery action in chat. |

## Output

This procedure does not move the card or post comments by itself — the
orchestrator (`/flow-check`) does. It just produces:

- The outcome type: `PLAN`, `QUESTIONS`, or `SPLIT`.
- The comment body (formatted per F1/F2/F3 above).
- For PLAN: the parsed Metrics (confidence, value, risk, expected
  iterations, size) for the session-log summary line.
