# Constitution

Non-negotiable engineering articles for WorkRoom. Every PLAN is validated
against these articles BEFORE work starts (`## Constitution gate` — one verdict
per article: `pass` / `n/a` / `violates — <justification>`), and the acceptance
check re-validates the actual DIFF after.

Amendment procedure: articles are added or changed by PR only, each with a
one-line rationale citing the decision that motivated it. Articles are numbered
and never renumbered — retired articles are marked `(retired)`, not deleted.

---

## Universal articles

### Article I — Test-First
No production code before a failing test that demands it. The RED phase counts
only when the test fails **for the right reason** — the feature is missing, not
a typo or broken setup. Tests are committed separately and before the
implementation. Tests assert BEHAVIOR, not implementation details. A test that
would still pass if the feature body were replaced with `return nil` is not a
test.

### Article II — Evidence Before Claims
No completion claims without fresh verification evidence. "Done", "fixed",
"passing" require actual command output from THIS session. Banned as
substitutes: "should work", "probably", "I'm confident", "seems to".

### Article III — Simplicity & Anti-Abstraction
Use the framework directly; do not wrap it. No abstraction until the second
concrete use exists. The minimal diff that satisfies the plan wins. Do not add
error handling for scenarios that cannot happen.

### Article IV — Scope Discipline
Only the files in the PLAN's `## Files`; `## Out of scope` is inviolable. If
reality contradicts the plan mid-work — BLOCKED, not improvisation.

### Article V — Integration-First Testing
Prefer realistic environments: the real database over mocks, the actual adapter
over stubs. Mock only at true process boundaries — external HTTP APIs, paid
services, the clock.

---

## Project articles (all targets)

### Article P1 — The three seams are the only crossings
*(Rationale: docs/ARCHITECTURE.md — the moment a layer bypasses a seam the stack
stops being replaceable, which is the entire reason it is layered.)*

Control crosses as **ACP**, capability as **MCP**, record as **HTTP/WebSocket**.
No component reaches past a boundary by another route — no direct HTTP client
from the agent to the context store, no SQL from the desktop.

### Article P2 — Agent inference is paid for by the person
*(Rationale: a central credential for agent work would recreate the shared bill
and the shared rate limit the design exists to avoid. Amended 2026-07-31: the
context store computes tiers and embeddings and cannot do so per user, because
what one person's agent writes another person's agent later reads.)*

Two categories, and only the first is forbidden to the server.

**Agent inference** — the model that answers a turn. Its API keys, provider
tokens and agent auth live on the user's machine and never reach the server, its
configuration, its database, or a server-side proxy. The server records token
**counts** as reporting, never as billing.

**Infrastructure inference** — embedding and tiering performed by the context
store on the organization's shared knowledge. This is workspace-level, not
per-user, and the credential is held by whoever operates the workspace: the
customer's own key when self-hosted, the provider's when the workspace is
supplied on-premise. Permitted server-side, and permitted **only** for embedding
and tiering — an infrastructure credential used to answer a turn is a violation
of the first paragraph, not an exception to it.

### Article P3 — Promotion into shared memory is an explicit act
*(Rationale: docs/MEMORY.md — undisciplined promotion makes the system amplify
its own errors until a wrong inference is unarguable.)*

Distillation may only **propose** (`Promotion` in state `proposed`). Writing to
a channel's memory requires either a human approval transition or a deliberate
human-authored write. No code path may create an applied promotion or a memory
entry directly from agent output.

### Article P4 — Memory carries provenance and trust
*(Rationale: an unattributed claim cannot be audited, and unauditable memory
rots silently.)*

Every `MemoryEntry` records what it came from (`source`) and who produced it
(`author`), and is marked `human` or `agent` in `trust`. Retrieval must preserve
the distinction — never flatten the two into one undifferentiated list.

### Article P5 — The channel is the scope
*(Rationale: one concept serves as memory scope, permission boundary, retrieval
scope, and unit of conversation; splitting them means reconciling four models of
who can see what.)*

Memory, permissions, retrieval, and agent sessions are scoped by channel.
Cross-channel reads and any write to `viking://org/` are separate, explicit
operations — never a side effect of working in a channel.

### Article P6 — Append-only tables are never updated
*(Rationale: `activities` and `run_steps` are the audit surface; a mutable audit
log is not one.)*

`Activity` and `RunStep` rows are created and never modified or destroyed
outside a channel cascade. `MemoryEntry` is corrected by superseding, not by
editing history.

---

## Project articles (server)

### Article S1 — The context store is reached only through `Memory::Store`
*(Rationale: the local implementation is a stand-in for an external context
database; a direct `MemoryEntry` query in a controller is a call site that will
have to be found and rewritten later.)*

Controllers, jobs, and views go through `Memory::Store.current`. Direct
`MemoryEntry` access is confined to `app/services/memory/`.

### Article S2 — Broadcast on every state change the room can see
*(Rationale: run steps are why a minutes-long turn is legible rather than
silent; a change that reaches the database but not the socket is invisible.)*

Anything that changes what a channel displays — messages, run status, steps —
is published through `Broadcast` in the same request that persists it.

---

## Project articles (desktop)

### Article D1 — One ACP session per (user, channel)
*(Rationale: it is what makes the memory scope and the session scope the same
thing without enforcement.)*

Sessions are keyed by channel. A second session for the same channel in one
client is a bug, not an optimization.

### Article D2 — The agent is a child process, never a service
*(Rationale: local execution is the mechanism behind Article P2; a hosted agent
would need delegated credentials.)*

The client spawns and owns the agent process. No code path may point the client
at a remote agent endpoint that the user does not control.

### Article D3 — Artifacts belong to the channel
*(Rationale: docs/AGENTS.md — work left on one laptop makes the channel a
discussion of work rather than a record of it.)*

Files an agent produces are uploaded to the channel. A feature that leaves
output only in the local working directory is incomplete.
