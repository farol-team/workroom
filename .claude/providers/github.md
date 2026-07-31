# Tracker provider: GitHub Issues

How meta performs the kit's semantic tracker operations on GitHub
Issues — via the `gh` CLI, **no MCP server needed**. Read at bootstrap
when `tracker.json` has `"provider": "github"`. The kit's generic noun
**card** = a GitHub issue in `tracker.repo`; a **state** = a pipeline
label (`states.<slot>` in `tracker.json`, conventionally
`flow:<slot>`, e.g. `flow:ready`). Exactly one `flow:*` label per issue
at any time — `move_state` swaps them atomically.

## Transport

`gh` (authenticated, `repo` scope for `tracker.repo`). All ops are
plain commands — compose with `--json` for parsing. `<repo>` below =
`tracker.repo` (`owner/name`).

## Operations

| op | command template |
|---|---|
| `list_items(state)` | `gh issue list -R <repo> --label "<states.slot>" --state open --limit 200 --json number,title,labels,url` — for the `done` state use `--state closed` (see done_semantics) |
| `read_item(ref)` | `gh issue view <number> -R <repo> --json number,title,body,labels,url,state,comments` |
| `create_item(state, title, desc, labels)` | `gh issue create -R <repo> --title "..." --body-file - --label "<states.slot>" [--label ...]` |
| `move_state(ref, state)` | `gh issue edit <number> -R <repo> --add-label "<new>" --remove-label "<old>"`; for `done` additionally `gh issue close <number>`; moving OUT of done → `gh issue reopen` first |
| `add_comment(ref, text)` | `gh issue comment <number> -R <repo> --body-file -` (full markdown — use it) |
| `set_labels(ref, labels)` | `gh issue edit --add-label/--remove-label`; create missing labels with `gh label create -R <repo>` |
| `archive_item(ref, reason)` | `gh issue close <number> -R <repo> --comment "<reason>"` and remove its `flow:*` label (an archived card must not answer any state query — a closed issue without `flow:done` is out of the pipeline) |
| `update_title(ref, title)` | `gh issue edit <number> -R <repo> --title "..."` (rarely needed: native_ids means no prefix maintenance) |
| `checklist(ref, name, items)` | no native checklists: maintain a markdown task list (`- [ ] item`) inside a `### <name>` section of the issue BODY via `gh issue edit --body-file -` (read-modify-write the whole body; touch only that section) |

## Ref resolution (in order)

1. `^https?://github\.com/<owner>/<name>/issues/(\d+)$` → issue number
2. `^#?(\d+)$` → issue number
3. `^i(\d+)$` → issue number (the `<card-short>` form — worktree dir
   names and log files lead with it)
4. `^<card_prefix>-(\d+)$` (case-insensitive) → issue number (the
   numeric part IS the issue number — GitHub ids are native)
5. else → unrecognized ref

`<card-short>` (branch names, log/state filenames) = `i<number>`
(e.g. `i142` — the number alone can collide with iteration suffixes in
filenames).

## Capabilities

| capability | value | consequence |
|---|---|---|
| native_ids | **yes** | titles stay clean — NO `[<prefix>-N]` title prefix; `/flow-normalize` exits with "not needed for this provider" |
| markdown_comments | **yes** | PLAN / audit comments render as real markdown |
| checklists | markdown task list in the issue body | epics maintain a `### Children` section instead of a checklist object |
| sub_issues | not used (v1) | epics = `[epic]` tracker issue + label + `### Children` task list |
| human_gate | swap the `flow:*` label (issue sidebar or a Projects board view) | the plan-approval gesture |
| done_semantics | label `flow:done` + issue **closed** | `list_items(done)` must query `--state closed` |

## One-time repo setup (adoption)

```sh
for s in icebox backlog triage human-questions plan-proposed ready in-progress review blocked done; do
  gh label create "flow:$s" -R <repo> --color 5319e7 --force
done
gh label create ai-generated -R <repo> --color 0e8a16 --force
```
Optionally add the issues to a GitHub Projects (v2) board grouped by
the `flow:*` labels for a kanban view; the labels stay the source of
truth — the kit never reads Projects fields.

## Quirks

- `gh issue list` caps at 30 by default — always pass `--limit 200`.
- Comment bodies: pass via `--body-file -` (stdin), never inline `-b`
  (quoting bugs with markdown/backticks).
- `list_items(done)` needs `--state closed` (see done_semantics);
  every other state queries `--state open`.
- Labels are repo-global: the `repo:` execution-target label mechanism
  works unchanged.
