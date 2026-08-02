# Spike: the open-source agent-UI landscape, and what WorkRoom should take from it

Research deliverable for #229. Motivation: the desktop client is the room's
window onto the agent, and we are designing its development interface without
having looked hard at what the open-source world already converged on. This
spike surveys opencode and its web/desktop analogs and extracts the patterns
worth adopting.

**Verified against** the projects' own repos and docs (links throughout);
stars and licenses checked via the GitHub API on 2026-08-02. No code was run
except our own — behavioural claims come from documentation, not from driving
each tool.

## opencode is not a TUI; it is a server with clients

The repo moved from `sst/opencode` to `anomalyco/opencode` (same team; the old
name redirects). MIT, ~192k stars, TypeScript/Bun monorepo. The architectural
fact that matters for us: **every `opencode` invocation starts a server and a
client**. The TUI (SolidJS rendered into the terminal via OpenTUI), the web UI
(`opencode web`), the Electron desktop beta, and the IDE extensions are all
equal clients of one HTTP server (Hono, OpenAPI spec at `/doc`, SDK generated
from it, state streamed over SSE). `opencode serve` runs headless; `opencode
acp` exposes the same runtime as an ACP server for Zed and JetBrains
([docs](https://opencode.ai/docs/server/), [ACP](https://opencode.ai/docs/acp/)).

That is our desktop↔agent seam, arrived at independently from the other side:
they started from a terminal and grew a server; we started from a room and
grew ACP. Their API surface is a good checklist for what a client may
legitimately want to do to a session: fork at any message, abort, share,
server-computed per-session diff, revert/unrevert, summarize, respond to
permission requests, and even drive the attached TUI remotely (that last one
is how their VS Code extension controls a running terminal session).

Three opencode ideas worth stealing outright:

1. **Plan mode is an agent with different permissions, not a mode flag.**
   `build` and `plan` are two primary agents toggled with Tab; plan is just
   read-only (edits denied, bash asks). Permissions are glob-patterned per
   tool (`bash: { "*": "ask", "git status *": "allow" }`) and permission
   requests are answered through the API (`POST /permissions/:id`), so any
   client can render the prompt. This maps one-to-one onto ACP's
   `session/request_permission` — there is no excuse for the permission UI to
   live inside the agent process.
2. **Undo is built on git, per message.** `/undo` reverts a message's file
   changes and restores the prompt for editing; sessions fork at any message;
   the server computes the session diff. The unit of recovery is the message,
   not the session.
3. **Subagents are child sessions**, navigable parent↔child in the UI — the
   session list is a tree, not a flat history.

## The ACP-native reference: Zed's agent panel

Zed (GPL/AGPL/Apache-2.0 depending on the part) is the canonical ACP client —
its behaviour is effectively the protocol made visible, so matching its
mental model is what makes external ACP agents feel native
([docs](https://zed.dev/docs/ai/agent-panel)). What it does better than
anyone:

- **Threads as first-class objects**: parallel threads per project,
  archivable, auto-titled, "New From Summary" compacts a long thread into a
  fresh one. Each thread owns its agent, context, and history.
- **A checkpoint on every message**, with "Restore Checkpoint" available even
  mid-edit after an interrupt — which is exactly when you want it.
- **Review Changes as a multi-buffer**: all diffs from the thread in one tab
  with per-hunk accept/reject. The review surface is separate from the chat
  and accumulates across messages.
- **Message queueing vs Steer**: messages sent during generation queue by
  default; toggling Steer interrupts the agent at its next tool-call
  boundary. Also: past user messages are editable and resubmittable.
- **Follow the agent**: a crosshair toggle makes the editor jump to each file
  the agent touches — the cheapest possible "what is it doing right now".

Other ACP clients exist and are readable proof-of-feasibility for our stack:
[Jockey](https://github.com/recailai/jockey) (Tauri + Rust + SolidJS,
multi-agent orchestrator) and [AionUi](https://github.com/iofficeai/aionui)
(Electron + React, auto-detects installed CLI agents, cron tasks, chat-bridge
bots). Registry: [agentclientprotocol.com](https://agentclientprotocol.com/get-started/clients).

## Permissions and recovery: Cline / Roo Code

One lineage (Roo is a Cline fork), both Apache-2.0, VS Code extensions. Their
contribution is the most thought-through **trust UX**:

- **Plan / Act split** as the central composer control (Cline), generalised
  by Roo into **custom modes = persona + tool permissions + file-restriction
  globs**, each with a "when to use" description shown in the picker. A mode
  is a capability profile, selectable per task — opencode's build/plan made
  user-extensible.
- **Cline's three-way checkpoint restore**: shadow-git snapshots per step,
  and the restore menu offers *Files only* / *Task only* / *Files & Task*.
  Separating "the code went wrong" from "the conversation went wrong" is the
  cleanest decomposition of agent-damage undo anywhere in this survey.
- **Granular auto-approve matrix** per action type (reads / edits / commands
  / browser / MCP), so trust is a dial per category, not a switch.
- Roo's **Boomerang tasks**: an orchestrator spawns subtasks in isolated
  contexts and receives back only a summary — context isolation as a visible
  UI concept (parent task shows its delegated children). Adjacent to our
  channel model.

## Standalone desktop apps: opcode, AiderDesk, goose

- **[opcode (Claudia)](https://github.com/winfunc/opcode)** — AGPL, Tauri 2 +
  React + SQLite, ~22k stars, a desktop GUI wrapping Claude Code. The closest
  architectural sibling to WorkRoom. Standout: a **visual branching timeline
  of checkpoints** — one-click restore, fork-from-checkpoint, and a diff
  viewer *between* checkpoints. Plus project→session two-level browsing and a
  first-class usage/cost dashboard.
- **[AiderDesk](https://github.com/hotovo/aider-desk)** — Apache-2.0,
  Electron. The best **steerability** UX: tasks live in git worktrees with a
  review-and-merge-back flow; tasks fork; **individual messages can be
  deleted from history** — context treated as user-editable state; strict
  per-tool approval gates; cost dashboards as a screen, not a footer.
- **[goose](https://github.com/aaif-goose/goose)** — Apache-2.0, Rust core +
  Electron. **Four graduated autonomy levels** (Completely Autonomous /
  Smart Approval / Manual Approval / Chat Only) switchable mid-session with
  immediate effect; Smart Approval auto-approves what it classifies as
  low-risk. And **passthrough permission proxying**: when goose wraps another
  CLI agent, that agent's native permission prompts are routed through
  goose's UI — the exact analogue of us rendering ACP permission requests.

## Web UIs: OpenHands, Vibe Kanban, and the chat polish layer

- **[OpenHands](https://github.com/OpenHands/openhands)** — MIT, ~83k stars,
  and it now speaks ACP. The proven layout: **chat on the left, a tabbed
  workspace on the right** — Changes (git diff vs HEAD, always available),
  embedded editor, terminal, browser/app preview. The chat explains; the tabs
  are the agent's visible body. Agent events render as discrete collapsible
  cards, never raw log lines, and a persistent status bar carries agent state
  (running/waiting/errored) outside the message stream.
- **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)** — Apache-2.0,
  ~27k stars, sunsetting but the most-copied UX of its year. **The kanban
  card is the session manager**: each execution gets its own worktree,
  branch, terminal, dev server. And the killer detail: **inline diff comments
  are sent back to the agent as its next prompt** — the review loop closes in
  one surface. Of everything here, this is the closest to WorkRoom's "channel
  of work" metaphor.
- **claudecodeui** ([siteboon](https://github.com/siteboon/claudecodeui),
  AGPL): tools **disabled by default** and enabled selectively — opt-in
  permissions, not opt-out; a git explorer in the sidebar so review-and-commit
  never leaves the app; existing CLI sessions discovered and resumed.
- **Open WebUI / LibreChat**: thin on coding specifics, but the polish layer
  is theirs — collapsible tool-call cards with status inside the message
  bubble, smooth streaming with a scroll-to-bottom affordance, fork-from-any-
  message, cross-session search, side-panel artifacts.

## Comparison

| Project | Shape | License | The one idea to take |
|---|---|---|---|
| opencode | server + equal clients (TUI/web/desktop) | MIT | plan = permission profile; permission prompts via API |
| Zed agent panel | editor panel, ACP-native | GPL | per-message checkpoints; multi-buffer hunk-level review |
| Cline / Roo | VS Code extension | Apache-2.0 | three-way restore (files / task / both); modes = persona + rights |
| opcode | Tauri desktop over Claude Code | AGPL | branching checkpoint timeline with inter-checkpoint diffs |
| AiderDesk | Electron desktop | Apache-2.0 | message-level history editing; tasks in worktrees |
| goose | Rust core + desktop | Apache-2.0 | four autonomy levels, switchable mid-session; prompt passthrough |
| OpenHands | web app, speaks ACP | MIT | chat left, tabbed Changes/Editor/Terminal/Browser right |
| Vibe Kanban | web kanban over agents | Apache-2.0 | diff comments returned to the agent as its next prompt |
| Open WebUI / LibreChat | general chat | BSD-ish / MIT | tool cards, streaming polish, fork anywhere |

## What this means for WorkRoom

The single strongest convergence across the whole survey: **every successful
interface separates doing from reviewing.** The chat stream carries intent
and progress; approval happens on a dedicated, persistent diff surface — not
inline in the conversation — and approval is graduated (per-call allow/deny →
risk-based auto-approve → full autonomy) and switchable mid-session. Tools
that bury diffs in the chat or offer only binary trust lose users to the ones
that don't.

Concretely, in order of leverage for the desktop client:

1. **Take Zed's mental model wholesale** — we speak ACP, so threads,
   per-message checkpoints, steering, and profiles are the vocabulary
   external agents will already expect. Deviating buys nothing.
2. **A persistent Changes surface** (OpenHands/Vibe Kanban shape), fed by the
   session's git diff, with hunk-level review; inline comments on the diff go
   back into the session as the next user message. This closes the review
   loop without leaving the room.
3. **Graduated autonomy** (goose's four levels, Cline's per-category
   auto-approve), rendered from ACP `session/request_permission` — a per-
   session dial, not a settings page.
4. **Checkpoints per message** with the three-way restore decomposition
   (files / conversation / both). Our record store already versions
   everything the room sees; the missing half is the file-system snapshot,
   where Cline's shadow-git is the proven cheap answer.
5. **Message-level curation** (AiderDesk: delete/edit/resubmit) — the user
   owns the context, and the UI says so.

And the asymmetry worth remembering: **everything in this survey is
single-player.** Session lists, timelines, kanban boards — all of them manage
*my* agents on *my* machine. WorkRoom's channel is shared memory with
multiple people and their agents in it by design; the session list here is
naturally "who is in the room and what their agent is doing", which none of
these tools can express at all. The patterns above are worth borrowing; the
premise they are built on is not.

## Sources

- opencode: [repo](https://github.com/anomalyco/opencode),
  [docs](https://opencode.ai/docs/), [server](https://opencode.ai/docs/server/),
  [ACP](https://opencode.ai/docs/acp/), [agents/permissions](https://opencode.ai/docs/agents/)
- Zed: [repo](https://github.com/zed-industries/zed),
  [agent panel](https://zed.dev/docs/ai/agent-panel)
- Cline: [repo](https://github.com/cline/cline),
  [checkpoints](https://docs.cline.bot/core-workflows/checkpoints)
- Roo Code: [repo](https://github.com/RooCodeInc/Roo-Code),
  [boomerang tasks](https://docs.roocode.com/features/boomerang-tasks)
- opcode: [repo](https://github.com/winfunc/opcode)
- AiderDesk: [repo](https://github.com/hotovo/aider-desk)
- goose: [repo](https://github.com/aaif-goose/goose),
  [permissions](https://goose-docs.ai/docs/guides/managing-tools/goose-permissions/)
- OpenHands: [repo](https://github.com/OpenHands/openhands),
  [GUI guide](https://docs.all-hands.dev/openhands/usage/how-to/gui-mode)
- Vibe Kanban: [repo](https://github.com/BloopAI/vibe-kanban)
- claudecodeui: [repo](https://github.com/siteboon/claudecodeui)
- ACP registry: [clients](https://agentclientprotocol.com/get-started/clients);
  [Jockey](https://github.com/recailai/jockey), [AionUi](https://github.com/iofficeai/aionui)
