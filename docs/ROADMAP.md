# Roadmap

Five stages. Each one produces something usable on its own; none depends on the next.

## 1 — The room

Channels, messages, threads, membership, SSO, and realtime delivery. The desktop client shows
them.

No agents. This is an ordinary team chat, and that is the point: the substrate has to be solid
before anything interesting sits on it. It is also the fastest stage, because none of it is
novel.

**Done when** two people can hold a threaded conversation in a channel, over SSO, with
messages arriving live.

## 2 — The agent in the room

The desktop client manages a local agent over ACP. One session per (user, agent, channel). Messages
route to the agent; answers and run steps come back into the channel.

No memory yet — the agent starts each session knowing only what is in the conversation.

**Done when** a person can work with their own agent inside a channel and a bystander can
watch the steps as they happen.

## 3 — Memory

The context database is deployed. The capability rail goes in as a Rails endpoint. Channel
summaries are pushed at session start; detail is pulled through the rail on demand.

This is where the product's premise gets tested for the first time: does an agent with what
the room knows perform visibly better than one without it?

**Done when** an agent entering a channel demonstrably knows things nobody told it in that
session.

## 4 — Output

Artifacts land in the channel rather than on a laptop. Session working directories, upload on
completion, linkage to the run that produced them.

**Done when** a colleague can open a channel and find not just the discussion but the work.

## 5 — Continuity

Every turn ends by asking the agent what the room should keep. Rehydration tuned so that a
second person's agent starts where the first stopped.

This is the reason the whole thing exists, and it comes last — because you cannot distil a
record you have not yet accumulated, and you cannot tune rehydration without real channels to
rehydrate from.

**Done when** one person can finish a session, a different person can open the channel the
next day with a different agent, and the work continues rather than restarts.

---

## Sequencing note

The premise of the project — that shared memory makes agents materially more useful — is not
proven until stage 3, and the payoff is not visible until stage 5.

That ordering is unavoidable for building, but it is avoidable for *learning*. The cheapest
possible version of the stage 5 experiment is a shared file of channel notes handed to two
people's agents on two different days. A day of work, no infrastructure, and it answers
whether rehydration feels like continuation or like starting over.

Worth running early and in parallel. If the answer is disappointing, the memory design changes
while changing it is still cheap.
