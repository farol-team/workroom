# Spike: what does moving to WorkRoom actually take?

Research deliverable for #52.

**Measured against** a real team's workspace of the kind this competes with — a
repository per department, documents in git, a hand-written rules file per area
telling an editor's assistant what context it is in. Counts below are from that
workspace; nothing from it is quoted.

## The short answers

1. **Almost nothing should move.** Documents belong in git, and #43 lets a
   channel sit over the folder they are already in. A migration that moves
   documents is a migration nobody finishes.
2. **The rules files are the migration**, and they split cleanly: procedure is a
   skill, fact is memory. Measured, the split is 6:1 in favour of procedure.
3. **A third of the facts in those files were never filled in.** That is not a
   criticism of the team; it is the failure mode of hand-maintained context, and
   it is the strongest argument this product has.
4. **The real competitor is not another product.** It is the seven weeks a
   written migration plan asks for.

## What is actually in a hand-written rules file

Eleven files, across eleven areas of one company:

| | |
|---|---|
| lines telling you **how** work is done here | 79 |
| lines stating a **fact** about the company | 13 |
| of those facts, still holding a placeholder | **4** |

The procedural part is written once and stays true: *an objective is qualitative,
its key results are measurable, three to five of them.* The factual part —
who leads what, which document is current, who to ask — is a third unfilled
months in.

That is the whole argument, in one table. **A file that mixes both rots in the
half that changes**, and it rots invisibly: the assistant keeps citing the rules
with a straight face.

So the migration of a rules file is a split, not a copy:

```
procedure  →  a skill on the channel      # true before the team did anything
fact       →  channel memory, or nothing  # true only if it is still true
placeholder → nothing                     # it was never true
```

The last row matters. Migrating a placeholder into memory would put
`CEO: [Name]` in front of every future agent session with the authority of
something the room knows.

## What does not move

**Documents.** They are in git, where review, history and diff already work, and
#45 concluded the filesystem is a good way to read WorkRoom and a bad way to
write it. Moving them buys nothing and costs the thing that made them
trustworthy.

**Directory structure.** #43 binds a channel to the folder a team already has, so
`# billing` works in `~/src/billing` and the agent reads the code being asked
about. Most of what a migration plan calls "content migration" disappears the
moment the content does not have to move.

**Access.** Repository permissions already say who may see what. Channel
membership is the same shape; it does not need to be rebuilt, only mirrored.

## What a move actually is

1. **Create the rooms.** #51 offers the shape, so this is minutes rather than a
   design exercise. A team's own areas map almost one to one.
2. **Bind the ones with a repository behind them** (#43). Nothing is copied.
3. **Split each rules file.** Procedure becomes skills — mechanically, they are
   already written as instructions. Facts are read by a person and either
   recorded or dropped; a placeholder is dropped.
4. **Stop maintaining the rules files.** This is the step that is easy to skip
   and the only one that pays. Two sources of context that disagree is worse
   than one that is stale, because now nobody knows which the agent read.

Steps 1 and 2 are minutes. Step 3 is an hour per area, and it is the only part
that needs a person who knows the work. Step 4 is a decision.

## What a team gives up

Being specific here is worth more than a feature list.

- **Everything in one editor.** A rules file is read by whatever the person is
  already using. Channel memory is reached through the rail, which means an agent
  that speaks ACP or MCP — not any tool at all.
- **Grepping their whole context.** Files are greppable. Memory is searched by
  meaning through the rail or read through a mirror that does not exist yet
  (#45).
- **Editing context in a text editor.** Memory is corrected by superseding, not
  by opening a file. That is the property that makes it trustworthy and it is
  also, on a Tuesday afternoon, less convenient.

None of these is fatal. All of them will be the first three complaints.

## Can the split be done mechanically?

Partly, and the honest answer is that the useful half cannot.

Procedural lines are recognisable — they start with an imperative, and a crude
matcher found 79 of them across eleven files without a false positive worth
mentioning. Turning those into skills is a script.

Facts are not. Deciding whether *"the current OKRs are in okrs-2026-q1.md"* is
still true, and whether it is worth a room knowing, needs somebody who knows. And
it is exactly the half where a wrong answer is expensive, because memory is
injected into every later session.

**So: script the procedure, sit with the facts.** A migration tool that promises
both is a tool that will quietly import placeholders.

## Recommendation

| | |
|---|---|
| Build | a command that reads a rules file and proposes skills from its procedural lines |
| Do not build | anything that imports facts without a person reading each one |
| Do not build | document migration at all — #43 already made it unnecessary |
| Say plainly | that the rules files must stop being maintained afterwards |

The measured 6:1 split says the scriptable part is most of the volume, and the
placeholders say the unscriptable part is where the damage would be.

## Follow-up cards

- A command that proposes skills from an existing rules file — procedure only,
  and it prints what it skipped rather than guessing
- The first-run experience that uses #51's templates, since a migration starts
  with creating rooms and nothing in the client offers that yet
