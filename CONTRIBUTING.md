# How this repository is developed

Every change here goes through [`farol-team/agent-flow`](https://github.com/farol-team/agent-flow). This is not a recommendation — three of its rules are checked on the pull request and fail the build.

## The shape of a change

1. **A card exists** as a GitHub issue, with a `[meta] PLAN` comment agreed before any code.
2. **A branch names it** — `flow/i<card>-<slug>`, e.g. `flow/i89-kit-required`.
3. **The test comes first**, and where the flow's TDD gate applies, a surviving mutation is a hole in the tests rather than proof of coverage.
4. **The pull request shows its gates** — what was run and what it said, not a claim that it passed.
5. **Acceptance is audited** against the card before merge.

The commands that drive this live in `.claude/commands/` (`/flow-run`, `/flow-check`, and the rest). The constitution the work is argued against is `.claude/constitution.md` — 19 articles, amended with the reason recorded, and cited when something is refused.

## What CI enforces

| Check | Fails when |
|---|---|
| `kit-intact` | `.claude/` no longer matches the revision in `.claude/KIT_REVISION` |
| `branch-has-card` | the branch does not name a card, or the card does not exist |
| `pr-carries-evidence` | the pull request body has neither a `## Gates` nor a `## Test plan` section |

`kit-intact` also runs `bin/kit-verify --selftest` on every build, because a check that cannot go red says nothing.

## The workflow kit

`.claude/{commands,prompts,hooks,bin,providers}` are **owned upstream**. To update them:

```
bin/workflow-kit-sync           # from main
KIT_REF=<sha> bin/workflow-kit-sync
```

The sync uses `rsync --delete`. **Anything you edit in those directories is deleted by the next update, with no diff to notice it by** — which is what `kit-intact` exists to catch. If a kit file needs to change, either send the change to `farol-team/agent-flow` and sync, or move the file out of the kit-owned trees and say plainly that it is ours.

Project-owned and never touched by a sync: `.claude/constitution.md`, `.claude/tracker.json`, `.claude/learnings.jsonl`, `.claude/CONVENTIONS.md`.

The verification tools live in `bin/`, not `.claude/bin/`, for the same reason: `.claude/bin` is one of the trees the sync wipes, and a check the sync can delete is not a check.

## What is still advisory

`main` has no required status checks. Until it does, every gate in this repository — these three included — reports rather than blocks. Turning them on is a repository setting, not a file, and it is the step that makes the rest of this binding.
