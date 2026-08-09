# Architecture

## Components

```
┌────────────────────────────────────┐   ┌────────────────────────┐
│  Desktop client (Tauri)            │   │  Browser               │
│  channels · messages · artifacts   │   │  channels · messages   │
│  session control                   │   │  artifacts             │
└──────┬──────────────────────┬──────┘   └───────────┬────────────┘
       │ HTTPS + WebSocket    │ ACP over stdio       │ HTTPS + WebSocket
       │                      ▼                      │
       │            ┌─────────────────────┐          │
       │            │  Local agent        │          │
       │            │  runs on the user's │          │
       │            │  own machine        │          │
       │            └──────────┬──────────┘          │
       │                       │ MCP                 │
       ▼                       ▼                     ▼
┌──────────────────────────────────────────────────────────────────┐
│  WorkRoom server (Rails)                                         │
│  identity · channels · messages · artifacts · permissions        │
│  capability rail · memory gateway                                │
│  hosted runner — a turn for a person who brought no machine      │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTP
                           ▼
              ┌──────────────────────────────┐
              │  Context database            │
              │  memory · skills · artifacts │
              │  addressed by URI            │
              └──────────────────────────────┘
```

## Seams

Three protocols hold the system together. Nothing crosses a seam except through them.

| Protocol | Between | Carries |
|---|---|---|
| **ACP** | desktop ↔ local agent | control — who does the work |
| **MCP** | agent ↔ capability rail, agent ↔ memory gateway | capability — what can be done |
| **HTTP / WebSocket** | client ↔ server | record — what happened |

This is the one architectural rule worth defending strictly. As long as the boundaries speak
only these three, any layer can be replaced without touching the others.

The agent reaching the context database was the one crossing argued about and then allowed,
on 2026-08-01, at the cost of replaceability — that store's tool names became part of what
agents were written against. The concession was **withdrawn on 2026-08-08** (#297, #298). An
agent's `context` MCP server is now the server's own **memory gateway**
(`POST /api/v1/memory/mcp`), authenticated by a scope token minted for one channel and one
person rather than by the store's account key. Same MCP, same vocabulary, one channel wide:

- the gateway forwards reads whose every `viking://` falls inside the token's prefixes, and
  refuses the rest before the store hears them. Everything not named is refused by omission,
  so a tool the store grows tomorrow does not arrive working.
- writes do not pass at all. An agent records through the rail, which stamps the run and the
  author on the entry; a write arriving at the gateway would carry neither.

The store still isolates **accounts**, not channels — `docs/spikes/openviking-isolation.md`
is the measurement, and it is why the gateway holds the account key and the agent does not.
`Memory::Boundary` additionally **asks** the agent in its prompt to stay in its subtree. That
one is a convention, it is now a courtesy rather than the boundary, and nothing in the server
may be written as though a sentence in a prompt stopped anything.

In a hosted turn there is no ACP, because there is no separate agent process to speak it to:
`Turn::Run` calls the provider directly and the two rail tools are the whole tool surface.
The seam is not bypassed, it is absent — control is the job, and what the room sees still
arrives as record over HTTP/WebSocket.

## Flow of a turn

A turn runs where the person chose (`users.execution_mode`, `own` by default). Steps 3–8
below are the `own` path, which is the one a fresh install takes; the hosted path is after it.
The room is never told which produced a turn — a turn is a turn.

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

**Hosted (`execution_mode: "hosted"`, #308).** Steps 1, 2, 5, 7 and 9 are unchanged; the
middle is. There is no client holding the turn open, so the server enqueues `HostedTurnJob`
— a turn is minutes and a request is not, and a browser tab that closes must not end one.
`Turn::Run` then converses with the provider directly, bounded at `ROUNDS = 12`, using the
person's own credential and the rail's two tools as its entire tool surface. Steps 3, 4 and 6
collapse into that loop, and step 8 has nothing to offer: there is no working folder.

Nothing here is sandboxed, and that is the design rather than an omission. The desktop agent
has a folder, a shell and a git history because a laptop has those; a browser has none of
them, so this is not that agent moved to a server. There is no filesystem to escape and no
process to contain. What is left is contained already — the rail is one channel's (#297), a
capability that changes something outside is proposed rather than run (#302, #309), and
row-level security is the boundary between workspaces.

## Where state lives

| State | Home | Shared |
|---|---|---|
| Identity, membership, permissions | Rails | yes |
| Channel history | Rails / PostgreSQL | yes |
| Run steps, cost, timings | Rails / PostgreSQL | yes |
| Artifacts | Active Storage → S3 | yes |
| Distilled knowledge, skills | context database | yes |
| Agent session context window | the person's machine, or the hosted turn that held it | **no** |
| Credentials for the agent's own model | the person's machine, or `user_credentials` | **no** |

Neither of the last two rows is ever shared, and that is what makes a colleague joining a
channel a rehydration rather than a resumption — the context window that did the work is gone
either way, whichever machine held it.

A credential reaches the server only when a person switched to the hosted mode, and it is
held under Article P2's three conditions: exactly one per user (`null: false` plus a unique
index on `[user_id, provider]` — the article's central clause written where the database
enforces it), encrypted at rest, and never readable back through any endpoint. Switching back
to `own` deletes it, because a key outliving the reason for it is the kind nobody notices.

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

**No agent hosting** *(until 2026-08-08, #308)*. This section used to argue that a server
running an agent would need credentials, sandboxing and queueing — three problems that do not
exist when execution stays local. Two of the three were answered rather than avoided:
credentials by Article P2's conditions above, queueing by Solid Queue in its own database.
The third turned out not to apply, because the hosted runner is not the desktop agent moved
to a server and has nothing to sandbox. What survives is the principle the rule was standing
in for — no central credential, and therefore no shared bill and no shared rate limit — which
is now enforced per user instead of by geography. Requiring a laptop was never the point; it
was how the point used to be made, and it put the product out of reach of the companies it is
for.
