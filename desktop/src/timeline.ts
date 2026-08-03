// The room, drawn: what was said, the conversations beside it, and what a run
// is doing while it works. It owns the record of the open channel — every
// message, not only the ones on screen — because the turn's history is read
// from the record and the page is only how much of it fits.

import type { Channel, Message } from "./api";
import { StepLedger, contentTypeFor, preExistingNotice, dayLabel, formatHistory, identity, inTimeline, offerable, onScreen, threadOf, threadSummary, timeLabel, transcriptName, worthOffering, githubTreeUrl, type Asked, type PlanEntry, type TurnProduced } from "./rules";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// A room with ten thousand messages in it should not put ten thousand elements
/// on screen. What is kept is the recent end, because that is what people read.
export const ON_SCREEN = 200;

const AT_MOST_OFFERED = 12;   // an offer nobody can read is worse than no offer

/// What the timeline draws but does not decide. Everything here belongs to
/// somebody else: the unread count is the channel list's, the answer to a
/// permission is the agent's, and the work product is on this machine.
export interface TimelineDeps {
  /// A message the room has put on screen, so the channel list can count what
  /// this person has seen.
  onShown: (m: Message) => void;
  permit: (name: string, askedId: unknown, optionId: string | null) => Promise<void>;
  produced: (workspace: string) => Promise<TurnProduced>;
  readFile: (workspace: string, path: string) => Promise<string>;
  attach: (runId: number, path: string, base64: string, contentType: string) => Promise<void>;
  exportSession: (name: string, sessionId: string) => Promise<string | null>;
  attachTranscript: (runId: number, name: string, body: string) => Promise<void>;
  /// The room's repository, for the commit row's link (#206). Where the link
  /// would lead nowhere — no url, not GitHub — the control is hidden, not
  /// offered dead.
  repositoryUrl?: () => string | null;
  copyText?: (text: string) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
}

/// An artifact as the channel's listing serves it — enough to draw the row the
/// live socket would have drawn (#160).
export interface ChannelArtifact {
  id: number; name: string; kind: string | null; created_at: string;
}

export interface Timeline {
  open(channel: Channel & { messages: Message[] }, artifacts?: ChannelArtifact[]): void;
  add(m: Message): void;
  /// Everything this channel has said, in the order it was said. The turn reads
  /// it, and so does anything that has to know what the page left out.
  held(): Message[];
  recentHistory(limit?: number): string | null;
  /// Which conversation the panel is showing, so a reply typed there is posted
  /// against its root and not against the room.
  openThread(): number | null;
  closeThread(): void;
  addStep(runId: number, label: string, id?: number): void;
  revealSteps(on: boolean): void;
  showPlan(runId: number, entries: PlanEntry[]): void;
  addArtifact(a: { id: number; name: string; kind: string | null }): void;
  askPermission(name: string, asked: Asked, note?: string | null): void;
  offerProduced(runId: number, workspace: string): Promise<void>;
  offerTranscript(runId: number, name: string, sessionId: string): void;
}

export const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/// A button for something that can fail. While it runs it says so and cannot be
/// pressed again; if it fails it says why and can be pressed again. Every offer
/// and every notice wanted the same six lines, and each wrote its own.
export function ghostButton(label: string, busy: string, work: () => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "ghost";
  button.textContent = label;
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = busy;
    try {
      await work();
    } catch (err) {
      button.disabled = false;
      button.textContent = label;
      alert(String(err));
    }
  };
  return button;
}

/// The latest revision replaces the one on screen; the record keeps them all.
const PLAN_MARK: Record<string, string> = {
  completed: "✓", in_progress: "→", pending: "·",
};

export function createTimeline(deps: TimelineDeps): Timeline {
  let held: Message[] = [];      // every message of the open channel
  let openThread: number | null = null;
  // A local view preference, not a property of the session. The record is
  // complete either way; this only decides how much of it is on screen.
  let stepsShown = true;
  const stepLedger = new StepLedger();
  const runSteps = new Map<number, string[]>();

  /// How the room names whoever said it, and how the agent reads it back.
  const whoSaid = (m: Message) =>
    m.author.kind === "agent" ? `${m.author.name}'s agent` : m.author.name;

  function messageEl(m: Message) {
    const el = document.createElement("div");
    el.className = `msg ${m.author.kind}`;
    el.dataset.id = String(m.id);
    const id = identity(m.author);
    // A face, then a head line (name, mark, time), then what was said.
    el.innerHTML =
      `<span class="avatar${id.isAgent ? " is-agent" : ""}" style="--hue:${id.hue}">` +
      `${escape(id.initials)}</span><div class="msg-main"><div class="msg-head">` +
      `<span class="from">${escape(whoSaid(m))}</span>` +
      (id.isAgent ? `<span class="agent-badge">agent</span>` : "") +
      `<span class="msg-time">${escape(timeLabel(m.created_at))}</span>` +
      `</div><div class="body"></div></div>`;
    const body = el.querySelector<HTMLElement>(".body")!;
    body.textContent = m.body;

    const root = m.parent_id ?? m.id;
    const reply = document.createElement("button");
    reply.className = "reply-action";
    reply.textContent = "Reply";
    reply.onclick = () => showThread(root);
    body.append(document.createElement("br"), reply);
    return el;
  }

  /// What the room is told about a conversation happening beside it.
  function refreshSummaries() {
    for (const el of document.querySelectorAll<HTMLElement>("#messages .msg")) {
      el.querySelector(".thread-summary")?.remove();
      const id = Number(el.dataset.id);
      const summary = threadSummary(held.filter((m) => m.parent_id === id));
      if (!summary) continue;

      const button = document.createElement("button");
      button.className = "thread-summary";
      button.textContent = summary;
      button.onclick = () => showThread(id);
      el.querySelector(".body")!.append(button);
    }
  }

  /// One level, in a panel of its own. Nesting a second level inside the room is
  /// what makes people stop replying at all.
  function showThread(rootId: number) {
    openThread = rootId;
    $("thread").hidden = false;
    const box = $("thread-messages");
    box.innerHTML = "";
    for (const m of threadOf(held, rootId)) box.append(messageEl(m));
    box.scrollTop = box.scrollHeight;
  }

  function closeThread() {
    openThread = null;
    $("thread").hidden = true;
  }

  function add(m: Message) {
    if (!held.some((h) => h.id === m.id)) held.push(m);

    if (openThread !== null && (m.id === openThread || m.parent_id === openThread)) {
      showThread(openThread);
    }
    if (!inTimeline(m)) { refreshSummaries(); return; }

    const box = $("messages");
    if (box.querySelector(`[data-id="${m.id}"]`)) return;
    box.querySelector(".intro")?.remove();

    const day = m.created_at.slice(0, 10);
    if (!box.querySelector(`.day[data-day="${day}"]`)) {
      const divider = document.createElement("div");
      divider.className = "day";
      divider.dataset.day = day;
      divider.textContent = dayLabel(m.created_at);
      box.append(divider);
    }

    box.append(messageEl(m));
    box.scrollTop = box.scrollHeight;

    deps.onShown(m);
    refreshSummaries();
  }

  /// A new room is not a blank page. It says what it is for and what to try.
  function showIntro(channel: Channel) {
    const el = document.createElement("div");
    el.className = "intro";
    const purpose = channel.purpose ? `${channel.purpose}\n\n` : "";
    el.textContent = `${purpose}Nothing has been said here yet. Talk to the room, ` +
      `or address your agent with @agent and it will start from what this room knows.`;
    $("messages").append(el);
  }

  function open(channel: Channel & { messages: Message[] }, artifacts: ChannelArtifact[] = []) {
    $("messages").innerHTML = "";
    held = [ ...channel.messages ];
    closeThread();

    const shown = onScreen(channel.messages.filter(inTimeline), ON_SCREEN);
    if (shown.hidden) {
      const earlier = document.createElement("div");
      earlier.className = "earlier";
      earlier.textContent = `${shown.hidden} earlier messages are not shown`;
      $("messages").append(earlier);
    }
    if (channel.messages.length || artifacts.length) {
      // What was said and what was attached, drawn in the order it happened —
      // the same order watching the room live would have shown (#160).
      [ ...shown.messages.map((m) => ({ at: m.created_at, draw: () => add(m) })),
        ...artifacts.map((a) => ({ at: a.created_at, draw: () => addArtifact(a) })) ]
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .forEach((row) => row.draw());
    } else {
      showIntro(channel);
    }
  }

  /// The last few turns of the room, as the agent would read them. From the
  /// record rather than the page: a message that scrolled past the cap was
  /// still said, and a turn answering without it is answering half a room.
  ///
  /// The room's own messages, which is what the page shows and what the scrape
  /// this replaced could reach. A side conversation is deliberately not context
  /// — it is beside the room, and the agent is answering the room.
  function recentHistory(limit = 20): string | null {
    const rows = held.filter(inTimeline).map((m) => ({ who: whoSaid(m), what: m.body }));
    return formatHistory(rows, limit);
  }

  /// Steps are why a minutes-long turn is legible instead of silent. Under the
  /// default level only the owner receives them, so a colleague sees the run line
  /// and not the forty tool calls behind it.
  function addStep(runId: number, label: string, id?: number) {
    if (!stepLedger.admit(id)) return;   // may arrive on both streams
    addStepLine(runId, label);
  }

  function addStepLine(runId: number, label: string) {
    const box = $("messages");
    let holder = box.querySelector<HTMLElement>(`.steps[data-run="${runId}"]`);
    if (!holder) {
      holder = document.createElement("div");
      holder.className = "steps";
      holder.dataset.run = String(runId);
      holder.hidden = !stepsShown;
      box.append(holder);
    }
    const line = document.createElement("div");
    line.textContent = `· ${label}`;
    holder.append(line);
    box.scrollTop = box.scrollHeight;
    runSteps.set(runId, [ ...(runSteps.get(runId) ?? []), label ]);
  }

  /// The preference is the timeline's, so a run that starts while steps are off
  /// arrives off — the checkbox is not asked again for every new run.
  function revealSteps(on: boolean) {
    stepsShown = on;
    document.querySelectorAll<HTMLElement>(".steps").forEach((el) => { el.hidden = !on; });
  }

  function showPlan(runId: number, entries: PlanEntry[]) {
    const box = $("messages");
    const id = `plan-${runId}`;
    const el = document.getElementById(id) ?? document.createElement("div");
    el.id = id;
    el.className = "plan";
    el.innerHTML = "";
    for (const e of entries) {
      const line = document.createElement("div");
      line.className = `plan-entry ${e.status ?? ""}`;
      line.textContent = `${PLAN_MARK[e.status ?? "pending"] ?? "·"} ${e.content}`;
      el.append(line);
    }
    if (!el.isConnected) box.append(el);
    box.scrollTop = box.scrollHeight;
  }

  function addArtifact(a: { id: number; name: string; kind: string | null }) {
    const el = document.createElement("div");
    el.className = "artifact";
    el.textContent = `\u{1F4CE} ${a.name}`;
    $("messages").append(el);
  }

  /// The agent is waiting on a person, so this goes where that person is looking.
  /// It is process rather than outcome, so it is theirs alone (Article S2).
  ///
  /// `note` is what the ask means, computed by whoever knows the workspace —
  /// a push to a deploying branch is not the same question as a push to a
  /// feature branch (#205). Annotation only: the options stay the agent's.
  function askPermission(name: string, asked: Asked, note?: string | null) {
    const box = $("messages");
    const el = document.createElement("div");
    el.className = "offer ask";
    el.append(document.createTextNode(`${asked.title} `));

    if (note) {
      const line = document.createElement("div");
      line.className = "ask-note muted";
      line.textContent = note;
      el.append(line);
    }

    const answer = async (optionId: string | null) => {
      el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await deps.permit(name, asked.id, optionId);
        el.textContent = `${asked.title} — ${optionId ?? "not answered"}`;
      } catch (err) {
        el.querySelectorAll("button").forEach((b) => (b.disabled = false));
        alert(String(err));
      }
    };

    // The options are the agent's. Nothing is added and nothing is reinterpreted.
    for (const option of asked.options) {
      const button = document.createElement("button");
      button.className = "ghost";
      button.textContent = option.name;
      button.onclick = () => answer(option.id);
      el.append(button);
    }

    box.append(el);
    box.scrollTop = box.scrollHeight;
  }

  /// The turn's work as a commit (#206). It leads the offer: a commit is the
  /// turn saying "done", and the uncommitted files after it are the work
  /// still on the table. The mark on a mainline commit is the one thing in
  /// the room drawn in the accent colour — the one offer that can ship.
  function commitRow(c: NonNullable<TurnProduced["committed"]>): HTMLElement {
    const el = document.createElement("div");
    el.className = "offer committed";
    const plural = c.commits === 1 ? "commit" : "commits";
    el.append(document.createTextNode(
      `⎇ ${c.branch} · ${c.commits} ${plural}${c.stat ? ` · ${c.stat}` : ""} `));

    if (c.on_default) {
      const mark = document.createElement("span");
      mark.className = "on-default";
      mark.textContent = `on ${c.branch}`;
      el.append(mark, document.createTextNode(" "));
    }

    // "Copied" staying on the button is the confirmation; there is no other
    // sign the clipboard took it.
    el.append(ghostButton("Copy branch name", "Copied", async () => {
      await deps.copyText?.(c.branch);
    }));

    const url = githubTreeUrl(deps.repositoryUrl?.() ?? null, c.branch);
    if (url && deps.openUrl) {
      // Not ghostButton: the row outlives the action, and a button left
      // saying "Opening…" forever would read as a broken one.
      const open = document.createElement("button");
      open.className = "ghost";
      open.textContent = "Open on GitHub";
      open.onclick = () => { deps.openUrl!(url).catch(() => {}); };
      el.append(open);
    }
    return el;
  }

  /// What the run wrote in its working directory, offered one file at a time.
  /// Offered, not uploaded: work product belongs to the channel (Article D3), but
  /// what leaves this machine stays the person's decision.
  async function offerProduced(runId: number, workspace: string) {
    const { files: produced, pre_existing, committed } = await deps.produced(workspace);
    if (!committed && !worthOffering(produced)) {
      // A quiet account of what the turn was not credited with — without it,
      // "the agent did nothing" and "the offer is broken" look the same.
      const notice = preExistingNotice(pre_existing);
      if (notice) {
        const note = document.createElement("div");
        note.className = "offer muted";
        note.textContent = notice;
        $("messages").append(note);
      }
      return;
    }
    const { files, omitted } = offerable(produced, AT_MOST_OFFERED);

    const box = $("messages");
    if (committed) box.append(commitRow(committed));
    for (const file of files) {
      const el = document.createElement("div");
      el.className = "offer";
      el.append(document.createTextNode(`${file.path} · ${Math.ceil(file.bytes / 1024)} kB `));

      el.append(ghostButton("Share with the channel", "Sharing…", async () => {
        const body = await deps.readFile(workspace, file.path);
        await deps.attach(runId, file.path, body, contentTypeFor(file.path));
        el.remove();
      }));
      box.append(el);
    }
    if (omitted) {
      const note = document.createElement("div");
      note.className = "offer muted";
      note.textContent = `${omitted} more files changed and are not offered.`;
      box.append(note);
    }
    box.scrollTop = box.scrollHeight;
  }

  /// Attaching is a decision made with the work in front of you, so it is an
  /// action on the finished run rather than a setting chosen once in the abstract.
  function offerTranscript(runId: number, name: string, sessionId: string) {
    const box = $("messages");
    const el = document.createElement("div");
    el.className = "offer";

    el.append(ghostButton("Attach transcript", "Attaching…", async () => {
      const body = await deps.exportSession(name, sessionId);
      if (!body) { el.textContent = "This agent keeps no transcript."; return; }
      await deps.attachTranscript(runId, transcriptName(runId, new Date()), body);
      el.remove();
    }));
    box.append(el);
    box.scrollTop = box.scrollHeight;
  }

  return {
    open, add, closeThread, addStep, revealSteps, showPlan, addArtifact, askPermission,
    offerProduced, offerTranscript, recentHistory,
    held: () => held,
    openThread: () => openThread,
  };
}
