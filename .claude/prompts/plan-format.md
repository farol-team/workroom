# PLAN format (canonical)

Single source of truth for what a `[meta] PLAN` comment must look like in a
tracker card. Read by `/flow-check` (writes it) and `/flow-run` (parses
it). When you change this file, both commands pick up the new format on
their next run — no other updates needed.

## Format

The first line of the comment is always exactly `[meta] PLAN`. An optional
`Base:` line may immediately follow it to override the branch the work is cut
from and the PR targets (default `main`); use it for epic-integration cards
that must land on an epic branch, not `main`. Then the sections below appear in
this order:

```
[meta] PLAN
Base: epic-v2

## Scope
<what is included — concrete and measurable, 1-3 sentences. Frame as goals:
measurable outcomes, not implementation details.>

## Files
- `path/to/file.rs` — what changes (one line per file)
- `path/to/other.rs` (new) — what is created
  Interface: consumes `<fn/type signatures it calls>`; exposes `<exact
  signatures it provides>` (required for `(new)` files on M/L cards —
  workers inventing interfaces is a top rework cause)
- `path/to/third.rs` — what changes
- `spec/path/to/file_spec.rb` (new) — specs proving the change (code cards
  MUST list at least one test/spec path — Article I)

## Approach
<3-5 sentences: key decisions, ordering, non-obvious nuances.
Explain HOW, not a restatement of Scope.>

## Tests
List the commands that prove the change, then the **mandatory test + lint/
format gates for the card's toolchain**. The toolchain and its gate commands
come from the card's execution target in `tracker.json` (`targets[<name>]`,
resolved by the card's `repo:<name>` label; otherwise `default_target`):
author the gates from that target's **`test_cmd`** and **`lint_cmd`**
templates, filling in the touched path/crate. Use the gates for that one
target only.

Each PLAN's `## Tests` must include:
- the test command(s) that cover the change — the target's `test_cmd` applied
  to the touched path/crate/filter (plus what each covers);
- the target's `lint_cmd` (lint + format gate) scoped to the touched paths;
- any setup the gate needs (e.g. a DB prepare step before tests), if the
  project's `project-context.md` calls for it;
- a `<manual step, if needed>` — what and how to verify.

Examples by toolchain (the actual command comes from the target's
`test_cmd`/`lint_cmd`, not hardcoded here):
- **rust** — test `cargo test -p <crate> <filter>`; lint `cargo clippy -p <crate> --all-targets` + `cargo fmt -p <crate> -- --check` (one per crate in `## Files`).
- **rails** — test `bin/rails test <path>` or `bundle exec rspec <path>`; lint `bin/rubocop <path>`.
- **node** — test `pnpm test <path>` / `npm test`; lint the project's eslint/prettier gate.
- **docs** — no code gates.

**Scoping rule.** Scope every gate to what the card touches — a single
crate/package/path, not the whole project. Use project-wide forms only when
the card deliberately covers the whole project (`## Files` spanning three or
more packages, or an explicit project-wide cleanup). The scoped form prevents
pre-existing drift in untouched areas from blocking this card's gates.

## Out of scope
<the non-goals — what is NOT done in this card; an explicit boundary so the
worker doesn't drift and scope stays cut to one PR>

## Metrics
- Confidence: <0-10> — how sure the plan reaches merge without rework
  Why: <one line justification>
- Value: <low|medium|high> — impact on project
  Why: <one line>
- Risk: <low|medium|high> — chance things go off-plan
  Why: <one line>
- Expected iterations: <1|2|3> — your estimate of worker passes needed
- Estimated size: <S|M|L>. S = <300 LOC, M = 300-800, L = 800-1500.
  If L → reconsider SPLIT. LOC means AUTHORED lines: a pure move counts
  what it writes (facade lines, wiring), not what it relocates — sizing
  relocation as authorship is what sent two move-only cards into a TDD
  gate with no red to write (agent-flow#12).

## Constitution gate
One line per article from `.claude/constitution.md` that applies to this
card's execution target: the universal articles + `## Project articles
(<target>)` for the card's target (per the `repo:` label /
`default_target`) + any `## Project articles (all targets)` section. A
single unnamed `## Project articles` section applies to every target.
Other targets' sections are OMITTED entirely — do not list them as n/a.
Verdict per article: `pass` / `n/a` / `violates — <explicit
justification>`. Examples:
- I Test-First: pass — specs in ## Files, written before impl
- P3 Queue isolation: pass — new job declared `queue_as :low`
- P2 Incremental: n/a — no recurring jobs touched
A `violates` without a justification the human can approve = the plan
fails self-check. This section is for the worker and the acceptance check
(which re-verifies the DIFF against the same articles); /flow-run does
not parse it.

## Behavior (optional — M/L cards)
<present-tense, end-to-end description of how the change behaves: happy path
plus the edge cases that matter. Explain as if to a new team member. Skip for
small single-file cards where ## Approach already says everything.
WHAT only — user-observable behavior, no tech stack, file paths, or API
names here (those live in ## Files / ## Approach). Spec-kit rule: Behavior
stays stable when the implementation changes.>

## Acceptance criteria (optional — M/L cards)
<testable Given/When/Then statements that define "done" beyond the raw
## Tests commands — include positive AND negative cases. Each should map to a
check a reviewer can run.>
- Given <state>, when <action>, then <observable result>.

## Cross-card notes
<optional: only if the triage step found something relevant>
- Related to card <url>: <how>
- Depends on <card url>: <how>
- Duplicates <card url>: <how>
```

The three sections above (`## Behavior`, `## Acceptance criteria`,
`## Cross-card notes`) are OPTIONAL and for human readers only — `/flow-run`
does not parse them. `## Behavior` and `## Acceptance criteria` are borrowed
from the design-doc template for larger (M/L) cards, where an end-to-end
narrative and explicit done-conditions prevent drift; omit them on small (S)
cards, where `## Scope` + `## Approach` + `## Tests` already suffice.

## Self-check before publishing

Walk this checklist; if any item fails — rework or downgrade to QUESTIONS
(see `card-eval.md`).

- [ ] Every file in `## Files` actually exists in the repo today, or is
      marked `(new)`.
- [ ] Every command in `## Tests` will actually run (correct crate name,
      test filter resolves).
- [ ] `## Tests` includes the target's mandatory gates — its `test_cmd` for
      the touched path + its `lint_cmd` (lint+format) — from `tracker.json`.
      (Docs/research cards have no gates.)
- [ ] Those gates are scoped to what `## Files` touches (a single
      crate/package/path), not project-wide, unless the card is a deliberate
      whole-project cleanup.
- [ ] `## Scope` and `## Out of scope` together cover anything a reader
      might wonder about.
- [ ] `## Approach` explains HOW; it does not repeat `## Scope` content.
- [ ] For an M/L card, `## Behavior` and `## Acceptance criteria` are present
      (both optional on S cards).
- [ ] The plan leaves NO decisions to the worker — every choice that
      affects implementation is already made.
- [ ] **Zero unresolved markers.** Anywhere you were tempted to guess, you
      either resolved it or wrote `[NEEDS CLARIFICATION: <question>]` — and
      a plan containing ANY such marker does not ship: resolve it via the
      auto-answer policy (→ `[meta] ASSUMED`) or downgrade to QUESTIONS.
- [ ] **No placeholders.** The plan contains no "TBD", "appropriate error
      handling", "similar to <other task>", "etc." in place of a decision.
      Every step names actual files, commands, and expected outcomes.
- [ ] `## Constitution gate` is present with a verdict for EVERY article in
      `.claude/constitution.md`; any `violates` carries a justification.
- [ ] `## Files` lists at least one test/spec path (Article I). `(new)`
      files on M/L cards carry an Interface line.
- [ ] **Confidence ≥ 7.** If lower, the plan is not ready — produce
      QUESTIONS instead, asking what would raise confidence.

## RESEARCH PLAN format (research cards)

For cards marked `[research]` (see `card-eval.md` step A2), `/flow-check`
writes a `[meta] RESEARCH PLAN` instead of a code `[meta] PLAN`. The
deliverable is a doc, not code. First line is exactly `[meta] RESEARCH
PLAN`, then:

```
[meta] RESEARCH PLAN

## Question
<the concrete question(s) the research must answer — 1-3 bullets>

## Investigation
<where to look and how: repos / files / docs to read, external sources to
search (name specific projects, vendors, tools), and the angle. 3-6 items.>

## Deliverable
- `research/NN-<slug>.md` (new), in <target repo, default the meta repo> —
  the report. List the sections it must contain (e.g. Findings, Options
  with trade-offs, Recommendation, Open questions).
- A one-paragraph conclusion summary (posted by the worker in the PR body
  and surfaced by meta as a `[meta]` comment).

## Out of scope
<explicit boundary — MUST include "No production code; doc-only.">

## Metrics
- Confidence: <0-10> — that the investigation can answer the Question
  Why: <one line>
- Value: <low|medium|high> — impact of the answer on the project
  Why: <one line>
- Risk: <low|medium|high> — chance the question can't be answered as scoped
  Why: <one line>
- Expected iterations: <1|2|3>
- Estimated size: <S|M|L> — depth of the report (S = <300 lines, M =
  300-800, L = 800+; if L, reconsider SPLIT into separate questions)

## Cross-card notes
<optional, same as code PLAN>
```

`## Metrics` uses the SAME field names as a code PLAN, so `/flow-run`
parses metrics identically. The other section headers differ
(`## Question` / `## Investigation` / `## Deliverable` replace `## Scope`
/ `## Files` / `## Approach` / `## Tests`). Research cards never
auto-merge — they always route to `Review` (see `flow-run.md` →
"Research cards").

## Parsing contract (for /flow-run)

An optional `Base:` line directly under the `[meta] PLAN` first line names the
base branch (`^Base:\s*(\S+)$`); when absent the base is `main`. `/flow-run`
uses it for the worktree checkout, the PR base, and the acceptance diff.

`/flow-run` parses these exact section headers (`## Scope`, `## Files`,
`## Approach`, `## Tests`, `## Out of scope`, `## Metrics`). If a card has
a `[meta] PLAN` comment that lacks `## Metrics` or has unparseable values
(non-numeric Confidence, unknown Risk), the card goes to `Blocked` with a
note pointing here.

For `## Metrics`, the parser expects these exact field names (case-sensitive):
- `Confidence:` integer 0-10
- `Value:` one of `low`, `medium`, `high`
- `Risk:` one of `low`, `medium`, `high`
- `Expected iterations:` integer 1-3
- `Estimated size:` one of `S`, `M`, `L`

`## Behavior`, `## Acceptance criteria`, and `## Cross-card notes` are optional
and not parsed; they're for human readers (used on larger M/L cards).

A `[meta] RESEARCH PLAN` is recognized by its first line. For it, only
`## Metrics` is parsed (same field rules above); the code-PLAN headers
(`## Files` / `## Tests`) are absent by design and their absence is NOT a
Blocked condition for a RESEARCH PLAN.
