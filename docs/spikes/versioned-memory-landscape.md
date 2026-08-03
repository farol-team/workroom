# Spike: who organizes knowledge through git — and is "versioned organizational memory" a free niche?

Motivation: WorkRoom's record layer already mirrors a room's journal into a
git repository (`bin/rails record:export`), and promotion into shared memory
is an explicit human act. The question this spike answers: does anyone already
sell *knowledge organized through git* — a knowledge base where git is the
store and review mechanism — or is the intersection actually empty? Answered
by mapping two adjacent markets: tools that extract knowledge from chat
history, and products that organize knowledge through git.

Caveats on sources: much of the comparative material in segment 1 is vendor
content marketing (questionbase.com, slite.com) and is biased by construction;
pricing marked `~` is a third-party estimate; Obsidian's MAU/revenue and
GitBook's 2022 round are second-hand estimates. GitHub stars were checked
directly via the GitHub API on 2026-08-02.

## Segment 1: extracting knowledge from chat history

The segment's hard-won consensus, confirmed across every player:

- **Pure RAG over chat history lost.** Even Slack-native players sell a
  curated base on top: chat is a source of *candidates*, a write into the base
  passes through a human. Question Base builds its whole marketing on "chat
  history is not a source of truth"; Slite's own essay concedes "the knowledge
  base is a ghost town, Slack is the thriving metropolis"
  ([slite.com](https://slite.com/blog/slack-the-accidental-knowledge-base)).
- **The industry's answer to stale knowledge is expiry + a named owner, not
  versioning.** Guru (verifier + 30/60/90-day re-certification), Slite
  (validity windows), Tettra (stale-page detection). And even that fails in a
  recognized way: "verified-but-stale card" — the checkbox is ticked, the
  content is dead
  ([HappySupport](https://happysupport.ai/blog/guru-vs-confluence)).
- **Nobody versions the extracted knowledge.** No change history of an
  answer, no diff between versions, no lineage "this record came from that
  thread on that date and changed thus". Citations to source messages
  (Notion AI, Copilot, Glean, Question Base) are per-answer, not per-record.
  This is the segment's white square.

### Players

| Player | Pricing | Traction / status |
|---|---|---|
| [Glean](https://www.glean.com/) | quote-based (~$45+/user/mo) | Enterprise-search leader: $7.2B valuation (Series F, 2025), >$250M ARR in 2025 ([TechCrunch](https://techcrunch.com/2025/06/10/enterprise-ai-startup-glean-lands-a-7-2b-valuation/)) |
| [Guru](https://www.getguru.com/) | $15–25/user/mo (sources disagree) | Reference implementation of "verified knowledge"; failure mode above is documented by its own ecosystem |
| [Tettra](https://tettra.com/) | per-user, no public price | 20,000+ organizations ([pricing page](https://tettra.com/pricing/)) |
| [Question Base](https://www.questionbase.com/) | Free (100 answers) / Pro $5/user/mo | Most active in the Slack-first KB niche; claims auto-answering ~35% of repeat questions |
| [Slite](https://slite.com/) | no free plan, 14-day trial | Knowledge Suite: AI drafts documents from Slack threads and GitHub PRs |
| [Unblocked](https://getunblocked.com/) | from $19/user/mo | $20M Series A (2025); engineering-knowledge niche ("why is it built this way") ([TechCrunch](https://techcrunch.com/2025/05/06/unblocked-raises-20-million-for-its-ai-assistant-to-help-devs-understand-legacy-codebases/)) |
| [Clearfeed](https://clearfeed.ai/) | $24/agent/mo or from $40/mo | Slack-native helpdesk; live niche player |
| [Mem](https://get.mem.ai/) | Free / Pro $12/mo / Agent $99/mo | $23.5M from OpenAI Startup Fund (2022); full product rewrite in 2025, traction unconfirmed |
| [Tanka](https://www.tanka.ai/) | no public pricing (early access) | Early stage; claims 92.3% on the LOCOMO memory benchmark, funding unconfirmed |
| [Coveo](https://www.coveo.com/) | quote-based | Public company (TSX:CVO), mature search platform |
| [OneBar](https://www.producthunt.com/products/onebar-io) | — | Effectively dead: no public activity since 2022 |

## Segment 2: knowledge organized through git

Who actually puts *knowledge* — docs, wikis, notes, decisions — into git,
and what sold. Four clusters emerge:

- **Docs-as-code SaaS (commercial, thriving).** Git is the store and the
  review mechanism, but the review is hidden behind "change requests" /
  "branch reviews" for non-engineers, and the product is aimed at *published
  documentation* (mostly external/API docs), not operational team memory.
- **Wiki-as-git (OSS baseline).** Git as a storage/sync backend, without a
  review workflow out of the box.
- **Personal knowledge on git (second brain).** Git is sync and durability,
  not review — single-player semantics; Dendron's death shows the
  team-knowledge version didn't take.
- **Decisions in git (ADR practice).** The pattern is an industry standard,
  but the tooling around it stalled — practice survives, products don't.

### Players

| Player | How git is used | Pricing | Traction / status |
|---|---|---|---|
| [GitBook](https://www.gitbook.com/) | Bidirectional Git Sync with GitHub/GitLab; change requests = branch→review→merge ([docs](https://docs.gitbook.com/getting-started/git-sync/enabling-github-sync)) | Free / Premium $65/site + $12/user / Ultimate $249/site + $12/user | 30,000 doc sites, ~120M pageviews/mo, customers Nvidia, Zoom, n8n; ~$35M round 2022 (secondary sources only); engine 29k★ |
| [Mintlify](https://www.mintlify.com/) | Pure docs-as-code: MDX + `docs.json` in git, CI checks, preview deploys per branch | Free / Pro ~$250–300/mo / Enterprise quote | YC W22; $67M total, Series B $45M at $500M valuation (a16z, 2026); claims 20,000+ companies incl. Anthropic, PayPal ([Series B](https://www.mintlify.com/blog/series-b)) |
| [ReadMe](https://readme.com/) | Bi-Directional Sync with GitHub/GitLab; Branch Reviews as PR-like review ([blog](https://readme.com/blog/branch-reviews)) | Free / Startup $99 / Business $399 / Enterprise from $3,000 per mo | YC W15; $9M Series A (Accel, 2019), 3,000+ companies at the time |
| [HackMD](https://hackmd.io/) | Team markdown notes, bidirectional GitHub sync ([tutorial](https://hackmd.io/c/tutorials/%2Fs%2Flink-with-github)) | freemium (not verified) | Live SaaS; self-hosted forks CodiMD 10.1k★, HedgeDoc 7.3k★ |
| [Wiki.js](https://js.wiki/) | Git (GitHub/GitLab/Gitea) as backup or source of truth, bidirectional interval sync ([docs](https://docs.requarks.io/storage/git)) | OSS, free, self-hosted | 28.7k★, active; single author, no company |
| GitHub / GitLab wiki | Every wiki is a cloneable git repo (`<repo>.wiki.git`) | bundled | The minimal "wiki = git" baseline; no review workflow; engine Gollum 14.3k★ |
| [Docusaurus](https://github.com/facebook/docusaurus) | Docs = markdown in git, site built by CI | OSS (Meta) | 65.8k★; used by React Native, Jest, Supabase |
| [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) | Same pattern; de-facto standard for OSS docs | OSS + Sponsors/Insiders | 27.2k★; FastAPI, Pydantic, etc. |
| [Logseq](https://logseq.com/) | Local-first notes with **built-in git auto-commit** | OSS | 44.2k★, active; $4.1M seed 2022 (Collison, Friedman, Lütke, Craft) |
| [Obsidian](https://obsidian.md/) + [obsidian-git](https://github.com/Vinzent03/obsidian-git) | Local markdown vaults; git sync via community plugin (11.7k★) | Free personal / paid Sync & Publish | Bootstrapped, 0 VC; ~1.5M MAU, ~$2M/yr revenue (estimates) |
| [Foam](https://github.com/foambubble/foam) | Notes in a local git-backed folder, VS Code | OSS | 17.3k★, slow-moving |
| [Quartz](https://github.com/jackyzha0/quartz) | Publishes "digital garden" sites from a git repo | OSS | 12.9k★, active |
| [Dendron](https://github.com/dendronhq/dendron) | Hierarchical notes in git, team vaults | was OSS + SaaS | **Dead**: development stopped March 2023 (YC W21); 7.5k★ |
| [adr-tools](https://github.com/npryce/adr-tools) / [log4brains](https://github.com/thomvaill/log4brains) | ADRs = markdown files in git next to code, reviewed via PR | OSS | The reference pattern; both stalled (last commits 2020 / 2024), 5.6k★ / 1.5k★ |
| [airbnb/knowledge-repo](https://github.com/airbnb/knowledge-repo) | Team knowledge base as a git repo with a review workflow | OSS | 5.5k★, stalled since 2024 — the closest artifact to "team KB as git", abandoned |
| [GitLab Handbook](https://handbook.gitlab.com/) | Entire company handbook (HR, finance — business content) is a git repo; all edits via merge requests, including non-engineers | dogfooding, not a product | The existence proof that "business knowledge via git review" works at scale |

### What the segment shows

- **Git-review for knowledge is always renamed.** GitBook says "change
  requests", ReadMe says "branch reviews" — the mechanic (branch → diff →
  approve → merge) is sold, the word "git" is not. The buyer is a docs or
  dev-tools team; business users get a visual editor on top.
- **The money is in *published* documentation, not internal memory.**
  Mintlify ($500M) and GitBook monetize external docs sites. Nobody monetizes
  the internal equivalent: decisions, facts, procedures with lineage.
- **Team-knowledge-as-git has been tried and abandoned at exactly our
  altitude**: Airbnb's knowledge-repo (git repo + review workflow for
  internal knowledge) is precisely the shape in question — open-sourced, then
  left to stall. Dendron (team vaults in git) died the same death. The lesson
  is not "the idea fails" but "a bare repo plus good intentions rots"; both
  corpses lack a product that keeps the base curated.
- **GitLab's handbook is the counter-existence-proof**: a whole company runs
  business knowledge through merge requests — but it works because GitLab is
  an engineering org living in git anyway, and no product came out of it.

## Verdict: the niche is empty at the intersection

No product sells "corporate memory as a git repository" — knowledge extracted
from work conversation, versioned, with diff/lineage/review as the core. The
edges are occupied: chat-KB tools extract but don't version (segment 1),
docs-as-code tools version but only published documentation, ADR practice
versions only decisions and only by engineers' hands. The absence is
structural: chat products have no structured journal to build versioning on,
and versioning tools have no conversation to version. WorkRoom has both.

Two honest counter-signals from the data:

- **The corpses are real.** Airbnb knowledge-repo and Dendron are the exact
  shape, abandoned. What they lacked — and what a chat-native product has by
  construction — is a steady, automatic inflow of distilled knowledge from
  where work actually happens, plus a reason for people to review it.
- **Git mechanics never sell under their own name.** Every survivor hides
  them: change requests, branch reviews, approvals. The winning shape is
  git's *benefits* — attribution, reversibility, review of proposed changes —
  through vocabulary a non-engineer already speaks. For WorkRoom this argues
  for versioned memory as a layer of the product (record:export, run
  attribution, explicit promotion already point that way), not as a
  standalone "git for knowledge" tool.

## Addendum: what WorkRoom already has for this, verified against code

Checked 2026-08-02 against `server/`, not just docs:

- **No point-in-time memory reads exist.** Every read is "now":
  `Memory::Store#context_for` takes only `limit`
  (`server/app/services/memory/store.rb:39`), every `Memory::Local` query
  scopes to `MemoryEntry.current` (`server/app/models/memory_entry.rb:17`),
  `GET /api/v1/channels/:slug/context` reads no version parameter, and
  `AgentSession` carries no memory-version field.
- **The journal is the version store, by construction.** `channel_records`
  is an append-only hash-chain (`seq`, `entry_hash`, `prev_hash`,
  `occurred_at` — `server/app/services/record_store/append.rb:24-43`), and
  every `remember`/`supersede` lands in it with full payload (`uri`, `title`,
  `detail`, `reason` — `server/app/services/rail/registry.rb:120-148`).
  Memory-state-at-seq-N is therefore a journal replay away: "a record that
  needs a live context store to be replayed is a cache of one"
  (`server/app/services/record_store/git_export.rb:12-15`).
- **The stores themselves cannot provide as-of, either of them.**
  `Memory::Local` is the dev/test/prototype fallback — production refuses to
  boot on it (`server/app/services/memory/selection.rb:28-48`) — and
  `Memory::OpenViking` keeps no version history (supersession moves the file
  to `superseded/`). So versioning belongs to the record layer, not to the
  pluggable store — which conveniently is also where the market gap is:
  pinning a session to a journal commit = a `memory_head_seq` on
  `agent_sessions` plus context rendered by replay to that seq. No store
  feature required, no competitor structurally able to copy it.

## Addendum 2: OpenViking's own primitives for lineage (v0.4.11)

Checked 2026-08-02 against the `volcengine/OpenViking` source at the tag
WorkRoom pins (`v0.4.11`, `server/config/deploy.yml:88`). The "no store
feature required" line above needs a correction: the pinned OpenViking
already ships git-style versioning, plus a workable metadata sidecar
convention.

**Snapshot API — native git versioning, already in v0.4.11**
(`openviking/server/routers/snapshot.py` at the tag). One git repository
(gitoxide) per account, i.e. per workspace:

- `POST /api/v1/snapshot/commit` — scoped `paths`, arbitrary `message`
  (carries `journal seq N`), author fields;
- `GET /api/v1/snapshot/log?paths=…` — history of commits touching a given
  uri: per-entry blame out of the box;
- `GET /api/v1/snapshot/show?target_ref=…&path=…` — reads a file at any
  commit: point-in-time reads *without* journal replay;
- `POST /api/v1/snapshot/restore` — forward-commit (never rewrites
  history), with `dry_run`; account `.ovgitignore` can exclude
  `superseded/`.

Caveats: commits are explicit only (no write hooks — Rails must commit);
the vector index is not versioned (rebuilt async after restore, watch for
`RESTORE_WRITEBACK_PARTIAL`); snapshots are per-account, not per-channel
(scoped `paths` partly compensates); none of snapshot/relations/set_tags is
exposed over MCP — the agent cannot write its own lineage, only Rails over
REST, which keeps metadata "index, not the record" by construction.
Requires `"git": {"enabled": true}` in `ov.conf` — WorkRoom's
`ov.conf.example` does not have the block yet.

**Metadata on an entry — no free-form field, but a sanctioned sidecar
convention.** There is no arbitrary key-value on a record
(`WriteContentRequest` is `extra="forbid"`). What exists: strict lowercase
`k=v` tags (filterable in `find`/`search`, AND semantics; WorkRoom already
writes `trust=`/`channel=`/`author=`/`source=`), native
`created_at`/`updated_at` with `since`/`until` filters, and a Relations API
(uri→uri links with a text `reason`, returned inside search results).

The sidecar finding, verified in their indexing code: a visible
`<entry>.meta.json` next to an entry **gets indexed** — `.json` is a
writable extension, the semantic DAG summarizes (LLM call) and vectorizes
every file in the directory, and it surfaces in `find`/`search` and in the
channel's `.overview.md`. A **dot-file** `.<entry>.meta.json` is skipped at
every stage — indexing (`semantic_dag.py:485`), `ls` without
`show_all_hidden`, `glob`, directory grep — and this is OpenViking's own
convention for its service files (`.meta.json` of sessions, `.abstract.md`,
`.overview.md`). `content/write` forbids their derived names but not
`.meta.json`; `content/read` has no hidden-file checks. Practical notes:
`fs/mv` is per-file, so supersede moves the sidecar with a second call;
writing a sidecar still triggers the directory's semantic refresh (the
overview regenerates — an LLM call whose content does *not* include the
sidecar); a dot-*directory* does not work (its non-dot children get
indexed). The dot-skip is one `if` upstream — worth a contract test in
WorkRoom ("dot-sidecar never appears in `find`/`ls`").

Net: the journal stays the source of truth, but session pinning no longer
needs journal replay as the only mechanism — a snapshot oid on
`agent_sessions` (Rails commits after memory writes, message carries the
journal seq) gives point-in-time reads via `show`, and per-entry lineage
via `log?paths` and relations.
