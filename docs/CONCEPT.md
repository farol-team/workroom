# Concept

## The problem

Give a team AI agents and three things go wrong at once.

**Configuration drifts.** Everyone assembles their own set of instructions, tools, and
connections. There is no shared standard, onboarding takes a day, and the person who
figured something out last month is the only one who still knows it.

**Nothing is visible.** You cannot see who is running what, what it costs, or what came
back. There is no shared history and no audit trail.

**Nothing accumulates.** Every session starts from zero. The agent that spent an hour
learning your codebase, your customers, or your reporting conventions forgets all of it,
and the next person's agent learns it again from scratch.

The third one is the expensive one. The first two are inconveniences; the third means the
organization pays repeatedly for knowledge it already bought.

## The idea

Put the knowledge in the room.

A **channel** is a domain of work. Not a chat topic — a boundary. `meetings` holds client
conversations and what came out of them. `marketing` holds campaign work, positioning,
and what has been tried. Each channel owns a region of the context database, and that
region is what the room knows.

Everyone brings **their own agent**, running locally on their own machine. Nothing is
centralized about execution: your agent uses your credentials, your files, your model
choice. What is centralized is the memory, the skills, and the record of what happened.

When you enter a channel, your agent is given what the room knows. When you finish, what
was learned can be promoted back into the room. When a colleague enters the same channel
tomorrow with a different agent, that agent starts where you left off.

## Why this shape

**The agent is not the product.** Agents improve every few months and people have
preferences. Binding the workspace to one agent means rebuilding when the landscape moves.
Binding to a protocol means the workspace outlives any particular agent.

**Memory belongs to the organization, not to a vendor.** Knowledge accumulated over a year
of work is the most valuable thing the system produces. It should live somewhere you
control, in a form you can read, audit, and take with you.

**Execution belongs to the person.** Local agents mean local credentials, local files, and
no queue behind a shared service. It also means the workspace never becomes the bottleneck.

**Channels give you scoping for free.** One concept serves as the memory scope, the
permission boundary, the retrieval scope, and the unit of conversation. Systems that keep
those separate end up reconciling four models of who can see what.

## What this is not

**Not a place where agents run.** Agents run on the machines of the people who own them.
The workspace coordinates, records, and remembers.

**Not a replacement for the tools you have.** Repositories, documents, and the systems the
work touches stay where they are. They are sources; this is the layer that distils them
into something an agent can act on.

**Not an autonomy play.** The design assumes people stay in the loop. Promotion into shared
memory is an explicit human act precisely because unattended accumulation is how a
knowledge base quietly fills with confident mistakes.

**Not a chat product.** Conversation is the interface, not the point. The point is that
work done in a channel leaves the room better informed than it found it.
