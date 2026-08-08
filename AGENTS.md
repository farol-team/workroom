# AGENTS.md

Guidance for AI coding agents working in this repository. For the design
document about *product* agents (local agents, sessions, rehydration), see
`docs/AGENTS.md` — that file is about the product, this one is about working
on it.

## Project overview

**WorkRoom** is a shared workspace where every person brings their own local
agent, and the room remembers. Channels are domains of work (`meetings`,
`marketing`, `support`). Each person works in a channel alongside their own
agent running on their own machine; a colleague joining the same channel with
*their* agent continues where others stopped, because what the room knows is
held by the room, not by anyone's agent.

Status: a running prototype. `bin/prototype` brings the whole thing up.

One repository, two deployables, because nearly every change crosses the seam
between them:

```
server/     Rails — API, WebSocket, capability rail, admin
desktop/    Tauri — desktop client, manages the local agent over ACP
docs/       documentation (concept, architecture, memory, rail, data model, …)
bin/        repository-level scripts (prototype, preview, kit verification)
```

Release tags are prefixed: `server-v*` and `desktop-v*`.

## Runtime architecture

Three protocols hold the system together; nothing crosses a seam except
through them. This is the one architectural rule worth defending strictly.

| Protocol | Between | Carries |
|---|---|---|
| **ACP** | desktop ↔ local agent | control — who does the work |
| **MCP** | agent ↔ capability rail, agent ↔ context database | capability — what can be done |
| **HTTP / WebSocket** | client ↔ server | record — what happened |

Load-bearing design rules to keep in mind when changing code:

- **Agents are local, always.** The server never executes an agent, never sees
  a model credential. Each agent runs under its owner's credentials on their
  machine ("Article P2" of `.claude/constitution.md`).
- **One session per (user, agent, channel) triple.** Memory scope is the
  channel's scope; rehydration happens at session start.
- **Scope is structural.** The capability rail is one MCP endpoint per
  channel (`POST /api/v1/rail/:slug`) exposing exactly two tools
  (`search_capabilities`, `execute_capability`). The channel is in the URL, so
  an agent cannot reach another room by asking differently.
- **Workspaces are isolated by PostgreSQL row-level security**, not by
  application checks. `schema.rb` cannot describe a policy, so the boundary
  must be applied explicitly (`bin/rails db:boundary`) to any database loaded
  from the schema. `server/app/models/workspace/boundary.rb` owns this.
- **The API is versioned** (`/api/v1/…`). Old desktop clients exist by design;
  do not change a response shape under an existing version.
- **Attribution**: a message written by an agent is attributed to the run,
  not to the person.

## Stack

| | |
|---|---|
| Server | Ruby on Rails 8.1.3.1 on Ruby 3.4.10 (`.ruby-version` is the source of truth) |
| Realtime / Jobs / Cache | Solid Cable / Solid Queue / Solid Cache — no Redis |
| Artifacts | Active Storage → S3-compatible |
| Identity | OmniAuth (OIDC); development sign-in exists only in development/test |
| Database | PostgreSQL 17 (local dev binds **5433**, not 5432) |
| Desktop frontend | TypeScript (strict) + Vite 8, pnpm 11.18.0, Node 24 |
| Desktop bridge | Rust, Tauri 2 (`desktop/src-tauri`) |
| ACP itself | [`farol-team/acp-agents`](https://github.com/farol-team/acp-agents) — `acp-client` (spawn, JSON-RPC, sessions, process groups) and `acp-agents` (which agents speak ACP, and where their binaries are), pinned by tag and shared with OpenTag and gilb. A protocol-level fix belongs there, with its spec; the bridge keeps a window's bookkeeping |
| Local agent | any ACP-speaking agent; the Claude adapter (`@agentclientprotocol/claude-agent-acp`) is pinned in `desktop/package.json` and ships in the bundle |
| Context database | OpenViking (optional; `Memory::Local` on PostgreSQL is the default) |

Requirements for local development: Ruby 3.4.10, Node 24, pnpm, Docker (for
Postgres). If Postgres already runs elsewhere, set `DATABASE_URL` and
`bin/prototype` uses it instead of Docker.

## Build and test commands

### Server (`server/`)

```bash
bin/setup --skip-server     # install dependencies
bin/rails test              # the test suite (Minitest)
bin/ci                      # full CI: setup, rubocop, bundler-audit, importmap audit,
                            # brakeman, tests, seed replant
bin/rubocop                 # style
bin/brakeman                # security static analysis
```

`bin/rails db:boundary` applies the row-level security policies; run it after
loading a database from the schema (CI does this; `test/test_helper.rb`
applies the boundary itself before anything is measured).

`bin/rails record:verify` replays every room's journal against the object
store, and `bin/rails record:export[slug,path]` mirrors one room's journal
into a git repository at `path`. Both are read-only against the server, so
they are safe to run against any database you can connect to (the record
store itself is in `docs/DATA-MODEL.md`).

### Desktop (`desktop/`)

```bash
pnpm install --frozen-lockfile
pnpm test                   # vitest (happy-dom), tests in test/**/*.test.ts
pnpm exec tsc --noEmit      # typecheck
pnpm build                  # tsc && vite build
pnpm tauri dev              # run the app against a running server
```

In `desktop/src-tauri` (the Rust bridge — CI compiles it on every change):

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`pnpm bench:capabilities` asks the bundled agent what it says about itself and
regenerates the measured-capabilities table in `docs/AGENTS.md` — never edit
that table by hand. `pnpm bench:turn` drives one real turn against a real
model; it is deliberately not in CI (it costs a model call and needs a
credential that stays on a person's machine).

### Whole prototype

```bash
bin/prototype               # Postgres (Docker), schema, seeded room, server on :3000
bin/preview                 # renders built client states to tmp/preview/ without a window
bin/acp-turn meetings "…"   # one agent turn from the shell, no window
```

Sign in as `alice@farol.run`; development sign-in creates the account on the
spot. The OpenViking context database is opt-in:
`docker compose --profile memory up -d openviking` (needs `ov.conf` — see
`ov.conf.example` and `docs/RUNNING.md`). Without it the memory store is
PostgreSQL and nothing external is required. RUNNING.md also documents a
no-credential path through a local Ollama.

## How this repository is developed

Every change goes through [agent-flow](https://github.com/farol-team/agent-flow)
(`CONTRIBUTING.md`). Three of its rules are checked by CI and fail the build:

1. **A card exists** as a GitHub issue, with a `[meta] PLAN` comment agreed
   before any code.
2. **The branch names it** — `flow/i<card>-<slug>`, e.g. `flow/i89-kit-required`.
3. **The test comes first.** Where the TDD gate applies, a surviving mutation
   is a hole in the tests, not proof of coverage.
4. **The pull request carries a `## Gates` section** — what was run and what
   it said, not a claim that it passed.
5. Acceptance is audited against the card before merge.

### The workflow kit (`.claude/`)

`.claude/{commands,prompts,hooks,bin,providers}` are **owned upstream** by
`farol-team/agent-flow` and synced with `rsync --delete` via
`bin/workflow-kit-sync`. **Anything edited in those directories is deleted by
the next sync, with no diff to notice it by.** If a kit file needs to change,
send it upstream or move the file out of the kit-owned trees.

Project-owned, never touched by a sync: `.claude/constitution.md`,
`.claude/tracker.json`, `.claude/learnings.jsonl`, `.claude/CONVENTIONS.md`.
The verification tools live in `bin/` (not `.claude/bin/`) for the same
reason — a check the sync can delete is not a check. CI's `kit-intact` job
verifies the kit matches `.claude/KIT_REVISION` and self-tests that the check
can go red.

### Attribution conventions

From `.claude/CONVENTIONS.md`:

- GitHub-facing flow output (issues, comments, PR bodies) is published by the
  **`ori-cofounder`** account, never a human's account. Its token is passed
  per invocation (`GH_TOKEN=$(cat "$TOKEN_PATH") gh …`), never stored in git
  config or versioned files.
- Commits stay under the human whose machine ran the work, with a
  `Co-Authored-By:` trailer.
- Every flow-written body ends with `— Farol AI Agent Flow`. Angle-bracket
  forms do not survive GitHub's markdown sanitizer.

## Code style

- **Ruby**: `rubocop-rails-omakase` plus `rubocop-minitest` (the omakase
  bundle has no test-aware cops). Standard Rails 8 layout.
- **TypeScript**: `strict` with `noUnusedLocals`/`noUnusedParameters`; ESM;
  no framework — the frontend is plain TS in `desktop/src/` (`main.ts`,
  `agent.ts`, `api.ts`, `rules.ts`, `settings.ts`, `onboarding.ts`,
  `agents/catalog.ts`).
- **Rust**: `cargo fmt` and `clippy -D warnings` are CI gates.
- **Comments explain why, not what.** The house style is a short essay in
  the comment — the reasoning, the trade accepted, and often the issue number
  that decided it (`#120`, `#94`, `#138`). Tables and code blocks carry
  comments the same way. Follow that pattern rather than narrating mechanics.
- Comments and documentation are in English.

## Desktop UI patterns

The UI guide is `.claude/prompts/ui-design.md` (project-owned — the kit sync
explicitly excludes it; the flow reads it before any frontend PLAN). Its
short version:

- **Every dialog is the same shape**: labelled rows, dark fields filling the
  row, actions right-aligned in the `menu`.
- **Messages are Slack rows**: 36px avatar, head line (name, agent badge,
  time), body under it; process indents to the body column.
- **A picker with one option is hidden, not disabled.**
- **Look before you ship** — a UI change is not done until its `bin/preview`
  screenshots have been seen, not just its tests run.

## Testing

- **Server**: Minitest (`server/test/`, mirroring `app/`). `test_helper.rb`
  provides the `Build` module (`workspace`, `user`, `channel`, `session_for`,
  `agent_run`, …) and enters a workspace in `setup` — a record created with no
  workspace in scope is treated as a bug, and fixture setup uses
  `Build.as_the_owner` to bypass the row-level policy being measured.
  Integration tests authenticate with a membership's bearer token
  (`auth(user)`). Use the `broadcasts(channel)` helper to assert on Action
  Cable output instead of stubbing it away. Tests run with
  `parallelize(workers: 1)` and need no external service.
- **Desktop**: Vitest with happy-dom, specs in `desktop/test/*.test.ts`.
- **`desktop/test-agent/agent.mjs`** is a scripted fake agent for exercising
  the ACP bridge without a model.
- End-to-end verification against a real agent is a manual bench
  (`pnpm bench:turn`), not CI, by design.

## CI and deployment

Workflows in `.github/workflows/`:

| Workflow | What it does |
|---|---|
| `server.yml` | Postgres service, brakeman, bundler-audit, rubocop, `db:prepare` + `db:boundary`, `bin/rails test`. Path-filtered work, but the `server-ci` aggregate job always reports (`skipped` passes). |
| `desktop.yml` | `pnpm audit signatures`, agent bench, vitest, typecheck, vite build; a `bridge` job runs cargo fmt/clippy/test plus `cargo-deny` on the Rust side. Full bundles only on tags/manual dispatch. |
| `flow.yml` | `kit-intact`, `branch-has-card`, `pr-carries-evidence` (see above). |
| `deploy.yml` | Kamal deploy on push to `main` touching `server/**` — but only when the `WORKROOM_REGISTRY_ID` variable is set; otherwise it deploys nowhere. One deploy at a time, never cancelled in flight. |

Deployment is Kamal to a single machine (`server/config/deploy.yml`,
`docs/DEPLOYING.md`): one container, an **already-existing** managed
PostgreSQL (the deploy must never create, migrate or destroy that cluster —
production needs both `workroom_production` and `workroom_production_cable`
databases), S3-compatible storage for artifacts. Secrets are named in
`.kamal/secrets` and supplied from the environment of whoever deploys.

Desktop releases are signed tags: `git tag desktop-v0.2.0 && git push --tags`.
The updater verifies updates against a public key compiled into the app
(`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`); the private key
lives only in Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`) and is never in
this repository.

## Security considerations

- **Never commit credentials.** `ov.conf` is gitignored (it carries an
  infrastructure model credential); use `ov.conf.example` as the template.
- **The server holds no model credentials by design** — do not add code paths
  that move agent credentials server-side. The one permitted server-side
  inference is the context database computing abstracts/embeddings.
- **Development sign-in** (any address, no proof) is enabled in development
  and test only; `WORKROOM_DEV_SIGNIN=1` forces it on elsewhere, which should
  give you pause. With no `OIDC_ISSUER` configured, `/auth/openid_connect`
  does not exist.
- **The workspace boundary is enforced by PostgreSQL row-level security.**
  Any test or migration that loads from `schema.rb` must re-apply
  `bin/rails db:boundary` before trusting isolation.
- **Rail scope is structural** (channel in the URL). The agent's OpenViking
  key reaches every channel of its workspace, and the agent is only *asked* in
  its prompt to stay inside its channel's subtree — nothing enforces it, and
  no server code may be written as though something did
  (`docs/ARCHITECTURE.md`).
- **Session working directories are derived, never chosen by the agent**; a
  channel slug that looks like a path must not become one. Artifact offers
  skip hidden entries (`.git`, `.env`) and, in a git repository, defer to
  `git status` so ignored build output never floods the offer.
- **The updater is a code-execution surface**: updates are signed and
  verified, and the app never installs one without being asked.
- `pnpm audit signatures`, `bundler-audit`, `brakeman`, and `cargo-deny`
  (advisories + licences) all run in CI — keep them green.

## Documentation map

`docs/` is the design record and is kept current; update it when you change
what it describes:

- `CONCEPT.md` — the problem, the idea, and what this deliberately is not
- `ARCHITECTURE.md` — components, seams, deliberate omissions
- `AGENTS.md` — local agents, sessions, runs, rehydration, artifacts (product doc)
- `MEMORY.md` — channel scopes, tiers, promotion, feedback loop
- `RAIL.md` — the capability rail: two tools, discovery, execution modes
- `DATA-MODEL.md` — tables and the reasoning behind each
- `RUNNING.md` / `DEPLOYING.md` — how to run it / how to ship it
- `ROADMAP.md`, `spikes/` — what gets built next; research notes
