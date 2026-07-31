# Capability rail

## What it is

One MCP endpoint, inside the Rails application, exposing exactly two tools:

```
search_capabilities(query)   → what can I use here?
execute_capability(uri, …)   → use it
```

An agent connects once. It does not receive a catalogue of tools; it receives the ability to
ask.

## Why two tools instead of fifty

Exposing fifty skills as fifty MCP tools charges every session for fifty schemas before
anything has happened. The cost is paid on every turn, whether or not any of them are
relevant.

The rail collapses that to two, and charges only for what a query actually surfaces.

This composes with the tiering of the context database: the rail compresses the *tool
surface*, tiers compress the *content*. Discovery reads abstracts; full text is loaded only
for what was chosen. The same idea applied at two levels, and together they are the
difference between a workspace with ten capabilities and one with a thousand.

## Permissions

The rail runs inside Rails because it needs the permission model Rails already owns.

Access derives from the URI path rather than from a grants table:

| Path | Visible to |
|---|---|
| `viking://org/skills/` | everyone |
| `viking://channels/<slug>/skills/` | members of that channel |
| `viking://personal/<user>/` | that person |

A grants table appears only when skills must be assigned to people independently of channels.
Until then it would be a second permission model that nothing uses.

## Execution modes

**Instruction capabilities** are text: how to do something, in what order, what to watch for.
They do not need to run anywhere. The rail returns the detail tier and the agent follows it
locally. No files are distributed, nothing is installed, and a change takes effect on the
next call.

**Bound capabilities** wrap an internal system that requires a credential. Here execution
must be server-side — the secret does not belong on laptops. The rail proxies the call to an
internal MCP server and returns the result.

Most of what a team needs is the first kind. The second is added one system at a time, when
a concrete integration justifies it.

## Local installation is an optimization

Nothing has to be copied to a machine for it to be usable. That matters because distributing
files to every laptop, keeping them current, and reconciling versions is a class of problem
worth not having.

Where local copies do help — offline work, pinning a known-good version, avoiding latency on
a hot path — they remain available as a deliberate choice for specific capabilities, not as
the mechanism everything depends on.

## Scope is structural

The rail is mounted per channel: the url carries the slug, and there is one agent
session per channel, so a rail url cannot address another room. Scope is not a
parameter somebody must remember to check — it is where the endpoint lives.

## What an agent finds there

Knowledge and actions are both capabilities, discovered and invoked the same way.

| | |
|---|---|
| `viking://channels/<slug>/…` | what the room knows — returns the detail tier |
| `workroom://memory/remember` | record a conclusion so later work starts from it |
| `workroom://memory/supersede` | replace an entry this work contradicts |

The last one is the obligation that replaced the human gate: an agent meeting a
contradiction resolves it rather than adding a second conflicting entry. It is a
capability rather than a convention because an obligation nobody can perform in
one call does not get performed.

## Minimal surface

For two tools the JSON-RPC surface is small: `initialize`, `tools/list`, `tools/call`. Server
push and richer transports can be added if a capability ever needs to stream. Starting
minimal keeps the endpoint something one person can hold in their head.
