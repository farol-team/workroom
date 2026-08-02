# Data model

Fourteen tables, plus Active Storage's own. Plain relational, with two append-only logs:
`activities` for audit and `channel_records` for the room's own record.

```
users ──< memberships >── channels
                             │
                             ├──< messages ──< messages (one level)
                             ├──< agent_sessions ──< agent_runs ──< run_steps
                             ├──< artifacts
                             ├──< channel_records  (append-only, chained)
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

**`artifacts`** — files produced in a channel, optionally linked to the run that made them.
The linkage is what turns a channel into a complete record instead of a discussion of work
that happened elsewhere.

`sha256`, `byte_size` and `content_type` say where the bytes are and what they are. The
address is the content: an upload is stored once under its digest and the row names it, so
the same file arriving twice is one object and two rows. All three are nullable because rows
written before the record store have their bytes in an Active Storage attachment instead and
keep it — nothing migrates them, and a listing reads the size from wherever it actually is.
The index on `sha256` is plain, not unique, for the same reason two rooms may name one object.

Downloading is `GET /api/v1/channels/:slug/record/:sha256`, and it resolves through an
artifact row of that channel rather than through the hash. A digest names the same bytes
everywhere, so if it were the permission, overhearing one would be reading rights in every
room that stored the file (Article P5).

## Record

**`channel_records`** — one row per thing that happened in a room, in the order it happened:
`seq` numbered from one per channel, `kind`, an optional polymorphic `subject`, `entry_hash`
and the `prev_hash` of the entry before it. `created_at` is set explicitly and there is no
`updated_at`; the model marks persisted rows `readonly?`. A journal an edit could reach is
not one, and the chain only notices an edit if somebody checks.

What the entry *says* is not in the table. Every append writes one canonical JSON envelope —
channel, seq, kind, subject, prev_hash, time and payload — into the object store under its own
digest, and that digest is the row's `entry_hash`. So a reader holding the rows and the bucket
can tell that nothing was removed from the middle, and the row cannot claim something the
exported bytes do not.

**The object store** is not a table. `RecordStore::Objects` addresses content by SHA-256 in the
Active Storage service the environment already configures — Disk in development and test, the
bucket in production — under `record/sha256/<digest>`. The algorithm is in the key because it
will not always be SHA-256. Both halves of the record live there: artifact bytes and journal
envelopes. Objects are written and never deleted, which is what makes "ask, then download"
safe and what a rebuilt journal is checked against.

Appends happen in the same transaction as the write they record, which the API's
`around_action` already provides — a file or a message the journal could not record does not
exist, and a write that was refused leaves no entry.

## Memory

**`agent_runs.distilled_at`** — when a run kept something. Every turn ends by asking the
agent what the room should still know next week; if it answers by calling
`workroom://memory/remember`, the run carries the moment it did. A run without the timestamp
kept nothing, which is an answer rather than a gap.

There is no promotions table and no approval state. #22 removed the review queue, and
distillation follows it: the agent writes to the channel's memory directly, and a wrong entry
is corrected by superseding it (Article P3).

Every write leaves a `kind=memory` entry in the room's journal — an agent remembering, an
agent superseding, or a person recording something directly — naming the action, the uri, the
author and the run. The uri rather than a row id, because memory may be held by an external
context database where there is no row to point at.

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
