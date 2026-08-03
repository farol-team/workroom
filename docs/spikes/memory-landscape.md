# Spike: how do buzz, openwork, and qm save the result of an agent's work into memory?

Follow-up to `landscape-buzz-openwork-qm.md`, same sources and snapshots.
Motivation: memory is WorkRoom's core premise ("the organization pays
repeatedly for knowledge it already bought"), so this is the axis where the
class comparison matters most. Verified against WorkRoom's own code, not just
docs — which surfaced a real drift, below.

## Finding zero: our own docs describe a memory pipeline that no longer exists

The "background job proposes, a person approves" promotion gate was built
(`20260730120009_create_promotions.rb`) and removed one day later
(`20260731110002_drop_promotions.rb`, #22/#24; constitution P3 amended
2026-07-31 to "Memory is corrected, not gated"). Still describing the old gate
as of this writing: `docs/ARCHITECTURE.md:65-66` (flow step 9),
`docs/CONCEPT.md:64-66`, `README.md:37`, the comment in
`server/app/controllers/api/v1/memory_controller.rb:12`, and the `promotions`
node in the `docs/DATA-MODEL.md:11` diagram. Worth a cleanup card on its own.

## The four answers to "who decides what gets remembered"

- **qm — fully automatic.** After every turn (burst-buffered: 180s quiet or 10
  turns) a one-shot LLM pass extracts facts into a per-scope markdown notebook
  (personal / channel / team / org / group; `MAX_FACTS = 300`, recall tail-capped
  at 6,000 chars). Strict provenance rules: a preference counts only if the
  *user's own message* states it, second-hand claims are rewritten as
  `[claimed source: …]`, channel facts are cc'd to the speaker's personal
  notebook with a `(said in …)` tag. Every 10 new facts trigger an LLM
  consolidation pass (UPDATE/DELETE/ADD); a `scratch-promote` strategy adds a
  two-tier flow with 14-day scratch logs. Postgres keeps full revision history.
- **WorkRoom — the agent distills, nobody approves.** A closing instruction on
  every prompt asks the agent to record what the room should know next week, or
  keep nothing. The write goes through the channel rail with mandatory
  provenance (run, model, author) and `trust: agent|human`; retrieval ranks
  human above agent and renders the distinction (`•`/`◦`). Correction is by
  supersession only; nothing is edited or deleted. Push rehydration (≤20 L1
  entries) on every turn, pull via the rail's two tools.
- **buzz — the agent decides, the log is the shared layer.** Room knowledge is
  the signed event log itself (Postgres FTS, tsvector + GIN — the row write *is*
  the index update). Agent memory is NIP-AE engrams: addressable `kind:30174`
  events, NIP-44-encrypted to the agent↔owner pair (owner can always read,
  cannot write), one auto-injected `core` record plus cold `mem/<slug>` entries.
  Discipline is prompt-level; NIP-AE explicitly declines to solve truthfulness.
- **openwork — the human verifies every write.** User asks, agent drafts
  content + citations, human confirms, `postMemory` executes through the rail.
  Per-user MySQL bank (FULLTEXT; `scope='org'` schema-ready but inactive).
  Deliberately no auto-recall: "the honest value bar is saved facts are
  retrievable across sessions, not 'the agent never makes you re-explain'."

## Comparison

| Axis | WorkRoom | qm | openwork | buzz |
|---|---|---|---|---|
| Who distills | The agent, end of turn | Background LLM pass | Agent drafts, human confirms | The agent, own discipline |
| Human in the write path | No (gate removed #22) | No | **Every write** | No |
| Scope | Channel (shared) | person/channel/team/org | User (personal) | (agent, owner) pair |
| Store | PG or OpenViking (embeddings) | Markdown / PG revisions | MySQL FULLTEXT | Encrypted Nostr events + FTS |
| Rehydration | Push every turn + pull by URI | Auto-inject every turn | Explicit search only | `core` at session start |
| Lifecycle | Supersession only | LLM consolidation, scratch→promote, revisions | Delete-only | Nostr replacement, tombstones |
| Provenance | Mandatory: run, model, trust | `(said in …)`, anti-inference rules | Citation contexts | Cryptographic signatures |
| Quality control | Trust asymmetry + contract tests | **LLM-judged benchmark with floors** | Human verification | Prompt discipline; poisoning = "implementer's problem" |

## What to take from this

- **qm's memory benchmark is the standout mechanism in the class, and it is
  portable.** `scripts/memory-bench.ts` replays scripted conversations through
  a write strategy and has an LLM judge score the notebook 0–10 on
  signalToNoise / staleness / inferenceVsObservation, with regression floors.
  WorkRoom's premise ("an agent with the room's memory performs visibly
  better") is explicitly unproven (ROADMAP stage 3) and our named failure mode
  — a wrong inference that "corroborates itself, and within a month is
  unarguable" (`docs/MEMORY.md:94-96`) — has no test. A bench in this shape is
  how supersession-based convergence gets measured instead of asserted.
- **qm's scratch→promote is the working middle path** between our removed
  human gate and fully automatic capture: draft logs accumulate freely, an LLM
  pass graduates durable facts into the curated notebook, drafts age out in 14
  days. If direct agent writes ever prove too noisy, this is the design to
  steal before rebuilding a human queue.
- **openwork is the counter-argument to auto-capture, honestly made.** Their
  v0 refuses semantic recall, auto-recall, and shared org memory — and says so
  in the doc. Human-verified writes do not scale, but they never silently rot.
  Our trust asymmetry + mandatory provenance is the bet that you can keep
  rot-resistance without the human in the path; that bet is currently untested.
- **buzz marks the limit of social provenance.** Our provenance is attribution
  you can audit; theirs is attribution you can verify. NIP-AE also shows the
  cost: memory scoped to an (agent, owner) pair leaves with the pair —
  channel-owned memory remains WorkRoom's real differentiator.

## Gaps this spike confirms in WorkRoom

- No expiry/decay/consolidation — `docs/MEMORY.md:109-111` requires designed
  forgetting; only supersession is implemented.
- No memory-quality eval harness of any kind.
- Rail-scoped writes are structural, but a directly-mounted OpenViking key
  bypasses the rail's provenance, trust marking, and supersede-by-URI
  conventions (and exposes `forget`) — accepted MVP risk, measured in
  `openviking-isolation.md`.
- Agent-originated rail writes are not Activity-logged; their audit trail is
  the run record.
