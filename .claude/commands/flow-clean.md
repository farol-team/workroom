---
description: List finished-card worktrees and remove the ones the human confirms. The sanctioned cleanup path for "worktrees stay for inspection".
argument-hint: ""
allowed-tools: Read, Glob, Grep, Bash, mcp__trello
---

# /flow-clean

Role: housekeeping meta-agent. `/flow-run` never removes worktrees
(they stay for human inspection — see its Phase 4), and workers are
hook-blocked from `git worktree remove`. Without a sanctioned cleanup
path they accumulate forever; this command is that path. It NEVER
removes anything without an explicit per-run human confirmation.

## Algorithm

1. Read `.claude/tracker.json` — the `targets` map (fall back to the
   top-level `repo_root`/`worktree_root` when absent) and
   `states.{done, blocked}`.

2. For each target: `git -C <repo_root> worktree list --porcelain`;
   keep worktrees whose path lies under that target's `worktree_root`.
   Nothing found anywhere → reply `No kit worktrees found.` and exit.

3. For each worktree, derive `<card-short>` from the directory name:
   the segment before the first `-` (worktree dirs are
   `<card-short>-<slug>`, and `<card-short>` never contains a hyphen in
   any provider — Trello: 8-char shortLink prefix; GitHub: `i<number>`).
   Then classify:
   - **Card state** (tracker, per `.claude/providers/<provider>.md`):
     resolve the card from `<card-short>`.
     Card in `Done` → cleanup candidate. Card in `Blocked` / `Review` /
     `In Progress` / not found → keep (still under active inspection).
   - **Branch state** (`gh pr list --head <branch> --state all`):
     merged or closed PR strengthens the candidate; an OPEN PR vetoes it.
   - **Dirty check**: `git -C <worktree> status --porcelain` non-empty →
     NEVER a candidate; report `dirty — inspect by hand` instead.

4. Present the result as two lists — removal candidates (card Done, PR
   merged/closed, worktree clean) and kept (with the keep reason) — and
   ask ONE question: `Remove the N candidate worktrees? (yes / pick /
   no)`. `pick` → the human names which; anything else → exit without
   changes. Do not re-ask; do not treat silence as consent.

5. For each confirmed worktree:
   ```bash
   git -C <repo_root> worktree remove <path>       # NO --force, ever
   git -C <repo_root> branch -d <branch>            # -d, not -D
   ```
   Either command failing → report and continue with the rest (a
   `worktree remove` refusal usually means untracked files appeared
   since the dirty check — that worktree goes back to "inspect by
   hand"). Keep worker logs and state files in `worker_log_dir` — they
   are the audit trail, not the clutter.

6. Summary: removed / kept / failed, one line each.

## Failure modes

| Situation | Action |
|---|---|
| `git worktree remove` refuses (dirty/locked) | Keep; report `inspect by hand`. Never `--force`. |
| `branch -d` refuses (unmerged) | Keep the branch, report it — an unmerged branch for a Done card is itself a finding. |
| Tracker unavailable | Stop. Card state is the primary safety signal; do not clean on branch state alone. |
| Worktree dir exists but `git worktree list` doesn't know it | Report as orphan; leave for the human (`git worktree prune` is the human's call). |
