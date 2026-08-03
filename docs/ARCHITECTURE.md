# Architecture

## Components

```
┌──────────────────────────────────────────────────────────┐
│  Desktop client (Tauri)                                  │
│  channels · messages · artifacts · session control       │
└──────┬────────────────────────────────┬──────────────────┘
       │ HTTPS + WebSocket              │ ACP over stdio
       ▼                                ▼
┌──────────────────────────────┐   ┌─────────────────────┐
│  WorkRoom server (Rails)     │   │  Local agent        │
│  identity · channels         │   │  runs on the user's │
│  messages · artifacts        │   │  own machine        │
│  permissions                 │   └────┬───────────┬────┘
│  capability rail ◄───────────┼── MCP ─┘           │
│                              │                    │
└──────────────┬───────────────┘                    │ MCP
               │ HTTP                               │
               ▼                                    │
┌──────────────────────────────┐                    │
│  Context database            │◄───────────────────┘
│  memory · skills · artifacts │
│  addressed by URI            │
└──────────────────────────────┘
```

## Seams

Three protocols hold the system together. Nothing crosses a seam except through them.

| Protocol | Between | Carries |
|---|---|---|
| **ACP** | desktop ↔ local agent | control — who does the work |
| **MCP** | agent ↔ capability rail, agent ↔ context database | capability — what can be done |
| **HTTP / WebSocket** | client ↔ server | record — what happened |

This is the one architectural rule worth defending strictly. As long as the boundaries speak
only these three, any layer can be replaced without touching the others.

The agent reaching the context database is the one crossing that was argued about and then
allowed, on 2026-08-01, for as long as there is one workspace. It speaks MCP, so the seam's
vocabulary survives; what does not is replaceability, because that store's tool names are now
part of what agents are written against. Two things follow, and both are load-bearing:

- the store isolates **accounts**, not channels, so an agent's key reaches every channel of
  its workspace. `docs/spikes/openviking-isolation.md` is the measurement.
- an agent is **asked** in its prompt to stay inside its channel's subtree. That is a
  convention. Nothing enforces it, and nothing in the server may be written as though
  something did.

## Flow of a turn

1. A person posts a message in a channel.
2. The server records it and broadcasts over Action Cable.
3. The desktop client resolves the session for this (user, agent, channel) triple, starting one if
   needed, and injects the channel's context summary.
4. The message goes to the local agent over ACP.
5. The agent works. Every tool call and result arrives back as a run step, which the client
   forwards to the server, which broadcasts it. The channel shows what is happening now.
6. The agent may query the capability rail over MCP for skills or deeper context.
7. The agent's answer becomes a message in the channel, attributed to the run.
8. Files the run produced are **offered** to the channel as artifacts — the turn's own
   changes, measured from where the folder stood when the turn began (#202). Work product
   belongs to the channel; what leaves the machine is still the person's press.
9. The agent distils its own turn and writes what the room should keep to channel memory
   through the rail (#54). There is no approval step and no queue: provenance is mandatory
   and a wrong entry is superseded rather than gated. See [MEMORY.md](MEMORY.md).

## Where state lives

| State | Home | Shared |
|---|---|---|
| Identity, membership, permissions | Rails | yes |
| Channel history | Rails / PostgreSQL | yes |
| Run steps, cost, timings | Rails / PostgreSQL | yes |
| Artifacts | Active Storage → S3 | yes |
| Distilled knowledge, skills | context database | yes |
| Agent session context window | the person's machine | **no** |
| Credentials for the agent's own model | the person's machine | **no** |

The last two rows are the reason execution stays local, and the reason a colleague joining a
channel is rehydrating rather than resuming.

## Why not event sourcing

Every message, tool call, and approval could be modelled as an immutable event in one log.
It buys uniform querying and an audit trail by construction.

It is not worth it here. The audit requirement is satisfied by one append-only `activities`
table alongside an otherwise ordinary relational schema. Everyone on the team can read that
schema on the first day, and no read becomes a projection. The cost of event sourcing is
paid on every query and every new developer; the benefit is one table's worth.

## Why the rail lives inside Rails

The capability rail needs to know who is calling and what they may see — user, channel
membership, role. Rails already owns that. A separate service would either duplicate the
permission model or call back into Rails on every request. Keeping the rail as an endpoint
gives it the session and the permission model for free, and reduces the system by one
deployable.

See [RAIL.md](RAIL.md).

## Deliberate omissions

**No policy engine.** Access is channel membership, and capabilities are restricted by simply
not granting the MCP server that provides them. A finer model can be added when a real case
demands it; adding one preemptively means maintaining a second permission system that nothing
uses.

**No federation.** One organization, one deployment.

**No agent hosting.** The server never runs an agent. If it did, it would need credentials,
sandboxing, and queueing — three problems that do not exist when execution stays local.
