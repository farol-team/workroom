# Spike: how do buzz, openwork, and qm handle file and folder synchronization?

Follow-up to `landscape-buzz-openwork-qm.md`, same sources and snapshots.
Motivation: `filesystem.md` (#45) declined two-way sync for WorkRoom; this
spike checks whether that position is eccentric or consensus, and where
WorkRoom actually stands on files against the class.

## The short answers

1. **Nobody does folder sync.** Not one of the three — no watcher, no daemon,
   no two-way mirror between machines. buzz substitutes git for it, openwork
   substitutes addressed remote access, qm substitutes server-side sandboxes.
   The `filesystem.md` rejection of "writes from disk, conflict resolution,
   continuous sync" is the consensus position of the class, not an outlier.
2. **WorkRoom's real file gap is not sync — it is read-back.** Artifacts are
   write-only: no download endpoint, no blob URL in the serializer, the desktop
   never even calls the index. All three alternatives can hand bytes back.
3. **Content addressing is the norm everywhere but here.** buzz (SHA-256 media
   keys, git packs) and qm (SHA-256 blob store) get dedup and integrity for
   free; WorkRoom's Active Storage attachments have neither.

## What each one actually does

**WorkRoom.** One mechanism: channel artifacts (Active Storage → S3 in
production), uploaded only by explicit click — "offered, not uploaded"
(`desktop/src/main.ts:304`). The end-of-turn diff is snapshot-based, or
`git status --porcelain` in a bound repo so ignore rules filter build output.
Derived per-(user, agent, channel) working directories are sanitized against
path traversal. No conflict model, because there is nothing shared and mutable
to conflict over. Upload is JSON base64; the 25 MiB cap is client-side only.
No download path exists (routes expose `index`/`create`; `serialize` carries
no URL).

**buzz.** Two strong mechanisms, still no folder sync: (a) a git forge on
object storage — ephemeral worktrees hydrated per request, ref updates as CAS
on an S3 manifest pointer, content-addressed immutable packs, with a proved
no-lost-update theorem (`docs/git-on-object-storage.md`); (b) Blossom media —
`PUT /media/upload`, `GET /media/{sha256}`, signed auth events per verb. "Sync"
of code is ordinary git push/pull against the relay.

**openwork.** Not sync but token-scoped remote file access: a file-sessions
API on the host's `openwork-server` (batched read/write, catalog snapshot +
event cursor, TTL sessions, owner/collaborator/viewer tokens, host approval on
writes), plus inbox/outbox directories and one-shot workspace export/import.
Sharing with teammates happens as capabilities (marketplace), never as files.

**qm.** The richest machinery, all a consequence of server-side execution:
per-scope durable sandbox disks (Fly volumes; snapshot/hydrate on AWS),
a content-addressed durable byte store (SHA-256 keys, S3/local/memory
backends), capability-token blob transfer (single-purpose, expiring, re-checks
membership), per-file ACL grants with a share/move/promote verb trio, read-only
mounts of other scopes' workspaces materialized by hash manifest, and
publish-to-web with bearer links. Still no user-facing "sync my laptop"
feature — the user has no local agent at all.

## Comparison

| Axis | WorkRoom | buzz | openwork | qm |
|---|---|---|---|---|
| Base mechanism | Append-only channel artifacts | Git repos on S3 + Blossom media | File-sessions to host folders | Sandbox FS + durable store |
| Download | **None — write-only** | `GET /media/{sha256}` | Outbox reads | List + stream, ACL-checked |
| Folder sync | None (declined, #45) | None (git instead) | None (batched access) | None user-facing |
| Sharing | Channel membership only | Channel/community | Scoped tokens + approval | Per-file grants: share/move/promote |
| Consistency | Nothing to conflict | Proved CAS linearizability | LWW behind host approval | LWW per scope; CA dedup |
| Addressing | Plain attachments | SHA-256 throughout | Host paths | SHA-256 blobs |
| Agent's files | Local derived cwd, user's disk | Local; remote bodies are mortal | The user's real folders | Sandbox = "durable computer" |
| Human consent | Click per file | — | Approval per write | Posture-based |

## Consequences for WorkRoom

- **Build the download path before anything else.** It is the only axis where
  WorkRoom trails all three, and `docs/AGENTS.md` already promises rehydrated
  agents can reach channel artifacts — the API does not currently back that
  promise.
- **Cheap wins available without breaking the model:** SHA-256 addressing for
  artifact blobs (integrity + dedup, both stores in the class do it); scoped
  bearer tokens (qm/openwork pattern) as the way to let a colleague's agent
  read one artifact without growing the permission system.
- **qm's share/move/promote grammar is portable.** The ACL verbs are pure
  logic, independent of server-side execution — they fit channel artifacts the
  day a real "share this file with the other channel" case appears.
- **Do not import anything else from qm's file story.** Read-only layers,
  sandbox migration, and deployment layers all presuppose the server runs the
  agent. They solve problems local execution does not have.
