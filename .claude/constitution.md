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

### Article P3 — Memory is corrected, not gated
*(Rationale: amended 2026-07-31. The article previously required a human to
approve every entry. In practice that spends the attention the product exists to
protect — a knowledge base that must be curated does not get curated, and the
person is here to work, not to review. The risk it guarded against is real, so
it is answered by making correction cheap rather than by making writing
expensive.)*

An agent writes to its channel's memory directly. No approval step, no queue, no
human in the path.

Three properties make that safe, and none of them costs a person anything:

1. **Provenance is mandatory.** Every entry records the run it came from and
   whose agent produced it (Article P4). An entry nobody can trace is a defect.
2. **Correction is by superseding.** Entries are never edited or deleted;
   a correction is a new entry that supersedes the old one, and the history
   stays readable (Article P6).
3. **An agent that finds a contradiction resolves it.** On encountering memory
   that its current work contradicts, an agent supersedes the stale entry rather
   than adding a second, conflicting one. This is what replaces the human gate:
   the system converges instead of accumulating.

A person may supersede any entry at any time. That is a correction they chose to
make, not a step they were required to take.

**Out of scope of this article:** organization-wide memory that crosses channels
(`viking://org/`). Nothing writes there yet, and an error that escapes one
channel has a different blast radius. When something does write there, it gets
its own article.

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

### Article D1 — One ACP session per (user, agent, channel)
*(Rationale: it is what makes the memory scope and the session scope the same
thing without enforcement.)*

Sessions are keyed by channel and by the agent that opened it. A second session
for the same pair in one client is a bug, not an optimization.

*Amended:* the agent was added to the key when a person could hold more than one.
Keyed by channel alone, two agents in one room share a session id — the second
one to speak inherits the first one's session, or is handed an id its process has
never heard of. Memory still belongs to the channel, so switching agents loses
nothing: what the room knows is pushed into whichever one is summoned.

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
