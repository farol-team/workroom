# Spike: what OpenViking isolates, and what it does not

Measurement behind the amendments to [P1 and P5](../../.claude/constitution.md)
dated 2026-08-01, and behind the decision to let agents reach the context store
directly for the MVP.

**Verified against** `openviking` 0.4.11, run locally in a container with a
`root_api_key` and local `vectordb`/`agfs` backends. No embedding provider was
configured — writes queue their embedding and the file lands regardless, which
is all these probes need.

## The question

The channel is the permission boundary (P5). If an agent talks to the store
directly, what does the store itself enforce?

## What was run

Two accounts, and a second user inside one of them:

```bash
POST /api/v1/admin/accounts   {"account_id":"acct-a","admin_user_id":"alice"}
POST /api/v1/admin/accounts   {"account_id":"acct-b","admin_user_id":"bob"}
POST /api/v1/admin/accounts/acct-a/users  {"user_id":"carol","role":"user"}
```

Keys come back in the shape `base64url(account).base64url(user).base64url(secret)`
— account and user are readable from the key itself, and there is no path in it.

Alice writes where WorkRoom puts a channel's memory:

```bash
POST /api/v1/fs/mkdir          uri=viking://resources/channels/salaries
POST /api/v1/content/write     uri=viking://resources/channels/salaries/secret.md
                               content="ACCOUNT A PRIVATE: everyone gets a raise"
```

## What came back

| Probe | Result |
|---|---|
| **bob** (other account) reads `…/salaries/secret.md` | `NOT_FOUND` |
| **bob** lists `viking://resources/channels` | `NOT_FOUND` — the directory does not exist for him |
| alice reads her own file — **control** | `ok`, `"ACCOUNT A PRIVATE: everyone gets a raise"` |
| alice lists `viking://resources/channels` — **control** | `ok`, `salaries` |
| **carol** (same account, role `user`) reads alice's file | `ok`, **the whole text** |
| **carol** lists `viking://resources/channels` | `ok`, `salaries` |

The controls are the point. Without them "bob saw nothing" would be equally well
explained by a write that never landed.

## What this means

**The account is the boundary, and it is real.** Cross-account access fails as
`NOT_FOUND` rather than `403`, so the existence of another account's directory is
not disclosed either. OpenViking's own name for an account is *workspace* —
`create_account` is documented as "Create a new account (workspace) with its
first admin user".

**Inside an account there is no boundary.** `viking://resources/` is shared by
every user of the account. Its docstring — "not bound to specific account or
Agent" — means it belongs to no particular *user* within the account, not that
it spans accounts. That sentence is easy to read the other way; this is why the
probe exists.

**Therefore the store cannot express a channel.** An agent holding any user key
of a workspace reads and writes every channel in it, private ones included. The
MCP endpoint is mounted at `/mcp` over streamable HTTP and carries 16 tools —
`find, search, recall, read, list, remember, add_resource, list_watches,
cancel_watch, grep, glob, forget, code_outline, code_search, code_expand,
health` — so this is not only a reading concern: `forget` is in the list.

## The one mitigation, named honestly

An agent is asked, in the prompt that opens its session, to stay inside its own
channel's subtree:

> Your channel's memory is rooted at `viking://resources/channels/<slug>/`.
> Read and write only inside it. Other channels' memory is reachable with your
> key and is not yours to read.

This is a **convention, not a control**. It is worth having — it turns a silent
reach into a deliberate one, and an agent that ignores a stated boundary is a
thing worth seeing in a transcript — but it stops nothing. Nothing in the server
may be written as though it did.

Two traps for whoever implements it:

- it must not live in `Memory::OpenViking#context_for`, which returns `nil` when
  a channel has no entries yet. A new channel would then open with no boundary
  stated at all — precisely the channel where the agent has least to go on and
  most room to wander.
- the endpoint already returns `memory_uri` alongside the context
  (`GET /api/channels/:slug/context`), so the root can be named exactly rather
  than described.

## Consequences taken deliberately

Accepted for the MVP: one workspace, a team that trusts each other, and private
channels that are private to people but not to their agents.

Not accepted quietly: P1 and P5 carry the amendment, and the condition for
revisiting is written into P5 — a second workspace, or a channel somebody needs
kept from a colleague's agent.

**Article S1 is unaffected.** It binds controllers, jobs and views to
`Memory::Store`; an agent is none of those.

## What this settles for multi-tenancy

An **account per workspace** gives the context store a boundary of the same kind
`workspace_id` with row-level security gives PostgreSQL — enforced by the thing
holding the data rather than by the code addressing it. The two halves of tenancy
therefore have matching guarantees, which was the open question when the column
was chosen over schemas.

What it does not give is a boundary *below* the workspace. Anything finer —
channels, private rooms, one person's memory kept from another's agent — has to
be enforced by something that knows what those are, which today means the
capability rail.
