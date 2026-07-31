---
description: Triage Backlog → Plan Proposed or Human Questions; execute confirmed splits
allowed-tools: Read, Glob, Grep, WebFetch, Edit(.gilb/**), Write(.gilb/**), Bash(date:*), Bash(gh:*), mcp__trello
---

# /flow-check

Role: **triage meta-agent**. Invoked manually by the user.

This file is the orchestrator. The actual decision logic for a single card
lives in `.claude/prompts/card-eval.md`. The PLAN format lives in
`.claude/prompts/plan-format.md`.

## Contract (what you must NOT do)

- Do NOT spawn workers (that is `/flow-run`).
- Do NOT write code in the repo. No commits. No PRs.
- Do NOT move cards into `Ready for AI` — only the user does that.
- Do NOT comment on cards without the `[meta] ` prefix.
- Do NOT use the `Agent` tool — sequential triage.
- Do NOT create or archive cards EXCEPT: Phase 1 (split execution) when
  the user has explicitly confirmed a split, and Phase 3b (auto-create at
  most one epic tracker per run from a shared-parent cluster).

## Sources of truth

- `.claude/tracker.json` — board, list IDs, conventions, `labels.ai_generated`,
  `split_confirmation_phrase`.
- `.claude/prompts/card-eval.md` — per-card triage decision procedure.
- `.claude/prompts/plan-format.md` — PLAN comment canonical format.
- `flow-workflow.md` — optional project-owned workflow doc; absent
  by default (the kit commands are self-contained without it).
- the session log (path: `session_log` in `tracker.json`, default `.gilb/session-log.md`) — recent automation history.
- Project learnings file — `tracker.json` `learnings` (default
  `.claude/learnings.jsonl`); card-eval.md step B reads it per card.
- `CLAUDE.md`, `spec.md`, `tauri-plan.md`, `research/*.md` — project context.

## Algorithm

### Bootstrap (once)

1. Read `.claude/tracker.json` → get `tracker.provider` (and read
   `.claude/providers/<provider>.md` — it defines every tracker
   operation below), the board/repo block, `states.*`, `labels.ai_generated`,
   `split_confirmation_phrase`, `session_log` path, and the `epic` block
   (`marker`, `label_prefix`, `auto_refresh_checklist`, `auto_create_min_cluster`).
2. Read the last 30 lines of the session log (skip header) — recent
   activity context.
3. Via the tracker (`list_items`), fetch open cards from **all
   pipeline states except `icebox`** with at least
   `{id, title, short ref, state, labels}` — board snapshot for
   cross-card awareness. `Icebox` holds raw, unrefined ideas the user is
   not ready to develop; it is never triaged and never contributes
   cross-card context.

### Phase 1: Split execution

Process cards in `Human Questions` looking for confirmed splits.

For each card in `Human Questions`:
- Fetch its full comments (`read_item`).
- Look for the LATEST `[meta] TOO BIG — proposed split` comment (skip if
  none).
- Look for a SUBSEQUENT human comment (no `[meta]`/`[worker]` prefix)
  containing `split_confirmation_phrase` (case-insensitive, e.g.
  `split confirmed`). Skip card if no confirmation found.
- Skip if there's already a `[meta] SPLIT EXECUTED` comment (idempotency).

When confirmation found:
- Parse the numbered sub-task list from the TOO BIG comment. Each item:
  `**<sub-task title>** — <one-line scope>`.
- For each sub-task, create a new card (`create_item`):
  - state: `backlog`
  - title: the sub-task title (without `**` markdown)
  - description: the sub-task scope + a footer line
    `Split from: <original-card-url>`
  - labels: `[labels.ai_generated]`
- On providers WITHOUT `native_ids` (provider doc → Capabilities):
  immediately `update_title` each new card to add the
  `[<card_prefix>-<N>]` prefix (e.g. `[ACME-23]`, `<N>` from the create
  response) so human-created and AI-generated cards share one numbering
  scheme. Providers with native ids skip this — titles stay clean.
- Post a `[meta] SPLIT EXECUTED` comment on the original card with links to
  all new cards (use their short refs for readability).
- Archive the original card (`archive_item`, reason: split executed).
- Append to session-log: `<ts> <card> SPLIT-EXECUTED | created N sub-cards: <comma-list of [ACME-N] ids>`.

Cap: if a card's TOO BIG proposal has more than 5 sub-tasks, abort (post
`[meta] Refusing to split — more than 5 sub-tasks. Manual cleanup needed.`)
and skip.

### Phase 2: Backlog triage

Identify cards in `Backlog`. If none → reply "Backlog empty (split phase
processed N cards)" and exit.

For each Backlog card **sequentially**:

0. **Skip epic trackers.** If the card's title contains `epic.marker`
   (default `[epic]`, case-insensitive), skip it entirely — do not
   normalize, lock, triage, or move it. Epic cards are living overviews,
   not work items. Leave them where
   they are.
1. **Normalize title.** If the card's title doesn't start with
   `[<card_prefix>-<N>]` (e.g. `[ACME-42]`), rename it to add the
   prefix. Use the card's native id (`<N>`) from the card data.
   Cards created via the tracker UI without the prefix get normalized
   here (providers with `native_ids` skip title prefixes entirely — see
   the provider doc's Capabilities).
2. Move card to `Triage in progress` (lock).
3. Apply the procedure in `.claude/prompts/card-eval.md`. It returns:
   - `outcome` ∈ {`PLAN`, `RESEARCH PLAN`, `QUESTIONS`, `SPLIT`}
     (`RESEARCH PLAN` only for `[research]`-marked cards — see card-eval
     step A2 / F4)
   - `comment_body` (already formatted, including `[meta] ` prefix)
   - `assumed[]` (only for `PLAN` taken via the auto-answer fast-path per
     card-eval.md step F): an ordered list of `[meta] ASSUMED` comment
     bodies, one per auto-answered gap. Empty for plain `PLAN`.
   - For `PLAN`: parsed metrics (confidence, value, risk, expected_iters, size)
3. Post `comment_body` on the card via MCP. If the outcome carries
   auto-answers (PLAN with one or more `[meta] ASSUMED` comments per
   `card-eval.md` step F), post those ASSUMED comments FIRST, then the
   PLAN, so the chronological view reads top-down.
4. Move the card to the target column:
   - `PLAN` → `Plan Proposed`
   - `RESEARCH PLAN` → `Plan Proposed`
   - `QUESTIONS` → `Human Questions`
   - `SPLIT` → `Human Questions`
5. Append to the session log:
   ```
   <ISO UTC timestamp>  <card-short>  <EVENT>  | <summary>
   ```
   Where EVENT and summary by outcome:
   - PLAN: `TRIAGED→PLAN | conf=<N> risk=<low|med|high> size=<S|M|L>: <terse description>`
     Append ` [assumed=<N>: <categories>]` when one or more gaps were
     auto-answered, e.g. `... size=S: feature flag default for X [assumed=2: Where, Verify]`.
   - RESEARCH PLAN: `TRIAGED→RESEARCH | conf=<N>: <question in brief>`
   - QUESTIONS: `TRIAGED→QUESTIONS | <gap categories, e.g. "What, Scope">`
   - SPLIT: `TRIAGED→SPLIT | <N> proposed sub-cards`

### Phase 3: Epic maintenance

Epics are tracker cards (title contains `epic.marker`, default `[epic]`)
that group member cards via an `<epic.label_prefix><name>` label (e.g.
`epic:meeting-detection`). They are never triaged or executed.
This phase keeps them current.

**3a. Refresh checklists** (when `epic.auto_refresh_checklist` is true).
For each `[epic]` card on the board:
- Find its epic label (the `<label_prefix><name>` label on the card).
- Collect all cards carrying that label (the members), with their list.
- Rewrite the card's `Children` checklist: one item per member, text
  `<status-glyph> [<prefix>-<id>] <short title> — <column>` where the
  glyph is checked/`✅` for `Done` and unchecked otherwise. Add members
  missing from the checklist; mark the checklist item complete iff the
  member is in `Done`. Do not delete the card or change its description.

**3b. Auto-create epics** (when `epic.auto_create_min_cluster` ≥ 1).
Detect clusters of **live** cards (not archived, not already epic-labelled)
that share the same `Split from: <url>` parent. If a cluster has
≥ `auto_create_min_cluster` members and no epic already covers them:
- Create label `<label_prefix><name>` (derive `<name>` from the shared
  theme; kebab-case) if absent.
- Create an `[epic] <Name>` tracker card in `Backlog` (no `[<prefix>-N]`
  numbering — epics stay outside it), apply the epic label, and build the
  `Children` checklist from the cluster.
- Apply the epic label to each member card.
- **Seed the completion-review card.** Create a `Backlog` card named
  `Review completed <Name> epic (whole-epic code review + refactoring proposals)`,
  apply `[labels.ai_generated, <the epic label>]`, and — unlike the
  tracker — give it the normal `[<card_prefix>-<N>]` prefix (it is a
  member work card, not the tracker). Its `desc` states the review scope
  (cross-cutting duplication, leaky abstractions, naming/contract drift
  between member PRs, deferred out-of-scope items to consolidate) and that
  it runs **only once every other member is `Done`**. Add it to the epic's
  `Children` checklist like any member.
- Post nothing on member cards; append session-log
  `<ts> EPIC-CREATED | <label> (<N> members, +review card [<prefix>-N])`.
Cap: create at most ONE epic per `/flow-check` run; if multiple clusters
qualify, pick the largest and report the rest in chat. This is the only
path where AI creates a non-split card — keep it conservative; when in
doubt, suggest in chat instead of creating.

### Summary

After all phases:
```
Triage complete:
- Splits executed: <count>
- Backlog processed: <N>
  - → Plan Proposed: <M> (code <…> / research <…>)
  - → Human Questions: <K>
  - → SPLIT proposed: <S>
- Epics: refreshed <R>, created <E>
```

## Failure modes

| Situation | Action |
|---|---|
| Tracker (MCP/CLI) not responding | Stop. Error to chat. Don't fall back to raw REST/curl. |
| `.claude/tracker.json` malformed | Stop. Don't guess fields. |
| the session log missing | Create it (touch + header from existing template); proceed. |
| `card-eval.md` not readable | Stop. Don't inline the procedure. |
| Card creation fails (network, permission) | Stop. Card stays in its current state. Report. |
| Trying to archive original after sub-cards created but archive fails | Sub-cards exist; manual cleanup. Comment in original card noting the partial state. |
