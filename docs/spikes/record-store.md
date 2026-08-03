# Spike: the record store

The design record for the record-store series: what the room's history is made
of, why it is built this way at prototype scale, and what is deliberately left
out until something needs it.

Two cards are in: content-addressed objects (`RecordStore::Objects`) and the
per-channel journal (`channel_records`, `RecordStore::Append`). What follows is
the shape all of it is aiming at, so the later cards — verification, the git
mirror, artifacts and memory joining the journal — do not each re-decide it.

## The shape

Three pieces, and only three:

| Piece | What it is | Where it lives |
|---|---|---|
| Objects | unnamed bytes, addressed by their SHA-256 | Active Storage, `record/sha256/<hex>` |
| Journal | one ordered, hash-chained row per thing that happened | `channel_records` |
| Writer | the server, and nothing else | `RecordStore::Append` |

An entry's envelope is canonical JSON — `{v, channel_id, seq, kind, subject,
prev_hash, occurred_at, payload}` — stored as an object like any other payload,
under its own digest. The row holds the ordering and the chain: `seq` counts
from one per channel, `prev_hash` is the previous entry's `entry_hash`, and the
first entry in a room points at `GENESIS`, sixty-four zeroes.

So the row is an index into the bucket, and the bucket holds the record. Given
both, a reader can replay a room and check every link. Given the bucket alone,
each entry still says which room, which position and which predecessor it
claims — which is what makes the export in a later card a mirror rather than a
second source of truth.

This is the spine of a buzz-style record — content addressing, an append-only
log, one writer — with the part deliberately missing that makes those systems
hard: there are no merges. One server appends, in one order, and nothing ever
has to reconcile two histories that both happened.

## Why Postgres holds the order

The obvious alternative is to keep the chain in the object store too, and
serialise writers with a conditional write — S3's `If-None-Match`, or an
equivalent compare-and-swap on a head pointer. That is what a system without a
database does, and this system has a database.

`channel.with_lock` — `SELECT … FOR UPDATE` on the channel row — is the
linearisation point instead. Inside it the writer reads the head, computes
`seq = head + 1`, builds and stores the envelope, and inserts the row. Two
people posting at the same moment queue at the lock, and the second reads the
first's entry as its head.

What this buys at prototype scale:

- **The journal write is in the same transaction as the thing it records.** A
  message that does not survive its transaction leaves no entry claiming it
  did. With the chain in the bucket, the two writes are in different systems and
  every failure between them is a hole somebody has to reconcile later.
- **`UNIQUE(channel_id, seq)` is a backstop the lock does not need to be
  trusted for.** If a second server ever appends — the deployment is one
  container today — a fork does not reach the table; the insert is refused.
- **Nothing new runs.** No head object, no retry loop, no lease.

What it costs, stated plainly: the guarantee is one PostgreSQL primary wide. A
second writer against a second database would need the conditional-write design
after all, and this is the piece to revisit first if that day comes.

`UNIQUE(channel_id, entry_hash)` sits beside it, so one envelope cannot be
journalled twice in a room even if a caller retries a write it already made.

## What the git mirror will read

The export card reads **the envelopes**, not the rows. That is why the chain is
in the bytes as well as in the columns: a mirror built from the table would be a
second rendering of the record, and two renderings drift. Reading the objects
means the mirror can be verified against the bucket by anybody who has it, with
no access to the database at all.

Canonical JSON is what makes that check possible. Keys sorted at every level,
arrays left in their order because their order is content, times in UTC ISO8601
— so re-serialising the same facts reproduces the same bytes and therefore the
same digest. It is fifteen lines in `RecordStore::Append` rather than a gem:
canonical JSON is a settled definition, and a dependency here is one to audit
for the rest of the series.

`record:verify`, in its own card, walks a room's rows in `seq` order and checks
three things: every entry's object exists, its digest matches its address, and
its `prev_hash` matches the previous entry's `entry_hash`.

## Deliberate simplifications

Each of these is a decision, not an oversight. The next person to want one
should know what it would cost rather than assume it was missed.

- **No entry signatures.** The chain proves nothing was removed from the
  middle; it does not prove who wrote it. Signing needs keys, key distribution
  and a rotation story, and the product's trust boundary today is the server —
  a person's agent never writes to the journal directly. Provenance is inside
  the payload instead: an agent-authored message carries its run's attribution
  from `MessageSerializer` verbatim.
- **No S3 conditional writes.** See above: the lock is the writer, and a
  second-instance deployment is the event that changes the answer.
- **The journal starts empty.** No backfill for messages that predate it. A
  synthesised entry for something nobody recorded at the time is a claim about
  the past dressed as a record of it, and the chain would be indistinguishable
  from one that was always there. A room's history begins the day it starts
  being kept.
- **Only messages, to begin with.** Artifacts and memory writes join the
  journal in the next card. `kind` and the nullable polymorphic subject are
  already there for them, which is why an entry names its subject rather than
  embedding a message-shaped record.
- **Nothing reads the journal yet.** No endpoint, no UI. It is written on the
  hot path and read by nothing until verification lands, which is deliberate:
  the write is the part that has to be right from the first entry, because a
  chain cannot be repaired retroactively.

## What was not proven

**Concurrency, honestly.** There is no thread-race spec. The suite runs each
test in one transaction on one connection, so two "simultaneous" appends there
would be two sequential appends wearing a costume — a test that passes whether
or not the lock exists. What is specified instead is the pair the design
actually rests on: the unique index refuses a hand-forced duplicate `seq`, and
sequential appends chain head to head. The lock's own behaviour under real
concurrency is unverified here and would need a harness with two connections.
