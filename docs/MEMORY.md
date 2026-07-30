# Memory

## Scoping

A channel owns a region of the context database. The mapping is stored as data on the
channel, not derived by convention, so renaming a channel never breaks what it knows.

```
viking://channels/meetings/      what the meetings channel knows
viking://channels/marketing/     what the marketing channel knows
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

## Promotion

Nothing reaches shared memory as a side effect.

```
work happens in a channel
        │
        ▼
distillation job proposes    →  promotion (state: proposed)
        │
        ▼
a person reviews             →  approved  or  rejected
        │
        ▼
apply job writes             →  context database, state: applied
```

The proposal is cheap and automatic. The approval is human and required. The temptation to
close that gap — to let good-looking conclusions flow straight into shared memory — is
strong and should be resisted, for the reason below.

## The feedback loop

```
   memory ──read──► agent ──acts──► channel
      ▲                                │
      └────────── distillation ────────┘
```

An agent reads what the room knows, acts, and the action becomes part of the record. The
record is distilled back into what the room knows. The agent reads it again.

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
