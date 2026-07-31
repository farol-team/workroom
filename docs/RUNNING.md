# Running it

```bash
bin/prototype
```

That brings up Postgres, prepares the schema, seeds a room with work already in
it, and starts the server on `http://127.0.0.1:3000`. Then, in another terminal:

```bash
cd desktop && pnpm install && pnpm tauri dev
```

Sign in as `alice@farol.run`. Development sign-in creates the account on the spot.

Requires Ruby 3.4.10, Node 24, and Docker for the database. Postgres binds `5433`,
so it will not collide with anything already on `5432`. If you already run Postgres
yourself, set `DATABASE_URL` and `bin/prototype` will use it instead of Docker.

## Your own agent

The client starts an agent for you, and it runs on your machine under **your**
credentials — that is the point of the design, not a limitation of the prototype.

```bash
npm i -g opencode-ai
```

**You do not need a credential to try this.** opencode ships free models, and one
of them is the default below. `opencode auth login` is for using your own
subscription, which is what the design is actually for — but nothing here is
gated behind it.

Then press **Start agent**. Any agent that speaks ACP works; pass a different
command to `agent_start`.

## Looking at it, without opening it

```bash
bin/preview
```

Renders the built client against the running server with the native bridge
stubbed, and writes a picture of each state worth seeing — signed out, a room, a
thread, what the room knows — to `tmp/preview/`.

The stub deliberately never answers. A stub that returns plausible values hides
exactly the class of defect a silent bridge causes, which is how the room came to
depend on the native side answering before it would open at all.

This is not the Tauri window: fonts, native chrome and the folder dialog are
still unseen. It is a large step from nothing and it is not the same as somebody
opening the app.

## One turn, without opening the app

```bash
bin/acp-turn meetings "What did we agree with Acme about reporting?"
```

```
session  ses_046bf32f7ffenWwgpDIisRZJZy
channel  # meetings

> What did we agree with Acme about reporting?

  tool   workroom_search_capabilities
  tool   workroom_execute_capability
We agreed to send Acme monthly reporting rollups (first Tuesday of each month),
replacing the weekly reports they found noisy and unread.

stopReason: end_turn
```

Nothing told that session about Acme. It searched the channel's rail, read the
entry, and answered from it — which is the whole idea, in one command, before
any window is opened.

---

## Seeing the idea work

**A turn is already there.** Open `# meetings` before starting anything. There is
a question, the plan the agent followed, and the answer it posted. The steps
between are recorded against the run and are not in the channel — process is
recorded, never pushed.

**Rehydration.** With your agent running, ask:

> @agent what did we agree with Acme about reporting?

Nothing told that session about Acme. The answer comes from the channel's memory,
handed to the session when it opened. Open **What the room knows** to see exactly
what it was given — `•` for what a person stated, `◦` for what an agent inferred.

**The rail.** The agent has two tools, `search_capabilities` and
`execute_capability`, pointed at `/api/rail/meetings`. The channel is in the URL,
so the scope is structural: an agent working in `# meetings` cannot reach
`# marketing`'s memory by asking differently.

**Handoff.** Sign in as `bob@farol.run` in a second window, open the same channel,
and ask a follow-up. Different person, different agent process, different session —
and the work continues, because what the room knows is held by the room.

**The agent decides what to share.** Ask it something worth keeping and it will
call `workroom://memory/remember` itself. Nobody presses a button; there is no
approval queue. A wrong entry is corrected by superseding it.

## What one command does not cover

- **Memory is local unless you bring a context database.** `Memory::Local` backs
  the store by default. To use OpenViking instead, copy `ov.conf.example` to
  `ov.conf`, fill in an embedding credential — the store computes abstracts and
  embeddings, which Article P2 permits server-side and permits for nothing else —
  then:

  ```bash
  docker compose --profile memory up -d openviking
  curl -s -X POST http://127.0.0.1:1933/api/v1/admin/accounts \
    -H "X-API-Key: <root_api_key from ov.conf>" -H "Content-Type: application/json" \
    -d '{"account_id":"workroom","admin_user_id":"workroom-server"}'
  # keep the user_key it returns
  export OPENVIKING_URL=http://127.0.0.1:1933 OPENVIKING_API_KEY=<user_key>
  bin/prototype
  ```

  Nothing else changes: the same channels, the same rail, the same client. What
  changes is that a question finds an entry that shares no words with it.
- **Files stay put.** The session transcript is attached to the run; files an
  agent writes on disk are not collected yet.
- **Sign-in is development-only unless you configure a provider.** OIDC is wired;
  point it at your own and development sign-in closes itself:

  ```bash
  export OIDC_ISSUER=https://your-org.okta.com
  export OIDC_CLIENT_ID=…
  export OIDC_CLIENT_SECRET=…
  export OIDC_REDIRECT_URI=http://127.0.0.1:3000/auth/openid_connect/callback
  ```

  With no issuer set, `/auth/openid_connect` is simply not there. Development
  sign-in — any address, no proof — is on in development and test and off
  everywhere else; `WORKROOM_DEV_SIGNIN=1` forces it on if you really mean it.

  The client asks the workspace how it lets people in, and offers what is there.
  With a provider configured it opens your own browser, your provider answers,
  and the client ends up holding the same bearer token it would have got the
  development way — no token of the provider's reaches it.
