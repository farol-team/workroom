# Spike: how do buzz, openwork, and qm answer the same question WorkRoom answers?

Landscape research, no card. Three external projects were cloned read-only into
`references/` (gitignored) and read end-to-end: **buzz** (`block/buzz`, snapshot
`ac4fa13`, 2026-08-01), **openwork** (`different-ai/openwork`, snapshot
2026-08-01), **qm** (`yc-software/qm`, snapshot 2026-07-31). Two follow-up
spikes go deeper on single axes: `file-sync-landscape.md` and
`memory-landscape.md`.

## The one-paragraph version

All four products react to the same pressure — a team full of AI agents needs a
shared layer — and they disagree about **where the agent runs** and **what the
shared layer holds**. qm centralizes execution (the org's server runs agents
and holds credentials) and gets ambient, always-on agents in exchange. OpenWork
centralizes *capabilities* (skills, plugins, connections through a two-tool MCP
rail) and leaves memory personal. Buzz centralizes *the record* (one signed
Nostr event log) and makes the log itself the memory. WorkRoom centralizes
memory and the record, and defends the opposite pole on execution: local
agents, always.

## What each one is

- **buzz** (Block, Inc.) — a self-hostable team workspace on Nostr: people and
  agents as equal members of rooms, plus a built-in git forge, YAML workflows,
  voice huddles. The furthest along: v0.5.3, packaged releases, production use
  inside Block. Multi-community relay with formally verified tenancy (TLA+,
  Tamarin).
- **openwork** (Different AI) — a desktop control surface for agentic work,
  "open-source alternative to Claude Cowork". The engine is OpenCode; the
  distribution trick is that OpenWork itself is a remote MCP server you add to
  the agent you already have. Enterprise depth unusual for v0.x: SSO/SCIM,
  Helm, air-gapped, managed inference.
- **qm** (yc-software) — a "multiplayer agent harness": one central TypeScript
  core per org, surfaced in Slack and a web app, agents in per-scope durable
  sandboxes (Fly microVMs, AWS Lambda MicroVM, Docker). Early/experimental
  v0.1.x, self-hosted only, unusually candid SECURITY.md.

## The comparison table

| Axis | WorkRoom | buzz | openwork | qm |
|---|---|---|---|---|
| Where the agent runs | Only locally — a defended rule | Local by default; mesh/remote planned | Local or hosted Daytona workers | Only server-side sandboxes |
| Whose agent | Any ACP agent, owner's credentials | Any ACP agent + own `buzz-agent` | One embedded engine (OpenCode) | 4 harnesses behind a custom tool protocol |
| Protocols | ACP + MCP + HTTP/WS, three strict seams | Nostr events + ACP + MCP | MCP only | Custom fixed tool set, not ACP/MCP |
| Shared layer holds | Memory + record, channel-scoped | The signed event log itself | Capabilities (marketplace) | Per-scope memory, files, credentials |
| Memory | Channel context database, trust + provenance | FTS over the log + per-(agent,owner) encrypted engrams | Per-user bank, human-verified writes | Per-scope notebooks, auto LLM extraction |
| Capability rail | One MCP per channel, 2 tools, channel in URL | buzz-cli + MCP; scoping at membership | One MCP, same 2 tool names; scoping by org grants | Self-API; fixed tools |
| Model credentials | Only on the owner's machine | On the operator's machine | BYOK / ChatGPT sign-in; Den can broker | Server-held keychain, plaintext in use |
| Tenancy | One org per deploy, PG row-level security | Multi-tenant relay, formally proven | Org grants + kill switch | One org per deploy, candidly not multi-tenant |
| Maturity | Running prototype | v0.5.x, production at Block | v0.x, ~114k downloads, daily commits | v0.1.x, experimental |

## What this says about WorkRoom's position

- **The two-tool rail is convergent evolution.** openwork ships
  `search_capabilities` / `execute_capability` with the same names. The
  difference is scoping: openwork checks org grants server-side; WorkRoom puts
  the channel in the URL so the scope is structural. Same grammar, different
  enforcement.
- **WorkRoom is the only one holding all three at once**: (1) the agent is
  fully yours and local, (2) memory belongs to the room rather than to an
  agent or a person, (3) capability scope is structural, not policy. buzz
  solves (1) partially and (2) differently (engrams are per agent–owner pair);
  openwork solves (3) differently; qm solves (2) at the cost of (1).
- **qm is the anti-position and the most instructive read.** Its file and
  memory machinery (grants, read-only layers, consolidation passes) is a
  *consequence* of server-side execution and cannot be imported directly — but
  its memory benchmark can, and `memory-landscape.md` argues it should be.
- **buzz shows the cost of breadth.** Chat + forge + automation + voice is a
  relay, Postgres, Redis, MinIO, and an event protocol to operate. WorkRoom's
  three-seam minimalism is a deliberate trade against exactly that.

## Caveats

Snapshots are one day old at research time and all three projects move fast.
Claims about openwork's enterprise tier and qm's sandbox backends come from
their docs and source, not from running them.

## Addendum, 2026-08-09: WorkRoom moved on this spike's headline axis

Nothing about the other three projects has been re-checked; what changed is our
own column. #308 added a hosted execution mode, so three claims above are
superseded and should be read as of 2026-08-01:

- the table's **"Where the agent runs | Only locally — a defended rule"** is now
  *local by default (`users.execution_mode`), hosted when the person chooses it*;
- **"defends the opposite pole on execution: local agents, always"** in the
  one-paragraph version no longer holds;
- **"qm solves (2) at the cost of (1)"** still holds, but the axis it turns on
  has moved.

The position this leaves is arguably stronger than the one the spike described,
and worth stating precisely because it is the comparison a reader came for:
WorkRoom is now the only one of the four that offers **both** placements, and
the distinction from qm shifts from *where the process sits* to *whose key pays
for it*. qm holds a server-side keychain, plaintext in use, for the org. Our
hosted mode holds one credential per user, encrypted at rest, never readable
back, deleted on switching away — the pooled bill and pooled rate limit that
Article P2 exists to prevent are prevented by a unique index rather than by
requiring a laptop. And `qm-sandbox.md`, filed here as the anti-position's
consequence and therefore unimportable, becomes partly live: its trust-boundary
argument (lines 127–133) applies to any server-side execution. The answer #308
gives is that there is nothing to contain — no folder, no shell, no git history,
a capability surface of exactly two rail tools — which holds exactly as long as
the rail runs nothing with effects outside the room. #302/#309 (proposed, not
run) is that condition, and it is the one to keep under test.
