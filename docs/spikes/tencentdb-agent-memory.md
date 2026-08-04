# Spike: TencentDB Agent Memory — the closest premise in the landscape, and how it compares to OpenViking

Follow-up to `memory-landscape.md` (buzz / openwork / qm) and the two OpenViking
spikes. Motivation: TencentDB Agent Memory states WorkRoom's premise almost
verbatim — "new members can load the team's save file on day one" against our
"rehydration instead of session handoff" — which makes it both the nearest
competitor by mission and the sharpest mirror for our differentiation. Second
question, since both sit in the same slot conceptually: could it have been our
context store instead of OpenViking, and what does each enforce?

**Verified against** [`TencentCloud/TencentDB-Agent-Memory`](https://github.com/TencentCloud/TencentDB-Agent-Memory)
as of 2026-08-04 (last push 2026-08-03, 13.4k stars, Team Memory in beta,
v2→v3 migration tooling present). MIT (Tencent's standard wrapper; GitHub's
license detector reports "Other" — the terms are verbatim MIT). Node.js ≥ 22.16.
OpenViking facts below are from our own measured spikes
(`openviking-interface.md`, `openviking-isolation.md`), not re-derived.

## What it is

A team-level **memory hub** for agents: three services (`memory-core`
extraction engine, `memory-hub` web control panel on :8125, `memory-proxy`
agent gateway) plus a `MemoryKnowledge` module, turning conversations, docs,
and code into four governed asset types:

- **Chat Memory** — a server-side async pipeline distills raw conversations
  through layers: L0 conversation → L1 atomic facts → L2 scenario blocks →
  L3 persona/profile. Extraction runs automatically every 5 dialogs; personas
  regenerate every 50 new memories. No human in the write path, no agent in
  the write path either — capture is passive.
- **Skill** — versioned, with resource files, trigger boundaries, validation
  rules; extracted from sessions (reuses Skill code from Nous Research's
  Hermes Agent). Private by default; sharing to the team requires review.
- **Wiki** — docs ingested into LLM-maintained pages with a link graph
  (explicitly citing Karpathy's "LLM Wiki").
- **CodeGraph** — symbols, call relationships, impact paths (built on the
  `colbymchenry/codegraph` OSS project).

Retrieval is pull-on-demand: BM25 + vector + RRF fusion, capped by item
count, character budget, and a recall timeout (skip injection rather than
block). Access is **Fixed Binding + ACL**: each agent gets a curated
"loadout" of assets; visibility is `private` / `team` / `restricted`
(User/Role/Agent ACL) / `agent`; roles are System Admin, Team Admin, Member.
Agent-facing protocol is their own REST (`/v3/tools/list`, `/v3/tools/call`)
plus native plugins for OpenClaw and Hermes; Claude Code and CodeBuddy go
through the proxy. Default store SQLite + sqlite-vec; Tencent Cloud VectorDB
optional. One benchmark published: PersonaMem 48% → 76% with memory enabled.

## Part 1 — versus WorkRoom

| Axis | TencentDB Agent Memory | WorkRoom |
|---|---|---|
| Unit of memory ownership | Asset with an Owner + ACL + per-agent binding | Channel = domain of work; the room owns it |
| Who distills | Server pipeline, automatic (every 5 dialogs / 50 memories) | The agent, end of turn, closing instruction |
| Source of memory | Passive capture of chat logs; import of docs/repos/sessions | Work done in the room; journal → memory → repository via PR |
| Human's role | Reviews skill sharing, manages loadouts in the Hub | Corrects: supersede, trust asymmetry — no gate (P3) |
| Provenance | Owner/version/status per asset; per-entry authorship not surfaced | Mandatory per entry: run, model, author, `trust: human\|agent` |
| Lifecycle | Retention days, vector dedup, conflict detection in pipeline | Supersession only, agent-obligated displacement |
| Where conversation lives | Nowhere — memory layer over other people's agents | The room is the product: channels, run steps, hash-chained journal |
| Inference | Two LLM credential groups server-side (memory + proxy) | Server never holds a model credential (P2, amended for embeddings only) |
| Agent protocol | Own REST + per-framework plugins | ACP + a two-tool MCP rail, agent-agnostic |

Three divergences are structural, not cosmetic:

- **Passive capture vs deliberate writes.** Their pipeline grinds every
  conversation into memory; ours asks the agent "if this turn produced
  nothing the room needs next week, record nothing." Their published
  benchmark is telling: PersonaMem measures memory *about the user*, exactly
  the `soul.md`/persona direction we rejected when we turned off OpenViking's
  own session extraction. Note the asymmetry though: they have *a* benchmark;
  we have none.
- **Loadout vs room.** Equipping assets to agents by hand in a Hub is
  flexible, but it re-creates the configuration sprawl `CONCEPT.md` opens
  with — now the bindings sprawl instead of the dotfiles. Our boundary is
  structural and free: enter the channel, get the channel's memory. Their
  ACL, however, is real enforcement; ours (inside the store) is a stated
  convention.
- **They are infrastructure; we are a place.** Nobody talks to a colleague
  inside their product. Memory there is farmed from captured sessions and
  imported files; memory here is a by-product of visible shared work. These
  are different products with the same slogan.

## Part 2 — TencentDB Agent Memory versus OpenViking

Different classes: OpenViking is a **context store** (a database with
computed tiers, addressed by URI, no UI, no governance); TencentDB is a
**memory product** (pipeline + governance + panel + gateway). The comparison
that matters for us is: what would each look like behind `Memory::Store`?

| Axis | OpenViking 0.4.11 | TencentDB Agent Memory |
|---|---|---|
| Class | Context store / database | Full memory hub (pipeline, panel, proxy) |
| Identity of a record | URI (`viking://…`), filesystem semantics | Asset ID, owner, version, status |
| Layering | L0 abstract / L1 overview / L2 detail, computed per entry on write | L0 conversation → L1 atoms → L2 scenarios → L3 persona, batch pipeline over conversations |
| Distillation | Tiering only — *what* to write stays the caller's decision | The pipeline decides what becomes memory; extraction LLM server-side |
| Retrieval | Semantic search with scores; MCP surface for agents (16 tools) | BM25 + vector + RRF, item/char/timeout caps; REST tools surface |
| Isolation, measured/documented | Account (=workspace) boundary is real (`NOT_FOUND` cross-account); **nothing below it** — any user key reads every channel, `forget` exposed | Sub-team boundaries as a feature: `private`/`team`/`restricted` ACL per asset, roles, per-agent binding |
| Supersession | Our convention via `fs/mv` to `superseded/` | Version/status on assets; vector dedup + conflict detection in pipeline |
| Provenance fields | None native — we encode front matter + sidecar lineage | Owner, version, usage counts native; per-entry run/model attribution absent |
| Server-side model creds | Embedding + VLM (infrastructure inference — the P2 amendment) | Embedding *plus generative extraction* LLMs (two credential groups) |
| Store backend | Local vectordb + AGFS, or remote | SQLite + sqlite-vec, or Tencent Cloud VectorDB |
| License | AGPL-3.0 | MIT |
| Runtime | Python (uvicorn server) | Node.js ≥ 22.16, three services |

The headline: **each enforces exactly what the other lacks.**

- OpenViking gives us URI identity, filesystem semantics (which is what makes
  supersede-by-`fs/mv` possible), per-entry tiering, and a real workspace
  boundary — but cannot express a channel, so our P5 boundary is a prompt
  convention.
- TencentDB's ACL *can* express something channel-shaped (a `restricted`
  asset scope per channel, enforced by the thing holding the data) — the
  exact gap `openviking-isolation.md` measured. But it buys that with
  everything we deliberately refused: the server distills (violating "the
  agent distills, nobody approves" — its extraction LLM is generative
  inference server-side, a larger P2 breach than embeddings), records are
  assets not URIs (no address to supersede by), and capture is passive (the
  chat-log-warehouse failure mode we rejected in the OpenViking
  session-extraction test).

**Verdict: not a store candidate.** It fails the `Memory::Store` contract at
the identity layer (no URI addressing, no supersede-to-`superseded/`
semantics) and at the write-policy layer (its pipeline would distill on its
own schedule regardless of our closing instruction — two distillers, one
memory). It is a competitor to WorkRoom, not an alternative to OpenViking.
The one thing worth stealing from its store design is the *shape* of its
isolation: asset-level ACL below the tenant is what we would ask OpenViking
for, and the revisit condition already written into P5 (a second workspace,
or a channel kept from a colleague's agent) is exactly the point where their
model becomes the reference.

## What to take from this

- **Cold start is their strongest feature and our absent one.** Import of
  existing repos, docs, and past agent sessions turns paid-for learning into
  day-one channel memory. Our channels are born empty and earn value over
  weeks. The most direct candidate to borrow — as rail capabilities feeding
  `remember`, keeping the agent as the distiller of what's imported.
- **Gate the promotion, not the write.** They review skills only when
  visibility rises (private → team). That is compatible with P3 ("corrected,
  not gated"): free writes, but promotion from `personal/` into a channel as
  an explicit act. A cheaper gate than the one we removed, at the boundary
  where it costs least.
- **Knowledge-shape, not knowledge-copy.** Their observation is right that
  agents need link graphs and impact paths, not doc text. Our stance
  ("repos and docs stay where they are — they are sources") can keep both:
  CodeGraph-like *capabilities* on the rail, not assets in the store.
- **Machine dedup covers our named failure mode partially.** Their pipeline
  detects conflicts structurally; our displacement duty lives in a prompt.
  If supersession-based convergence fails the (still unbuilt) memory bench,
  their conflict detection is the mechanism to look at before anything
  heavier.

## Gaps this spike confirms in WorkRoom

- Still no memory-quality benchmark — and now the nearest-premise competitor
  publishes one (PersonaMem), even if it measures the wrong thing for us.
- No cold-start path for a new channel; the competitor treats it as the
  primary onboarding motion.
- Channel boundary inside the context store remains convention-only; the
  competitor's asset ACL demonstrates the enforcement shape we lack
  (`openviking-isolation.md`, P5 revisit condition).
