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

The client starts an agent for you, but the agent runs on your machine under
**your** credentials — that is the point of the design, not a limitation of the
prototype. Install and authenticate it once:

```bash
npm i -g opencode-ai
opencode auth login
```

Then press **Start agent**. Any agent that speaks ACP works; pass a different
command to `agent_start`.

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

- **Memory is local.** `Memory::Local` backs the store; the OpenViking adapter
  behind the same seam needs an embedding credential.
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

  The desktop client still signs in the development way. Carrying the browser
  round trip into the client is its own card.
