# Agents

## Local, always

The agent runs on the machine of the person it belongs to. The server never executes one.

This is not a deployment detail. It determines the security model — the agent uses that
person's credentials and sees that person's filesystem, so nothing needs to be delegated to
a shared service. It determines capacity — no queue, no shared pool, no noisy neighbour. And
it determines longevity — the workspace has no opinion about which agent you use, so it does
not need rebuilding when a better one appears.

The client speaks **ACP** over stdio to whatever agent the person has configured.

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
