# Architecture

## What is shared when a colleague joins

Four things get conflated; only three are shareable.

| | Shared | Lives in |
|---|---|---|
| Channel history — what was said | yes | Postgres |
| Long-term memory — conclusions, decisions | yes | OpenViking |
| Artifacts — files produced | yes, by design | Active Storage → S3 |
| **Agent session context window** | **no** | local, per person |

So "a colleague continues the work" means their agent enters the channel and **rehydrates**
from the shared trail. It is not a handoff of a live session. Design for rehydration: on
entering a channel the agent receives a compact summary, not raw history.

## How channel context reaches the agent

Two mechanisms at two tiers — you need both.

**Push at session start.** The app pulls a compact summary (OpenViking `L1`) and injects it
into the ACP session's system context. Cheap, always relevant, gives the agent "I know what
this channel is about" from the first second.

**Pull on demand.** The rail is mounted as an MCP server; the agent fetches `L2` detail when
a task actually needs it.

Push only means paying for context nobody used. Pull only means the agent enters blind and
burns turns on reconnaissance.

## The capability rail

One MCP endpoint inside the Rails app exposing exactly two tools:

- `search_capabilities(query)` → retrieval scoped to `viking://`, filtered by the caller's
  channel membership, returning `L0`/`L1` summaries plus URIs
- `execute_capability(uri, args)` → instruction skills return their `L2` body for the agent
  to follow locally; bound capabilities proxy to an internal MCP server so credentials stay
  server-side

It lives in Rails rather than as a separate service because it needs the permission model
that Rails already owns — user, membership, role. A separate service would duplicate it.

**Two tools instead of fifty is a context-economy decision.** Exposing fifty skills as fifty
MCP tools charges every session for fifty schemas before anything happens. The rail collapses
that to two and charges only for what a query actually surfaces. The rail compresses the tool
surface; `L0/L1/L2` compresses the content. Same idea at two levels.

## The feedback loop

```
   OpenViking ──read──► agent ──acts──► channel
        ▲                                  │
        └────────── distillation ──────────┘
```

An agent reads knowledge, acts, the action becomes a record, the record becomes knowledge,
the agent reads it again. Undisciplined promotion makes the system amplify its own errors.

Four requirements, all load-bearing:

- **Provenance is mandatory.** Every memory entry references the record it came from and the
  person whose agent produced it.
- **Trust is asymmetric.** A human's assertion and an agent's inference are not equal, even
  inside one channel.
- **Promotion is an explicit step.** The temptation to auto-distil everything is strong.
  Resist it.
- **Forgetting is designed alongside remembering.** Stale knowledge is more dangerous than
  missing knowledge, because it looks identical.

## Open questions

- **Rust in Tauri.** The native side spawns the Node ACP adapter and pipes stdio — a few
  hundred lines. Tauri's sidecar mechanism can bundle the adapter.
- **ACP adapter freshness.** `@zed-industries/claude-code-acp` 0.16.2 has not shipped since
  2026-02-17. It is load-bearing here; worth tracking, and worth knowing the alternatives.
- **OpenViking is AGPL-3.0.** Run as a shared internal service, §13 obliges you to offer
  source — including your modifications — to the employees using it.
- **Policy.** Channel membership is coarse. Restricting capabilities beyond "member of the
  channel" is easiest to do by simply not granting the MCP server, not by a policy engine.
