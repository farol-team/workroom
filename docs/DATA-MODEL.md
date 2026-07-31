# Data model

Ten tables. Plain relational, one append-only log for audit.

```
users ──< memberships >── channels
                             │
                             ├──< messages ──< messages (one level)
                             ├──< agent_sessions ──< agent_runs ──< run_steps
                             ├──< artifacts
                             └──< promotions

activities                    (append-only, polymorphic)
```

## Identity

**`users`** — provisioned through SSO. `provider` + `uid` identify the account upstream;
`email` is unique. No local passwords.

**`memberships`** — the only access primitive. A person is a `member` or an `owner` of a
channel. Everything the permission model needs is derivable from this table plus the channel's
visibility.

## Space

**`channels`** — `slug`, `name`, `purpose`, `visibility`, and `memory_uri`.

`memory_uri` is the important one. It stores the channel's region in the context database as
data rather than deriving it from the slug, so a channel can be renamed without orphaning
what it knows, and a region can be re-pointed without a code change.

**`messages`** — belongs to a channel, has a polymorphic `author`, and an optional `parent`.

The author is a `User` or an `AgentRun` — never a "bot user". Attributing an agent's message
to the run means the steps, the cost, and the triggering message are all one hop away.

`parent` gives threads. A model validation enforces a single level: replying to a reply is
rejected. Unbounded nesting is a UX trap that no team escapes once entered.

## Agent

**`agent_sessions`** — one per (user, agent, channel) triple, holding the ACP session's external id and
lifecycle state. This is the table that makes channel-scoped memory fall out naturally rather
than needing to be enforced.

**`agent_runs`** — one turn. Status, token counts, timings, and the message that triggered it.
Cost reporting per person and per channel rolls up from here.

**`run_steps`** — tool calls, results, and reasoning, recorded as they happen. `created_at` is
set explicitly and there is no `updated_at`: the table is append-only by intent.

## Output

**`artifacts`** — files produced in a channel, attached through Active Storage. Optionally
linked to the run that made them. The linkage is what turns a channel into a complete record
instead of a discussion of work that happened elsewhere.

## Memory

**`agent_runs.distilled_at`** — when a run kept something. Every turn ends by asking the
agent what the room should still know next week; if it answers by calling
`workroom://memory/remember`, the run carries the moment it did. A run without the timestamp
kept nothing, which is an answer rather than a gap.

There is no promotions table and no approval state. #22 removed the review queue, and
distillation follows it: the agent writes to the channel's memory directly, and a wrong entry
is corrected by superseding it (Article P3).

## Audit

**`activities`** — actor, action, subject, metadata, timestamp. Polymorphic on both ends.

The model marks persisted records `readonly?`, so the table is append-only at the application
level. This is what provides auditability without making the whole system event-sourced: one
table to read chronologically, while everything else stays an ordinary schema.

## What is deliberately absent

**No skills table.** Access derives from the URI path and channel membership. A grants table
arrives when skills need assigning outside of channels — not before.

**No bot users.** An agent is not a `User` row. Agents act within a run, on behalf of a person,
and the schema says so.

**No soft deletes.** Channels and messages cascade. Audit lives in `activities`, which is where
history belongs.
