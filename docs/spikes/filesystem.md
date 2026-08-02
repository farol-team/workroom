# Spike: does WorkRoom need to appear as files on the person's machine?

Research deliverable for #45.

**Verified against** the running prototype: a throwaway exporter was written and
run against the seeded database, and the claims about size, shape and cost come
from that run rather than from estimation.

## The short answers

1. **Yes to a copy, no to a source of truth.** A one-way, opt-in mirror is
   cheap — thirty-odd lines and 1.3 kB for the seeded rooms — and buys real
   things. Two-way sync is not an engineering preference; it contradicts the
   memory model this product is built on.
2. **Writes keep going through the rail.** The one place memory changes stays
   the API, or provenance and supersession stop being true.
3. **Never on by default.** A mirror puts everything a room knows in cleartext
   on every member's laptop, inside home folders that are themselves synced by
   something else.
4. **The seam cannot enumerate**, and one caller already reaches past it. That
   has to be fixed before any of this, and it is worth fixing regardless.

## Three different things get called "files"

| | What it is | Status |
|---|---|---|
| **Workspace** | a directory where the agent works | built, #5 |
| **Binding** | that directory is one the person already has | proposed, #43 |
| **Mirror** | what the room *knows* also exists as files | this spike |

The first two are about where work happens. Only the third is a representation
of WorkRoom itself, and it is the one worth arguing about.

## What a mirror actually costs

A throwaway exporter, run against the prototype:

```
/tmp/wr-export/meetings/README.md
/tmp/wr-export/meetings/memory/acme-reporting-cadence.md
/tmp/wr-export/meetings/memory/pricing-objection-pattern.md
/tmp/wr-export/marketing/README.md
/tmp/wr-export/marketing/memory/setup-cost-positioning.md

total: 1306 bytes
```

```markdown
---
uri: viking://channels/meetings/acme-reporting-cadence
trust: human
author: Alice
recorded: 2026-07-31T09:15:53Z
---

# Acme wants monthly reporting, not weekly

Acme's ops lead asked for monthly rollups. Weekly created noise for their team
and nobody read it. Agreed on the first Tuesday of each month.
```

Every field a memory entry carries survives the trip: `uri`, `trust`, author,
timestamp, title, detail. Nothing had to be invented, and no new server endpoint
is needed — `GET /api/v1/channels/:slug/memory` already returns all of it.

So the cost of the mirror is not the mirror. It is what happens next.

## Why one-way, and not sync

**Correction by superseding is the memory model.** Article P3 says an entry is
never edited in place: a correction is a new entry that supersedes the old one,
carrying who corrected it and why, and the old entry stays readable. That is what
makes memory auditable without a human approving every write.

A file edit carries none of that. It has no author the system can trust, no
reason, and it destroys the previous version. Accepting file edits as memory
writes would not be a feature added to the memory model — it would be the memory
model turned off for anyone with a text editor.

**And the ordinary failure modes are all still there:** an editor writing through
atomic rename looks like delete-then-create; a deleted file is indistinguishable
from "I moved this"; two people editing the same entry on two laptops produce a
conflict with no merge story; and an offline edit arrives after the entry it
edits has already been superseded by someone else.

None of that is unsolvable. All of it is a product, and it is not this product.

## What the mirror is genuinely for

- **Any agent, not only ones that speak MCP.** A folder needs no protocol. An
  agent that can read files can read the room.
- **The tools people already have.** `grep`, an editor, Spotlight, `git log` over
  the exported tree. None of that has to be built.
- **Offline.** The room's knowledge survives an unreachable server.
- **No lock-in, credibly.** "What you know is a folder of markdown you already
  have" is a much stronger answer to *what if we stop paying you* than an export
  button nobody has tested.
- **The bridge to how teams already work.** Where a team keeps a repository per
  department, the mirror can live inside that repository (`.workroom/`), and the
  channel becomes the live layer over folders that already exist (#43).

## Why not by default

WorkRoom is meant to be somewhere a team can be candid. A mirror takes everything
a room knows and writes it, unencrypted, into a home directory — which on a
typical laptop is itself synced to a consumer cloud, indexed by a search daemon,
and swept by a backup agent the person did not configure.

That is a defensible trade when someone chooses it for a channel. It is not a
defensible default for every channel a person happens to belong to.

Opt-in, per channel, and the client should say plainly what it is about to write
and where.

## What has to happen first

**`MemoryController#index` reaches past the seam.**

```ruby
entries = params[:q].present? ?
  Memory::Store.current.search(channel!, params[:q]) :
  channel!.memory_entries.current.by_trust.limit(50)   # <- the local table, directly
```

Article S1 exists so the store can be swapped without touching call sites. This
one path queries the Postgres table itself, so under an external context store
searching would work and listing would return nothing at all. It is a latent bug
today and a blocker for a mirror, which is entirely a listing operation.

**The seam has no enumeration.** `context_for` returns formatted prose, `search`
takes a query, and neither is "give me everything this room knows". Listing
happens to work today by passing an empty query — the term reader returns no
terms and the local backend falls through to everything — but that is an accident
of one implementation, not a contract another backend would honour.

A mirror needs `Memory::Store#all(channel, since:)`. Adding it widens the
interface every backend must implement, which is a real cost and the reason it
should be added deliberately rather than discovered later.

## Recommendation

| | |
|---|---|
| Build | one-way mirror, opt-in per channel, memory as markdown with front matter, artifacts as files |
| Do not build | writes from disk, conflict resolution, continuous sync |
| Refresh | when the channel changes, and on demand |
| Where | a folder the person picks; inside a bound folder (#43) when there is one |
| First | fix the seam bypass, then add `all` to the store |

The honest summary: the filesystem is an excellent way to *read* WorkRoom and a
bad way to *write* it. The mirror should be exactly as good as `git log` is —
complete, trustworthy, and read-only.

## The mirror as built

`RecordStore::GitExport`, run as `bin/rails record:export[slug,path]`. It is
one-way and on demand, as recommended — with one thing this spike did not
anticipate.

**It is exported from the journal, not from the store.** The throwaway exporter
above read `GET /api/v1/channels/:slug/memory`, which is what a room *currently*
knows. The record store (#181) gave the room something better: an append-only
journal, one entry per thing that happened, each entry's bytes addressed by
their own digest. Replaying that gives the mirror three properties the listing
could not:

- **One commit per entry, dated when it happened.** `git log` answers *when the
  room learned this*, not when somebody last ran the export.
- **Superseding survives.** A correction is a new commit on the same file, and
  `git show` of the commit before it still says what the room used to think.
  Exported from a listing, a superseded entry is simply absent — Article P3's
  history, gone in the copy people actually read.
- **Nothing has to be live.** The export asks the context store nothing. Its
  input is bytes that were written once and never change, so a mirror made two
  years later says exactly what a mirror made that afternoon would have said.

That last one has a cost worth naming: a memory entry's **detail travels in the
journal entry**, which is a field both append call sites now send. The
alternative — resolve the uri through `Memory::Store` at export time — cannot
work, because by then the entry may be superseded and the seam correctly answers
with what the room knows *now*.

What the mirror refuses:

- a state file (`.workroom-export.json`) that disagrees with the journal about
  where the last run stopped;
- a repository holding commits and no state file — it is somebody else's
  history, and committing a room's journal on top of it is the fork this whole
  design exists to prevent;
- a slug naming a room in more than one workspace, since one folder holds one
  room's record and slugs are unique per workspace only.

Names never come from content. An artifact called `../../escape.txt` and a uri
whose tail climbs out of the repository both land inside it, sanitized.

## Follow-up cards

- ~~Fix `MemoryController#index` to go through `Memory::Store`~~ — done
- ~~Add `Memory::Store#all(channel, since:)` to the seam~~ — done
- ~~The mirror itself~~ — done: `record:export`
- Desktop integration: the mirror inside a bound folder (#43), and a client that
  says plainly what it is about to write and where.
- Refresh on change rather than on demand, if anyone asks for it. Nothing runs
  the export today except a person or a cron; that is deliberate while the
  mirror is opt-in and one room at a time.
- Entries journaled before this card carry no `detail`, so a mirror of a room
  older than it has a heading with nothing under it for those. Nothing is lost
  — the store still holds the text — but the mirror cannot show what the
  envelope never said.
