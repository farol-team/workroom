# Spike: the screen as a source of channel memory

Research deliverable for #41.

**Verified against** the recorder's own source rather than its README where the
two could differ: the analyzer's prompt construction, the MCP tool catalogue, the
masking rule, and the platform statement.

## The short answers

1. **The boundary is already right, and it is the reason this is possible at
   all.** A local model reads the raw log and emits findings; the egress is
   deterministic code, and the model is told in as many words not to send
   anything itself. Nothing raw leaves the machine.
2. **Observation is a third kind of provenance**, and it needs its own mark. It
   is neither stated by a person nor inferred by an agent, and read as either it
   will be trusted wrongly.
3. **Consent cannot be a setting.** The only architecture worth building makes
   the safe thing structural: per-person opt-in, local storage, visible and
   deletable by the person recorded, and no workspace-wide switch.
4. **Meetings are worth it. Clicks are not.** The value is concentrated in one
   part of what is captured, and the risk is spread across all of it.
5. **It cannot be verified where the rest of this is verified.** macOS and
   Windows only; Linux is out of scope upstream.

## 1. What crosses the boundary

The recorder captures into a local SQLite database and exposes it through a
**read-only MCP server** with twelve tools — recent actions, search, sessions,
apps, health, tree snapshots, meetings, transcripts.

The analyzer is the part that matters. It runs a local model over that MCP
surface and its prompt says, verbatim:

> Output ONLY a JSON array of findings matching the schema above and nothing
> else. Do NOT POST anything, do NOT run curl, do NOT call any HTTP endpoint —
> emitting the JSON is your entire job.

and the code comment beside it: *push nothing (Rust owns egress)*. There is a
test asserting the instruction is present.

**That is the same shape as our own design**: the agent decides what is worth
keeping and says so; deterministic code decides what may leave. It is the reason
this can be considered at all, and it should be treated as a hard requirement of
any integration rather than as a property that happens to hold today.

## 2. Provenance

Channel memory marks `•` stated by a person and `◦` inferred by an agent.
Observed activity is a third thing:

| mark | what it is | how it fails |
|---|---|---|
| `•` | a person said it | they were wrong |
| `◦` | an agent concluded it | the reasoning was wrong |
| observed | a machine saw it | **the interpretation was wrong** |

The third failure is the dangerous one, because the observation itself is
accurate and the conclusion drawn from it need not be. "Alice spent four hours in
the billing repository" is true and means nothing on its own.

So it needs its own mark and its own rank — below an agent's inference, not above
it — and the same superseding path as everything else.

## 3. Consent is structural or it is nothing

Recording keystrokes and meeting audio of employees is regulated, not merely
sensitive: GDPR Article 88 and works-council agreements across the EU,
all-party consent for call recording in several US states.

The recorder already masks text captured while a password field had focus, at the
SQL layer, and flags the row. That is the right instinct and it is not the
question. The question is who decided to record at all.

**What must be true, and what must be impossible:**

| must be true | must be impossible |
|---|---|
| the person turns it on | an administrator turns it on for them |
| the log stays on their machine | a workspace-wide switch exists |
| they can read and delete it | it is on by default |
| a channel receives conclusions only | raw activity is uploaded |

If any of the right-hand column is buildable, somebody will ask for it, and the
answer has to already be no.

## 4. What is actually worth having

Being specific matters more than a capability list.

**Meeting transcripts are worth a great deal.** The recorder captures calls and
transcribes them on-device, splitting local and remote audio so every segment is
attributed. A `# meetings` channel exists in this product precisely for what
those conversations decide, and today somebody has to type it up.

**A log of every click is worth much less** and costs far more in risk. It is the
part that makes this feel like surveillance to the person being recorded, and the
part whose findings are hardest to trust.

The honest scope is therefore narrow: **meetings, and nothing else, to start.**
If a click log ever earns its place it will be by answering a question nobody
could otherwise answer, and that question should be named before it is built.

## 5. Where it can run

macOS and Windows. **Linux is out of scope upstream**, and this project's
development, CI and every verification so far run on Linux.

That is not fatal and it is not nothing: it means the integration cannot be
tested where everything else is tested, and a card that pretends otherwise will
produce code nobody has run.

## Recommendation

| | |
|---|---|
| Build | a channel receiving *meeting conclusions* from a local recorder, through the rail |
| Build | a third provenance mark, ranked below an agent's inference |
| Do not build | raw activity upload, in any form, ever |
| Do not build | a click log integration until it has a question to answer |
| Refuse | any workspace-wide switch, and say why in the constitution |

The integration point is small, and that is the finding. The recorder already
speaks MCP; `agent.ts` already mounts a list of MCP servers and currently has one
entry in it. What is expensive here is not the plumbing — it is deciding what may
cross, and that decision is the whole card.

## Follow-up cards

- An article on consent: what this product will not build, so that a future
  request for a workspace-wide switch has something to be refused against
- A third provenance mark, with its rank and its meaning in `docs/MEMORY.md`
- The integration itself, scoped to meetings, once the two above exist
