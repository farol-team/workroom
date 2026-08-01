# Spike: where a transcript belongs

Research deliverable for #102. Recommends one home, with the measurements behind
it, and says which record is authoritative between this and #88.

**Verified against** `openviking` 0.4.11, the image already in the registry
(`crpgjk8bi1k5adp4g05l/openviking:0.4.11`), run locally with an account created
through the admin API. No embedding provider configured — see *What was not run*.

## Recommendation: object storage

Not the context database. Two independent findings disqualify it, and either one
alone would.

## The measurements

A transcript the size of the one on the deployed server — 16 375 bytes of turns —
written to each candidate location.

### It is not inert anywhere it can be written

```
POST /api/v1/content/write  viking://resources/channels/probe/run-1-transcript.json
→ ok   context_type=resource   written_bytes=16375

GET  /api/v1/fs/ls          viking://resources/channels/probe
→ [ "viking://resources/channels/probe/run-1-transcript.json" ]
```

That listing **is** what `Memory::OpenViking#all` returns, and `all` is what
`context_for` renders. A transcript written where a channel's knowledge lives is
therefore handed to every session that enters the room, as a thing the room
knows.

This is #54's finding at a different level. #54 established, against a live
instance, that letting the store ingest a raw chat log was disqualifying because
the whole transcript ended up inside a memory entry. It does not need to be
inside one: the directory listing is enough.

The obvious alternative is OpenViking's own session registry — which describes
itself as exactly the right home:

> `viking://user/<id>/sessions` — User session registry. Stores conversation
> state, live messages, tool outputs, and session history owned by the current
> User.

It is not writable:

```
POST /api/v1/content/write  viking://user/tester/sessions/run-1-transcript.json
→ 400 INVALID_ARGUMENT
  "write only supports memory or resource files under user scope"
```

So every location this API can write is either a memory or a resource, and both
are things the store ranks, retrieves and offers. There is no scope that holds
bytes and says nothing about them.

### It buys work nobody asked for, per turn

```
semantic_status = queued
vector_status   = queued
```

Every transcript would queue summarisation and embedding on a 16 kB document
that nobody reads and nothing searches for. That is inference spend per turn,
against the credential Article P2 was amended to permit for *infrastructure* —
and a transcript is not infrastructure, it is a receipt.

### The one thing that would have mattered had the rest passed

```
read back identical: True   (16 375 bytes)
```

A transcript that comes back reformatted is not a transcript. The store does not
reformat it. Recorded because it is the property that would have to hold, and
does.

## Retention, which is the number to decide with

19 kB per turn. A twenty-person workspace at a turn each per working day is
about 100 MB a year. A hundred people at ten turns a day is roughly 7 GB a year.

Neither is a reason to choose a store; both are a reason to have an expiry rather
than to discover one. Object storage is where a lifecycle rule is one setting.

## Which record is authoritative

**The server's copy is the record.** Artifacts belong to the channel (Article
D3), a colleague reads the run and its transcript through the room, and the room
outlives anybody's laptop.

#88 asks whether a session should also survive as an append-only `.jsonl` on the
person's machine. That is the agent's own working state — how a session resumes
locally — and it must not become the record, because a record only one person can
open is not one the room has. The two cards are answered consistently by saying
so: the room's copy is authoritative, the local file is convenience.

## What this costs to act on

Nothing new to build. `docs/DEPLOYING.md` already names object storage,
`config/deploy.yml` already carries `STORAGE_ENDPOINT`, `STORAGE_BUCKET`,
`STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`, and Active Storage
already stores the blob. On the deployed server the service is `local`, which is
the container's own disk and the reason for this card: those variables are
unset.

## What was not run

**Whether a transcript appears in search results.** That needs an embedding
provider, and the store had none. It does not change the recommendation: the
`ls` result above shows it reaching every session *without* any search at all,
which is the stronger finding and sufficient on its own.
