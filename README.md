# WorkRoom

**A shared workspace where every person brings their own local agent, and the room remembers.**

Channels are domains of work — `meetings`, `marketing`, `support`. You work in a channel
alongside your own agent, running on your own machine. A colleague joins the same channel
with *their* agent and continues where you stopped, because what the room knows is held by
the room, not by anyone's agent.

> **Status: a running prototype.** `bin/prototype` brings the whole thing up. Channels,
> live messages, a local agent in the room over ACP, a capability rail the agent reaches
> memory through, and rehydration across people and sessions. See
> [Running it](docs/RUNNING.md).

```
  Alice — local agent ──┐
  Bob   — local agent ──┤  ACP
  Dana  — local agent ──┼──────► WorkRoom
                        │        channels · messages · artifacts
                        │        identity · permissions · capability rail
                        │                    │
                        │                    ▼  MCP
                        └──────────────► context database
                                         memory + skills
```

## Documentation

| | |
|---|---|
| [Concept](docs/CONCEPT.md) | The problem, the idea, and what this deliberately is not |
| [Architecture](docs/ARCHITECTURE.md) | Components, seams, and how work flows through them |
| [Memory](docs/MEMORY.md) | Channel scopes, tiers, promotion, and the feedback loop |
| [Agents](docs/AGENTS.md) | Local agents, sessions, rehydration, artifacts |
| [Capability rail](docs/RAIL.md) | Two tools, dynamic discovery, execution modes |
| [Data model](docs/DATA-MODEL.md) | Tables, and the reasoning behind each |
| [Roadmap](docs/ROADMAP.md) | What gets built, in what order, and why |
| [Running it](docs/RUNNING.md) | How to start it, and how to see the idea work |

## Stack

| | | |
|---|---|---|
| Server | Ruby on Rails | 8.1.3.1 on Ruby 3.4.10 |
| Realtime | Action Cable | Solid Cable — no Redis |
| Jobs | Active Job | Solid Queue |
| Artifacts | Active Storage | S3-compatible |
| Identity | OmniAuth | OIDC / SAML |
| Database | PostgreSQL | |
| Desktop | Tauri 2 | |
| Local agent | any ACP-speaking agent | opencode by default |
| Context database | OpenViking | separate service |

## Repository layout

```
server/     Rails — API, WebSocket, capability rail, admin
desktop/    Tauri — desktop client, manages the local agent over ACP
docs/       documentation
```

One repository, because for now nearly every change crosses the seam between the two.
Splitting becomes worthwhile when the client grows its own team, not before.

Release tags are prefixed: `server-v*` and `desktop-v*`.

## Getting started

```bash
bin/prototype                              # database, schema, a seeded room, server
cd desktop && pnpm install && pnpm tauri dev
```

See [Running it](docs/RUNNING.md) for what to try once it is up.

Requires Ruby 3.4.10 and Node 24. The agent is yours: `npm i -g opencode-ai && opencode auth login`.

---

Built by [Farol Labs](https://github.com/farol-team).
