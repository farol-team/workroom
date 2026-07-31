# Spike: how WorkRoom talks to OpenViking

Research deliverable for #1. Establishes transport, deployment shape, and the
one constitutional question the epic cannot decide on its own.

**Verified against** [`volcengine/OpenViking`](https://github.com/volcengine/OpenViking)
v0.4.11 — PyPI `openviking` 0.4.11 (author ByteDance, Repository field points at
that repo, uploaded 2026-07-23, matching the `v0.4.11` GitHub release the same
day). AGPL-3.0.

## Transport: HTTP, first-party

The package ships an `openviking-server` entry point — "OpenViking HTTP Server",
uvicorn-based, with `--host`, `--port`, `--workers`, and `--config`. There is no
need for a Python sidecar of our own, and no CLI shelling.

This satisfies Article P1 directly: record crosses as HTTP, the adapter is the
only component that speaks to the store.

```
Rails ──HTTP──> openviking-server ──> local vector store + AGFS
```

Also present but not our path: `ov` (CLI), `vikingbot` (chat gateway), a
LangChain integration, and MCP integrations aimed at agents rather than
applications. The MCP surface is how an *agent* reaches context; our server
needs the HTTP one.

## Deployment

Config is a JSON `ov.conf` at `~/.openviking/ov.conf`, `/etc/openviking/ov.conf`,
or `OPENVIKING_CONFIG_FILE`. The server refuses to start without it. Shape, from
`examples/multi_tenant/ov.conf.example` upstream:

```json
{
  "server":    { "host": "0.0.0.0", "port": 1933, "root_api_key": "…", "cors_origins": ["*"] },
  "storage":   { "vectordb": { "backend": "local", "path": "./data" },
                 "agfs":     { "backend": "local", "path": "./data" } },
  "embedding": { "dense": { "model": "…", "api_key": "…", "api_base": "…", "provider": "…" } },
  "vlm":       { "model": "…", "api_key": "…", "api_base": "…", "provider": "…" }
}
```

`root_api_key` gives us server auth. The multi-tenant example is the relevant
one: it is the shape a channel-per-namespace mapping would build on.

## The finding that matters: OpenViking needs a model provider

**It is not a passive store.** Tiering (`L0`/`L1`/`L2`) and semantic retrieval
are computed, so the server requires an embedding model and a VLM, each with its
own `api_key`. Those credentials sit next to OpenViking — server-side.

Article P2 says the server never holds a model credential. Read literally, this
epic violates it.

The article's rationale was that **the person pays for their agent's inference**,
so the organization carries neither a central bill nor a shared rate limit. An
embedding call made while distilling a channel's memory is a different thing: it
is infrastructure, like a search index needing compute, and it cannot be
per-user — the whole point is that one person's agent writes what another
person's agent later reads.

Two coherent resolutions, and this is a decision for a human, not for the epic:

1. **Amend P2** to distinguish *agent inference* (per person, never server-side)
   from *infrastructure inference* (embedding and tiering, organizational, and
   the only model credential the server may hold). Narrow, states the real rule,
   and keeps the article enforceable.
2. **Reject server-side embedding**, and either run OpenViking with a local
   embedding model that needs no key, or keep `Memory::Local` and give up
   computed tiering and semantic retrieval.

Recommendation: **(1)**, with the amended article naming exactly which
credentials are permitted, so it stays a checkable rule rather than a loophole.

## Open, deliberately not resolved here

- **Namespace mapping.** `viking://channels/<slug>/` must map onto whatever
  OpenViking's multi-tenant model calls a tenant. The upstream URI tree is
  `resources/`, `user/{id}/…`, `agent/skills/` — our channel-shaped tree is not
  the native one, and which side bends is the most expensive decision in the
  epic. Settle it before the adapter, not during.
- **Trust and provenance.** Article P4 requires `human`/`agent` and a source
  reference to survive the round trip. Whether OpenViking has native metadata
  fields or we encode them is unverified — the contract suite must assert it
  either way.
- **A running instance.** Not booted during this spike: it needs a real embedding
  credential, which is exactly the decision above. Everything before that point
  is verified from the shipped package.

## Effect on the PLAN

The PLAN in #1 stands, with one insertion: the constitutional question above is
answered *before* `Memory::OpenViking` is written, because a rejection of (1)
changes what the adapter may do at all. `docker-compose.yml` gains an
`openviking` service pinned to v0.4.11 with `ov.conf` mounted, and the embedding
credential arrives by environment variable — never committed.
