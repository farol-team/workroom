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

**A turn is already there.** Open `# marketing` before starting anything. There is
a question, the plan the agent followed, and the answer it posted. The steps
between are recorded against the run and are not in the channel — process is
recorded, never pushed.

**Rehydration.** With your agent running, open `# meetings` and ask:

> @agent what did we agree with Acme about reporting?

Nothing told that session about Acme. The answer comes from the channel's memory,
handed to the session when it opened. Open **What the room knows** to see exactly
what it was given — `•` for what a person stated, `◦` for what an agent inferred.

**The rail.** The agent has two tools, `search_capabilities` and
`execute_capability`, pointed at `/api/v1/rail/meetings`. The channel is in the URL,
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
  docker compose --profile memory build openviking
  docker compose --profile memory up -d openviking
  curl -s -X POST http://127.0.0.1:1933/api/v1/admin/accounts \
    -H "X-API-Key: <root_api_key from ov.conf>" -H "Content-Type: application/json" \
    -d '{"account_id":"workroom","admin_user_id":"workroom-server"}'
  # keep the user_key it returns
  export OPENVIKING_URL=http://127.0.0.1:1933 OPENVIKING_API_KEY=<user_key>
  bin/prototype
  ```

  The image is built once and then starts in seconds — the `pip install` used to
  run on every container start; now it runs at `docker compose build` time, and
  the OpenViking version pin lives in `docker/openviking/Dockerfile`.

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

## Memory, locally, with no credentials

The context database above asks for an embedding credential. If you would rather
not hand one out, Ollama serves the same models from your own machine, and the
memory store cannot tell the difference.

```bash
brew install ollama   # or https://ollama.com
ollama pull nomic-embed-text qwen3:4b
cp ov.conf.ollama.example ov.conf
docker compose --profile memory up -d openviking
```

`ov.conf.ollama.example` points both the embedder (`nomic-embed-text`) and the
VLM (`qwen3:4b`) at the Ollama on the host — `host.docker.internal` is how the
container reaches it. Two things in that file look wrong and are not: `api_key`
is a placeholder because OpenViking requires the field even when Ollama ignores
it, and the VLM's `api_base` has no `/v1` suffix because it speaks Ollama's
native API, where the suffix is a 404.

Then give the workspace its own account in the store:

```bash
bin/rails workspace:provision WORKSPACE=workroom \
  OPENVIKING_URL=http://127.0.0.1:1933 OPENVIKING_ROOT_KEY=change-me
```

(`change-me` is the `root_api_key` placeholder in the example config — use
whatever you put there.) The live-gated memory tests run against this setup too:

```bash
OPENVIKING_URL=http://127.0.0.1:1933 \
OPENVIKING_API_KEY=$(bin/rails runner 'print Workspace.find_by(slug: "workroom").openviking_api_key') \
  bin/rails test test/services/memory/open_viking_test.rb
```

## Releasing, and how an update reaches people

The client checks for a newer release, says so, and installs when somebody asks
it to. It never installs on its own: a workspace that can replace its own binary
without being asked is a thing people are right to distrust.

**Updates are signed, and the app verifies them against a key compiled into it.**
Without that, an update endpoint is a remote code execution feature with a
friendly name. The keypair is not in this repository and is not created by it —
whoever holds the private key can ship code to every install, so making one is a
deliberate act:

```bash
cd desktop && pnpm tauri signer generate -w ~/.workroom/updater.key
```

The public half goes in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
The private half goes in the repository's Actions secrets as
`TAURI_SIGNING_PRIVATE_KEY` (and its password), and nowhere else.

Then a release is a tag:

```bash
git tag desktop-v0.2.0 && git push --tags
```

which builds the bundles for each platform and publishes `latest.json` beside
them — the manifest the client reads.

### When the client and the workspace disagree

They ship together and drift apart. A client a version behind its workspace does
not fail loudly; it quietly does nothing where a feature used to be, which is the
most expensive kind of failure. So each says what it is, and the client says
plainly when they no longer match — while ignoring a patch-level difference,
because saying it every launch teaches people to ignore the one that matters.
