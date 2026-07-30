# Running it

Three processes: a database, the server, and the desktop client. The agent is
started from inside the client.

## 1. Database

```bash
docker compose up -d postgres
```

Postgres on `5433`, so it will not collide with anything already on `5432`.

## 2. Server

Requires Ruby 3.4.10.

```bash
cd server
bundle install
bin/rails db:prepare db:seed
bin/rails server            # http://127.0.0.1:3000
```

The seed creates two people (`alice@farol.run`, `bob@farol.run`), two channels
(`meetings`, `marketing`), and puts two things into the meetings channel's memory —
one stated by a person, one inferred by an agent — so there is something to
rehydrate from on the first run.

## 3. Desktop client

```bash
cd desktop
pnpm install
pnpm tauri dev
```

Sign in with any email. Development sign-in creates the account on the spot.

## 4. The agent

The client starts a local agent for you, but the agent has to be installed and
authenticated first — it runs under **your** credentials, which is the point.

```bash
npm i -g opencode-ai
opencode auth login
```

Then press **Start agent** in the client. Any other agent that speaks ACP works;
pass a different command to `agent_start`.

---

## Testing the concept

The claim is that the room remembers, so a colleague's agent can continue work
that a different person's agent started. Two ways to see it.

**Rehydration.** In `# meetings`, with the agent running, ask:

> What did we agree with Acme about reporting?

Nobody told this session anything about Acme. The answer comes from the channel's
memory, which was pushed into the session when it opened. Open **What the room
knows** to see exactly what it was given — `●` for what a person stated, `○` for
what an agent inferred.

**Handoff.** Sign in as `bob@farol.run` in a second window, open the same channel,
and ask a follow-up. It is a different person, a different agent process, and a
different session — and the work continues, because what the room knows is held by
the room.

## What is not wired yet

- **Distillation.** Memory is written deliberately (`POST /api/channels/:slug/memory`),
  not proposed automatically from conversation. The `promotions` table and its review
  flow exist in the schema; the job that fills it does not.
- **The capability rail.** Sessions open with an empty MCP list. The handshake reports
  `mcpCapabilities`, so this is where the rail attaches.
- **Artifacts.** Files an agent writes stay on the machine that wrote them.
- **SSO.** Development sign-in only.
