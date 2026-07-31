# Memory

## Scoping

A channel owns a region of the context database. The mapping is stored as data on the
channel, not derived by convention, so renaming a channel never breaks what it knows.

```
viking://resources/channels/meetings/      what the meetings channel knows
viking://resources/channels/marketing/     what the marketing channel knows
viking://org/                    organization-wide, readable everywhere
viking://personal/<user>/        one person's working notes, never promoted automatically
```

Write access narrows as you move up; read access widens. Personal space is where an agent
writes freely — drafts, preferences, working context. Nothing leaves it without a person
deciding it should.

This gives one concept four jobs: memory scope, permission boundary, retrieval scope, and
unit of conversation. Keeping them aligned is what makes the permission model tractable.

## Tiers

Every entry is processed on write into three depths:

| Tier | Content | Used for |
|---|---|---|
| `L0` | abstract | discovery — deciding whether this is relevant at all |
| `L1` | overview | orientation — what the channel knows, in a page |
| `L2` | detail | work — the full content, once something is chosen |

## Getting context into an agent

Two mechanisms at two tiers. You need both.

**Push at session start.** When someone enters a channel, the server assembles an `L1`
summary and the client injects it into the agent's session context. Cheap, always relevant,
and it means the agent knows what the channel is about from its first response.

**Pull on demand.** The capability rail is mounted as an MCP server. The agent fetches `L2`
detail itself, when a task actually needs it.

Push alone means paying for context nobody reads. Pull alone means the agent enters blind
and spends its first turns on reconnaissance. The tiers exist precisely so that the cheap
thing can always happen and the expensive thing happens only on demand.

## Writing

An agent writes to its channel's memory directly. There is no approval step and
no queue: the person is in the room to work, and a knowledge base that has to be
curated does not get curated.

What keeps that safe is that **correction is cheap**, rather than writing being
expensive:

- **Provenance is mandatory.** Every entry records the run it came from and whose
  agent produced it. An entry nobody can trace is a defect.
- **Correction supersedes.** Entries are never edited or deleted; a correction is
  a new entry that replaces the old one, and the history stays readable.
- **An agent that finds a contradiction resolves it.** Encountering memory its
  current work contradicts, it supersedes the stale entry rather than adding a
  second, conflicting one. This is what replaces the human gate: the store
  converges instead of accumulating.

A person may supersede any entry at any time — a correction they chose to make,
not a step they were required to take.

## The feedback loop

```
   memory ──read──► agent ──acts──► channel
      ▲                                │
      └────────── distillation ────────┘
```

An agent reads what the room knows, acts, and the action becomes part of the record. The
record is distilled back into what the room knows. The agent reads it again.

**The distiller is the agent.** Not a job on the server, and not the context store's own
extraction. Every turn ends by asking it what the room should still know next week; it
answers by calling `workroom://memory/remember`, or by keeping nothing. Two reasons, and
neither is convenience:

The person's agent is the only thing here that may think about the work. Article P2 permits
an infrastructure credential for embedding and tiering and says so in those words — a
server-side extractor would need one for neither.

And a store that extracts on its own extracts for a different product. The context store's
native session extraction was run against a real turn before being rejected: it writes to the
*person's* long-term memory rather than the room's, types it as `events/`, `identity.md` and
`soul.md`, and stores the entire chat log inside the entry. The room already has the
messages. Memory is for the conclusion.

Without discipline, this loop amplifies its own errors. A wrong inference enters memory as
a fact, is retrieved on the next task, corroborates itself, and within a month is
unarguable — with no trace of where it came from.

Four requirements, all load-bearing:

**Provenance is mandatory.** Every entry records the message or run it came from and the
person whose agent produced it. An unattributed claim cannot be audited, and unauditable
memory rots silently.

**Trust is asymmetric.** A person's assertion and an agent's inference are not equivalent,
even inside the same channel. Mark them differently and let retrieval weigh them.

**Promotion is a step, not an effect.** See above.

**Forgetting is designed alongside remembering.** Stale knowledge is more dangerous than
absent knowledge, because it is indistinguishable from current knowledge at retrieval time.
Entries need a way to expire, be superseded, or be marked as historical.

## Multiple writers

With one agent per person and shared channels, the loop above runs once per employee. One
person's agent reaching a wrong conclusion would otherwise become everyone's starting point.

Channel scoping contains this: writes land in a channel with a known membership, so an error
poisons one domain rather than the organization. Moving knowledge between channels, or up to
`viking://org/`, is a separate explicit act with its own review.

## Identity

An entry is identified by its **uri**, not by a row id. Superseding takes a uri,
the capability rail executes against a uri, and an external context store hands
back uris rather than primary keys. The API returns uris for the same reason: a
row id is the local table's, and the local table is meant to be replaceable.

## Two stores, one seam

`Memory::Store` is the seam (Article S1). Two implementations satisfy the same
contract suite, and no call site can tell which one is behind it.

| | `Memory::Local` | `Memory::OpenViking` |
|---|---|---|
| Holds entries | PostgreSQL rows | files in the context database |
| Retrieval | `ILIKE` over terms | by meaning, with a score |
| Abstract | the title | computed from the entry |
| Superseding | a timestamp on the row | the entry moves to `viking://resources/superseded/…` |
| Needs | nothing | a model provider of its own |

Set `OPENVIKING_URL` and `OPENVIKING_API_KEY` and the swap happens at boot.
Without them the store is PostgreSQL, which is why the prototype runs with one
command and no credentials at all.

### What the uri had to become

The context database accepts four scopes — `agent`, `resources`, `session`,
`user` — and refuses everything else outright. Channel memory is shared
knowledge belonging to no single person, which makes it a resource:

```
viking://resources/channels/meetings/acme-reporting-cadence.md
viking://resources/superseded/meetings/acme-reporting-cadence.md
```

Our side bent, and it had to: the scope list is the store's, not ours.

### What travels with an entry

Trust, authorship and the moment of recording are ours, not the store's
vocabulary. They travel twice — in front matter, which survives being read back,
and as tags, which a search can be narrowed by:

```markdown
---
title: Acme wants monthly reporting, not weekly
trust: human
author: Alice
recorded: 2026-07-31T09:15:53Z
---

# Acme wants monthly reporting, not weekly

Acme's ops lead asked for monthly rollups…
```

### Writing does not wait for thinking

The store computes an abstract and an embedding on write. An agent recording a
conclusion mid-turn does not sit through it. Measured against a local instance
with OpenAI embeddings:

| | |
|---|---|
| write | 0.09 s |
| what the room knows, for a session | 0.02 s |
| findable by meaning | ~15 s later, and longer behind a burst of writes |

The entry is readable immediately — it is in the room the moment it is written.
Only retrieval *by meaning* waits for the index, and it waits where nobody is
looking.

That asymmetry is a property of the store, not an implementation detail, so the
contract every store must satisfy says the entry becomes findable rather than
that it is findable at once. `Memory::Local` satisfies it on the first attempt.
