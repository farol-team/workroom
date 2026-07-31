# Spike: what an agent records, and whether a session is portable

Research deliverable for #26.

**Verified against** the ACP schema (`zed-industries/agent-client-protocol`,
`schema/v1/schema.json`) and a live `opencode acp` 1.18.10 handshake. Claims
about behaviour come from the running agent, not from documentation.

## The short answers

1. **We are discarding most of what the agent tells us.** ACP defines eleven
   kinds of session update. We translate three.
2. **A session is portable across models.** `model` is a session config option;
   changing it mid-session is a protocol call. The session is the artifact and
   the model is a setting on it.
3. **Sessions are first-class and durable** — listable, resumable, forkable.
4. **Portability does not replace channel memory.** Resume solves *me, later*.
   Memory solves *somebody else*. They are different problems.

## 1. Eleven kinds of update; we use three

| Update | We do | Worth capturing |
|---|---|---|
| `agent_message_chunk` | accumulate into the answer | ✅ already |
| `tool_call`, `tool_call_update` | collapse to a step label | ✅ already, thinly |
| `plan` | **discard** | **yes — see below** |
| `usage_update` | discard | **yes** — carries `used`, `size`, `cost` |
| `agent_thought_chunk` | discard | yes, as record — not in the feed |
| `session_info_update` | discard | title and `updatedAt`, cheap |
| `current_mode_update`, `config_option_update` | discard | yes — this is how a model change announces itself |
| `available_commands_update` | discard | no |
| `user_message_chunk` | n/a | no — we already hold it |

**`plan` is the one that stands out.** `Plan` carries `entries`, each with
`content`, `priority` and `status`, updated as work proceeds. That is the agent's
intent, in its own words, revised live. For a colleague deciding whether to wait
or to step in, it is more useful than any number of tool-call labels — and it is
exactly the "outcome, not process" the room is supposed to carry. We throw it
away and synthesise a worse signal from tool calls instead.

**`usage_update` is second on the list.** It reports `used`, `size` and `cost`.
We currently record token counts the *client* supplies, which is second-hand and
optional. The agent is the authority on what it spent.

## 2. A session is portable across models

`opencode acp` returns config options on session creation:

```
configOptions: 2
  model    Model           opencode/big-pickle
  mode     Session Mode    build
```

`SetSessionConfigOption(sessionId, configId, value)` changes them in place, and
`config_option_update` announces the change to the client. So yes: work can start
on one model and continue on another **inside the same session**, with history
intact — the transcript belongs to the session, not to the model.

**What this means for #9.** That card assumes several models implies several
agents. For models *within* one agent it is a config option, not a second
process. #9 shrinks to the genuinely separate case — several agent runtimes —
and gains a much cheaper feature: a model picker per channel.

### A gap between the schema and the agent

`SetSessionConfigOptionRequest` in the published schema lists only `sessionId`
and `configId` — there is no `value`. The agent accepts one regardless, and
returns the updated option list:

```
model before: opencode/big-pickle
model after:  opencode/mimo-v2.5-free    (same session)
```

Either the schema is incomplete or the field lives in an unstable variant. We
depend on observed behaviour here, which is worth knowing when a future agent
does not accept it.

## 3. Sessions are durable and enumerable

opencode reports `sessionCapabilities: { list, resume, fork, close }` and
`loadSession: true`. ACP defines `LoadSession`, `ResumeSession`, `ListSessions`,
`CloseSession`, `DeleteSession`; `LoadSessionResponse` returns the modes and
config options, so resuming restores the stance and not only the text.

`fork` is worth noting: branching a session at a point is how you try a second
approach without losing the first.

## 4. Resume does not replace memory, and should not

The tempting conclusion is that portable sessions make channel memory redundant
— just resume the session. It is wrong, for a structural reason:

**the session lives on its owner's machine.** It is the agent's own storage,
under that person's credentials, on their laptop. A colleague cannot resume it;
there is nothing there to resume.

| Problem | Mechanism |
|---|---|
| I want to continue what I was doing yesterday | resume the session |
| Somebody else should continue what I was doing | channel memory |
| I want to try a different approach from a point | fork the session |
| I want a different model on the same work | set the config option |

Memory stays the cross-person mechanism precisely because it is the only thing
that lives in the room rather than on a laptop.

## Recommendation

Capture three things, in this order:

1. **`plan`** — store it against the run and render it in the channel. Highest
   value per line of code of anything in this document: it is the agent saying
   what it intends, which is what a colleague actually wants to know.
2. **`usage_update`** — replace client-reported token counts with what the agent
   reports. Same fields, better provenance, and it removes an optional parameter
   from the run API.
3. **`agent_thought_chunk`** — record against the run, keep out of the feed. It
   is process, and the rule already says process is available rather than pushed.

Then expose two session operations the client already has the right to use:

4. **Resume** the session for a channel when one exists, instead of always
   creating a new one. Today every restart of the client loses the thread.
5. **A model picker per channel**, backed by `SetSessionConfigOption`.

## What is ACP and what is opencode

Everything in sections 1 and 3 is **ACP**, so it holds for any agent we support.
The specific option ids (`model`, `mode`) and their values are **opencode's** —
a different agent may name them differently or not offer them. Read the option
list rather than assuming `model` exists.

## Not settled here

- **Where a plan belongs in the schema.** A `run_plans` table, a column on
  `agent_runs`, or a `RunStep` of kind `plan` — the last is cheapest and may be
  enough.
- **Retention.** Thought chunks are large. Recording everything forever is a
  storage decision this spike does not make.
- **`fork` in the product.** The protocol offers it; whether a channel should
  expose it is a product question, not a protocol one.
