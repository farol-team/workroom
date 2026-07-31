# Agents

## Local, always

The agent runs on the machine of the person it belongs to. The server never executes one.

This is not a deployment detail. It determines the security model — the agent uses that
person's credentials and sees that person's filesystem, so nothing needs to be delegated to
a shared service. It determines capacity — no queue, no shared pool, no noisy neighbour. And
it determines longevity — the workspace has no opinion about which agent you use, so it does
not need rebuilding when a better one appears.

The client speaks **ACP** over stdio to whatever agent the person has configured.

## Why local is not a deployment detail

**Inference is paid for by the person, not the room.** Each agent uses its owner's
credentials and their own model subscription, so the organization never carries a central
inference bill and never queues behind a shared quota. Rate limits are per person, which
means the workspace cannot become the bottleneck no matter how many people are working.

The server sees token counts because runs report them — that is reporting, not billing. It
never sees a model credential, and there is nothing to leak if it is compromised.

The trade is real and worth stating: the organization gains visibility into spend but not a
single lever over it. An organization that wants central control of model spend wants a
different design.

## Which agents

Any agent that speaks ACP. Two are known to work:

| Agent | How | Notes |
|---|---|---|
| **opencode** | `opencode acp` | First-party ACP server, MIT, released continuously. The default. |
| **Claude Code** | `@zed-industries/claude-code-acp` | Community-maintained adapter |

The handshake reports `mcpCapabilities`, which is how the capability rail reaches the agent —
the client passes the rail's MCP configuration when it opens a session. It also reports
`loadSession`, which is the hook rehydration builds on.

## Sessions

**One session per (user, channel) pair.** Everything else follows from this.

- Switching channels switches session
- The memory scope of a session is the channel's scope
- Rehydration is what happens at session start
- A run belongs to a session, so cost and history roll up per person per domain

A session is `idle`, `running`, or `dead`. The client owns the process; the server owns the
record of what that process did.

## Runs and steps

A **run** is one turn: a message arrives, the agent works, an answer comes back. It may take
seconds or many minutes.

A **step** is a single thing that happened inside a run — a tool call, its result, a stretch
of reasoning. Steps are recorded and broadcast as they occur.

Steps are not instrumentation, they are the product. Without them a person watches an empty
channel for minutes and assumes something broke. With them the channel shows *reading the Q3
deck*, *querying the CRM*, *drafting the summary* — and the wait becomes legible. A large
share of how good the system feels is decided here.

Runs also carry cost and timing, which is where per-channel and per-person spend reporting
comes from.

## Rehydration

When a colleague opens a channel, their agent does not resume your session — it cannot. The
context window of a running agent is local and not transferable.

What it does instead is rehydrate:

1. The channel's `L1` summary is injected as context
2. Recent channel history is available
3. Artifacts produced in the channel are reachable
4. Deeper detail is fetched from the rail as needed

The practical difference from a true handoff is small, provided the channel's memory is
good. That proviso is the whole design constraint: **rehydration quality is memory quality.**
This is why the summary matters more than the raw transcript, and why an agent entering a
channel should receive a distilled page rather than a thousand messages.

## What the room sees

The room shares outcomes, not process — and the person doing the work decides
how much of the process to share. Visibility is a property of a session, because
it is a stance towards a channel rather than a property of one turn.

| Level | The room sees | The owner sees |
|---|---|---|
| `full` | steps, messages, outcomes | everything |
| `outcomes` *(default)* | run presence, the answer, artifacts, memory proposals | everything |
| `private` | presence only, until the owner shares something | everything |

Two things hold this together.

**Presence survives every level.** A run announces that it started and that it
finished, with no content, at all three. Without it a private session is
indistinguishable from an absent colleague, and translucent becomes invisible —
which is the failure the whole design turns on.

**A person's own messages are never governed by it.** Visibility applies to an
agent session. What a human says in a channel is what they said in a channel.

Changing the level is not retroactive. What was broadcast stays broadcast;
pretending the room can unsee something would make the audit dishonest.

## Artifacts

An agent writes files to its working directory by default. Left alone, results stay on one
laptop and a colleague sees the conversation without its output.

The rule is that work product goes to the channel. Each session has a working directory
scoped to its (user, channel) pair; on completion, produced files are uploaded as artifacts
belonging to the channel and, where applicable, to the run that made them.

This is what makes a channel a complete record rather than a discussion of work that
happened elsewhere.

## Attribution

A message written by an agent is attributed to the **run**, not to the person.

From any agent message you can therefore reach the steps that produced it, what it cost, how
long it took, and the message that triggered it. Attributing to the person would collapse
all of that into "Alice said", and the trail would be gone.
