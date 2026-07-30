# WorkRoom

**A shared workspace where every person brings their own local agent, and the room remembers.**

Channels are domains of work — `meetings`, `marketing`, `support`. You work in a channel
with your own agent running on your machine. Your colleague joins the same channel with
*their* agent and picks up where you left off, because the memory lives in the room, not
in the agent.

> Status: **early design**. The schema and models are laid out; there is no running app yet.

---

## The idea in one picture

```
  Alice — Claude Code (local) ──┐
  Bob   — Claude Code (local) ──┤  ACP
  Dana  — Cowork      (local) ──┼──────► WorkRoom (Rails)
                                │        channels · messages · artifacts
                                │        SSO · permissions · capability rail
                                │                    │
                                │                    ▼  MCP
                                └──────────────► OpenViking
                                                 viking:// memory + skills
```

Three protocols hold the seams, and nothing crosses them:

| Protocol | Carries |
|---|---|
| **ACP** | control — who does the work (desktop ↔ local agent) |
| **MCP** | capability — what can be done (agent ↔ rail) |
| **HTTP/WS** | record — what happened (client ↔ server) |

## Design decisions worth knowing

**Channel = memory scope = permission boundary = retrieval scope.** One concept doing four
jobs. `channels.memory_uri` maps a channel onto a `viking://` prefix as *data*, so renaming
a channel never breaks its memory.

**Promotion into shared memory is an explicit act, not a side effect.** Distillation only
ever creates a `proposed` promotion; a human approves; a job applies it. Without this
discipline, one agent's wrong conclusion becomes everyone's fact, confirms itself on the
next pass, and is unarguable within a month.

**A message's author is an `AgentRun`, not a `User`.** From any agent message you can reach
its steps, its cost, and the message that triggered it. Attributing to the user loses that.

**`run_steps` exist for perceived quality.** Without them the user watches silence for
minutes. With them the UI shows what is happening right now.

**Threads are one level deep.** Unbounded nesting is a UX trap.

**No skills table.** Access derives from the path — channel members see
`viking://channels/<slug>/skills/`, everyone sees `viking://org/skills/`. A grants table
arrives only when skills must be assigned outside of channels.

**Not event-sourced.** A plain relational schema plus one append-only `activities` table
gives auditability without making every read a projection.

## Stack

| | | |
|---|---|---|
| Server | Ruby on Rails | 8.1.3.1 on Ruby 3.4.10 |
| Realtime | Action Cable | Solid Cable — no Redis |
| Jobs | Active Job | Solid Queue |
| Artifacts | Active Storage | S3-compatible |
| Auth | OmniAuth | OIDC / SAML |
| Database | PostgreSQL | |
| Desktop | Tauri 2 | not Electron |
| Local agent | Claude Code | via `@zed-industries/claude-code-acp` |
| Memory | OpenViking | separate service, AGPL-3.0 |

## Schema

```
users          channels        memberships
messages       agent_sessions  agent_runs    run_steps
artifacts      promotions      activities
```

See `db/migrate/` — every table carries a comment explaining why it exists.

## Getting started

Nothing runs yet. When it does:

```bash
bundle install
bin/rails db:prepare
bin/rails server
```

Requires Ruby 3.4.10 (3.2 reached end of life on 2026-03-31).

## Roadmap

1. Channels, messages, threads, SSO, Action Cable — a working chat, no agents
2. ACP: Tauri spawns the adapter, one session per (user, channel)
3. OpenViking + the capability rail as a Rails endpoint
4. Artifacts into the channel
5. Rehydration — a colleague continues the work

Built by [Farol Labs](https://github.com/farol-team).
