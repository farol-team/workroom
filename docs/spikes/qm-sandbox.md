# Spike: qm's sandbox technology — how server-side agent execution is built

Follow-up to `landscape-buzz-openwork-qm.md`. Source: `references/qm`
(snapshot 2026-07-31), read-only source reading; qm was not run. Motivation:
qm is the anti-position to WorkRoom's "agents are local, always" — its sandbox
layer is the fullest working example of what server-side agent execution
costs and buys. Worth knowing both to argue the local-execution choice and to
steal the parts that transfer.

Root: `src/sandbox/` (~3.2k lines), wired in `src/wiring.ts:564-632`,
consumed by `src/core/orchestrator/sandboxes.ts` and `src/tools/primitives.ts`.

## The shape of it

One `Sandbox` interface (`src/sandbox/sandbox.ts:131-153`) with required
methods (`profile`, `provision`, `run`, file read/write, `teardown`) and
optional capabilities probed by type guards: blob staging, background process
sessions, computer backup, deep-idle reaping. Missing capabilities throw
`CapabilityUnsupportedError`, reported once per gap. A `SandboxHandle` is a
plain token `{id, rootDir, homeDir, coldStart, env, scratch, backend, scopeId}`;
refcounts live in each backend, and the last teardown parks, stops, or
destroys. A keyed promise-queue serializes provision/teardown per scope so
concurrent turns never double-create a box; there is no global concurrency cap.

A turn lazily provisions up to **four** boxes (`createTurnSandboxes`):

- the **scoped box** — the scope's durable computer, kept warm across turns;
- a **scratch box** — org-global read-only layer only, no credentials,
  destroyed at turn end;
- an **owner-auth box** — for OAuth device flows: owner's keychain
  materialized in, scrubbed after, destroyed with retries;
- **reach boxes** — a box whose rw layer is a *target* scope, for audited
  cross-room work (`reach_exec`).

## The three backends

Selected by `SANDBOX_BACKEND` env; per-scope routing rows (`SandboxRoute`,
cached 15s) exist so migrations can move a scope between substrates.

- **Local Docker** (dev): one container + named `$HOME` volume per scope, exec
  over HTTP to an in-image daemon on `127.0.0.1:0`. `resident_disk`
  persistence; no egress enforcement. Image carries a sha256 fingerprint over
  the Dockerfiles/tools so a stale image warns.
- **Fly Sprites** (production default): one Firecracker microVM per scope; the
  whole disk persists, the VM auto-sleeps when idle. Exec is the Sprites HTTP
  API with a manually parsed multiplexed stream (1=stdout, 2=stderr, 3=rc).
  The only backend with real egress enforcement: the sprite's network policy
  is pinned to a proxy host (written *and read back*, failing on mismatch) and
  per-turn token-bound `HTTPS_PROXY` env is injected. Teardown is a no-op —
  sprites are meant to persist.
- **AWS Lambda MicroVM** (preview API, raw SigV4 REST): one microVM per scope
  with an advisory lock around provision. `snapshot_to_workspace` persistence:
  teardown tars `$HOME` (pruning `.aws`, `.cache`, credential link paths) to
  S3 and suspends; provision hydrates. Hard 8h lifetime, force-rotated at
  7.5h after snapshotting; a leader-leased sweeper snapshots and terminates
  deep-idle VMs. A hard kill between snapshots loses everything since the last
  one — reported, not fatal.

Shared plumbing: exec envelopes with timeouts, abort via `setsid` + pgid
marker kill, background processes as on-disk state dirs under
`$HOME/.agent-proc/<uuid>` with boot-id-based reaping and secret-redacted
listings.

## Provisioning: how the filesystem is assembled

The rw layer is **not materialized** — it *is* the sandbox's persistent disk.
Read-only layers (org/team/granted scopes) are materialized from the host-side
`WorkspaceStore`: every file is hashed into a deterministic sha256 manifest,
and if the manifest inside the sandbox already matches, nothing is copied —
cheap incremental sync with no clock dependency. Read-only-ness is by
convention (a fresh copy per provision), not mount-enforced. Per-turn env
(connector tokens, `AGENT_OUTBOX`) rides on the handle and is exported in
front of every command with a non-interactive prefix.

## Security model, as documented and admitted

Core treats agent + sandbox as *not trusted for authorization*; scope
isolation is the mechanism. Egress has three tiers (none → ip_port → domain);
only Sprites enforces, via the network policy plus an authz sidecar that
verifies a capability token, applies the scope's host policy, hard-blocks
cloud-metadata IPs, and audits every decision. File credentials are ephemeral
by construction: `.aws`, `.netrc`, `.config/gh` are moved to a tmpfs dir and
symlinked back, so snapshots never persist them (`.ssh` and `.git-credentials`
are deliberately durable). The command-policy evaluator is a serious shell
de-obfuscator — it recursively unfolds `sh -c`, `eval`, wrapper chains,
`$()` substitution, pipe-to-shell producers, and `$VAR` indirection before
regex matching — and SECURITY.md still calls it "a speed bump, not a sandbox
boundary." Admitted plainly: sandbox credentials are plaintext while in use,
browser actions bypass command policy and egress, screening is heuristic,
egress enforcement is backend-conditional.

## Persistence, migration, cost

Migration between backends (`sandbox-migrate.ts`) tars + sha256-verifies the
home, rewrites `$HOME` paths in dotfiles and `.git/config` when layouts
differ (`/root` ↔ `/home/sprite`), drops stale `pyvenv.cfg` venvs, takes an
advisory lock, checks for live work, and does a `find -newermt` resync pass
for writes that landed during the copy. Cost control is warm reuse (one
durable box per scope), platform auto-sleep (Sprites), Lambda idle-suspend
plus deep-idle reaping (AWS), and sweeps: turn dirs > 24h, blob staging TTLs,
orphaned background processes. No warm pools — a scope's first turn pays full
cold start, surfaced to the user as "Creating the sandbox…".

## What transfers to a local-execution product (and what does not)

Transfers:

- **Capability-probed interface** with once-per-gap capability errors — maps
  onto "whatever the user's local ACP agent supports."
- **Keyed per-scope queues + handle refcounting** (~22 lines) — exactly what
  per-(user, agent, channel) sessions need.
- **Hash-manifest materialization** — deterministic sha256 over path+content,
  skip-if-unchanged; directly reusable for shipping channel/org context into a
  local agent's derived working directory.
- **Migration copy with sha verification + home-path translation** — what a
  moved working directory between machines needs.
- **Shell-level tricks**: non-interactive env prefix, pgid-marker killable
  exec, background processes as on-disk state dirs.
- **Credential hygiene**: ephemeral credential dir + symlink indirection so
  secrets never land in the persisted tree; prune lists at snapshot time;
  redacted command listings.
- **The command-policy de-obfuscator** — runtime-independent; could front any
  local exec gate.

Does not transfer:

- **The sandbox as trust boundary** — with local agents there is no
  server-side isolation to defend; the agent already has the user's ambient
  authority (Article P2 by design). Backends, per-scope volumes, egress
  enforcement all answer a problem local execution doesn't have.
- **Snapshot/hydrate and idle reaping** — exist to rent server compute per
  scope; locally "reaping" is the user closing the laptop.
- **Egress proxy + capability tokens** — forcing a local agent's traffic
  through a control-plane proxy means MITM-ing the user's machine.
- **Server-mediated blob staging** — locally, files are already local.
- **The four-box taxonomy** (scratch / owner-auth / reach) — answers a
  server-side multi-tenant isolation problem.

## The honest takeaway

qm's sandbox layer is roughly 3.2k lines of substrate plus an orchestrator
taxonomy, a migration runner, an egress sidecar, and a security-posture system
— and its own SECURITY.md still lists plaintext-in-use credentials and a
bypassable command policy as known limitations. That is the price of
centralized execution, paid continuously. WorkRoom's local-execution rule
declines the entire bill; the transferable parts are the small, pure ones:
queues, manifests, path translation, credential hygiene.
