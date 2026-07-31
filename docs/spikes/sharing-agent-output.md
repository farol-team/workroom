# Spike: how an agent's output reaches the room

Research deliverable for #14. A design, not an implementation.

The tension: a colleague should be able to see that work happened and what came
of it, and the channel must not fill with agent chatter. Both matter, and the
obvious answers — share everything, share nothing — fail in opposite directions.

## Recommendation in one line

**The run is the unit, the visibility level supplies the default, and the
gesture exists only where the default is silence.**

## 1. Two gestures, not one — and one implies the other

Sharing to the channel and promoting into memory are different acts at different
altitudes, and collapsing them would make one of them wrong.

| | Share | Remember |
|---|---|---|
| Says | look at this now | the room should know this later |
| Lifetime | the conversation | until superseded |
| Review | none — it is just a message | human approval (#4) |
| Mechanism | channel broadcast | `Promotion` → `MemoryEntry` |

A message can be worth showing and not worth remembering — most are. A
conclusion can be worth remembering and not worth announcing.

**Remember implies Share; Share does not imply Remember.** You cannot sensibly
commit something to the room's knowledge that the room never saw, so promoting
an unshared run shares it in the same act. The reverse would make every casual
share a candidate for permanent memory, which is exactly the undisciplined
accumulation Article P3 exists to prevent.

No new promotion path: **Remember is #4's `Promotion` verbatim**, invoked from a
run rather than from a distillation job.

## 2. The unit is the run, not the message

A message is the wrong granularity in both directions: too small (an answer
without its question is a riddle) and too many (a run may emit several).

A **run** is already exactly one question, one answer, and whatever artifacts
came out. Sharing a run shares the triggering message, the final agent message,
and its artifacts — as one item in the channel.

This also answers *does context travel with it* — yes, structurally, because the
run holds the trigger. No caption is required, and none is invented.

Intermediate agent messages inside a run are process. They stay with the owner.

## 3. Defaults come from the visibility level, so most people never click

The gesture problem is real: a per-message click will not happen, and people
will leave everything closed and the room will go quiet. The fix is that the
level from #13 already expresses the owner's stance, so the default follows from
it and the gesture only exists where the default is silence.

| Level | Steps | Run's answer | Gesture needed |
|---|---|---|---|
| `full` | to the room | to the room | none |
| `outcomes` *(default)* | owner only | **to the room, automatically** | none |
| `private` | owner only | owner only | **Share, per run** |

The common case costs nothing. Someone working normally in a channel shares
their outcomes without ever thinking about it, and the room stays quiet because
process never reaches it. Only the person who deliberately chose `private` has a
button to press.

## 4. Presence is what keeps `private` translucent rather than invisible

Under `private`, a run currently produces nothing at all in the channel, which
makes a colleague hard at work indistinguishable from a colleague who is absent.
That is the failure mode of the whole design, and it is cheap to avoid.

A run under any level emits a **presence line** on start and clears it on
finish: *"Bob is working with his agent."* No content, no steps, no count. One
broadcast per run rather than per step.

This is the "translucent" the room needs: you know work is happening, you do not
watch it happen.

## 5. Sharing is one-way; remembering is not

A share cannot be withdrawn. #13 already fixed that visibility changes are not
retroactive, on the grounds that pretending the room can unsee something makes
the audit dishonest; a per-message exception would reintroduce exactly that.

Memory is different and already has the right rule: an entry is corrected by
**superseding**, never by editing or deleting (Article P6). So a shared run
stays shared, and a remembered conclusion can be revised — which is the correct
asymmetry, because a message is a thing that was said and a memory is a claim
about what is true.

No undo window. That is machinery for a failure that has not happened
(Article III), and it would weaken the audit to buy politeness.

## Rejected alternatives

**Star every message.** The gesture cost falls on the wrong case — the common
one. Channels go silent, and the people who most need visibility get least.

**Share everything, let readers filter.** Moves the cost to every reader on every
run, permanently. Filtering is also the wrong tool: the reader cannot know which
of forty tool calls mattered, and the owner can.

**One gesture with two destinations.** Simpler to build, wrong in use: it forces
a choice between announcing things nobody needs to remember and remembering
things nobody needed announced. The altitudes are genuinely different.

**Server-side summarisation of a run into a line.** Attractive, and it is a
model call on the organization's inference budget for something the owner can
express by writing one sentence. Revisit only if runs routinely produce answers
too long to post.

## Boundaries between the three cards

| Concern | Card |
|---|---|
| Visibility levels, per-user stream, what the room can see | **#13** |
| `Promotion` and its human review | **#4** |
| Share gesture, run as the unit, presence line, Remember-implies-Share | **new, from this spike** |

The third is small precisely because the first two carry most of it. What is
genuinely new is the run-level share, the presence line, and the implication
rule.

## What this spike does not settle

- **Artifacts under `private`.** A file produced by a private run: does it reach
  the channel with the shared run, or does Article D3 ("artifacts belong to the
  channel") override the owner's level? D3 was written before visibility levels
  existed. Needs a decision, likely an amendment.
- **Threading.** A shared run becomes one channel item, but replies to it are
  ordinary messages — whether they thread under it or sit beside it is a UI
  question this spike deliberately leaves open.
