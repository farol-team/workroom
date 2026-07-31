# Tracker provider: Trello

How meta performs the kit's semantic tracker operations on Trello. Read
at bootstrap when `tracker.json` has `"provider": "trello"`. The kit's
generic noun **card** = a Trello card; a **state** = a Trello list on
the board (`states.<slot>` in `tracker.json` maps pipeline slots to
list ids).

## Transport

The Trello MCP server (tools under `mcp__trello__*`), e.g.
[`@delorenj/mcp-server-trello`](https://github.com/delorenj/mcp-server-trello),
configured with the board's API key/token. Pick the concrete tool by
intent — the op table names the intent, not a hardcoded tool signature
(MCP implementations differ slightly; any tool that performs the intent
is correct). Preferred tool names when the server offers them — keeps
two meta runs from diverging: `get_cards_by_list_id`,
`get_card` + `get_card_comments`, `add_card_to_list`, `move_card`,
`add_comment`, `update_card_details` (title), `archive_card`, the
checklist tools by name. Never fall back to raw Trello REST/curl.

## Operations

| op | how |
|---|---|
| `list_items(state)` | fetch cards of the list `states.<slot>` (by list id) |
| `read_item(ref)` | fetch the card + its comments (PLAN and audit history live in comments) |
| `create_item(state, title, desc, labels)` | create card in the list, apply labels |
| `move_state(ref, state)` | move the card to the target list |
| `add_comment(ref, text)` | plain-text comment (no full markdown rendering — keep formatting simple) |
| `set_labels(ref, labels)` | board labels; create missing ones first |
| `archive_item(ref, reason)` | comment the reason, then archive (close) the card |
| `update_title(ref, title)` | update the card's name (prefix maintenance for `/flow-normalize` and split sub-cards) |
| `checklist(ref, name, items)` | native Trello checklists (create/update/tick) |

## Ref resolution (in order)

1. `^https?://trello\.com/c/([A-Za-z0-9]{8})(?:/.*)?$` → shortLink = group 1
2. `^[A-Za-z0-9]{8}$` → shortLink itself
3. `^<card_prefix>-(\d+)$` (case-insensitive) → card with that `idShort`
4. else → unrecognized ref

`<card-short>` (branch names, log/state filenames) = first 8 chars of
the shortLink.

## Capabilities

| capability | value | consequence |
|---|---|---|
| native_ids | **no** | titles carry the `[<prefix>-<idShort>]` prefix; `/flow-normalize` maintains it |
| markdown_comments | **no** | keep comment formatting simple; headers/bold degrade gracefully |
| checklists | native | epics use real checklists |
| sub_issues | no | epics = `[epic]` tracker card + label + `Children` checklist |
| human_gate | drag between lists | the plan-approval gesture |
| done_semantics | move to the Done list | cards stay open |

## Quirks

- API rate limit: on HTTP 429 retry once after 5s; on second failure
  stop the run (cards keep their current state).
- Comments are plain text; long PLAN comments are fine (16k limit).
