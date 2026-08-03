import { Api, type Channel, type Live } from "./api";
import { WorkingSignal, missingFrom, channelToCreate, enterRoom, reachableRooms, tokenForRoom, boundFolder, driftNotice, updateNotice, orAfter, identity, pickable, templateNote, defaultAgent, occupancyLabel, parseAddress, unreadCount, withClosing, gitBoundary, gitAskNote, type RoomTemplate, type RunSignal } from "./rules";
import { Agents, type Update } from "./agent";
import { createTimeline, escape, ghostButton } from "./timeline";
import { createAgentsPanel } from "./agents-panel";
import { createChannelSettings, type RepoInfo } from "./channel-settings";
import { createProvision, type FolderState } from "./provision";
import { createHumanGate, type HumanChangeSet } from "./human-changes";
import { createReviewDialog } from "./review-changes";
import { showOnboarding } from "./onboarding";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import * as settings from "./settings";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";

const api = new Api(import.meta.env.VITE_WORKROOM_SERVER ?? "http://127.0.0.1:3000");
const agents = new Agents(settings.load());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let channels: Channel[] = [];
let current: Channel | null = null;
let socket: Live | null = null;

// ---------- rendering ----------

/// What each channel has that you have not seen, and whether anyone's agent is
/// at work in it. Both read from state, never recomputed per surface.
const seenCount = new Map<string, number>();
let bindings = settings.loadBindings();
/// Where installs go: a directory this application owns, and the same one the
/// bridge looks in. An agent installed anywhere else would read as missing the
/// moment it finished installing.
let prefix = "";
/// Where this person is, and what reaches the rooms they have a way into.
let rooms = settings.loadWorkspaces();

/// The room, and the agents. Two clusters that own their own state and their
/// own corner of the page; what is left here is what crosses between them —
/// boot, the open channel, presence, and the turn.
const timeline = createTimeline({
  onShown: () => {
    if (current) seenCount.set(current.slug, (seenCount.get(current.slug) ?? 0) + 1);
  },
  permit: async (name, askedId, optionId) => { await agents.permit(name, askedId, optionId); },
  produced: (workspace) => agents.produced(workspace),
  readFile: (workspace, path) => agents.read(workspace, path),
  attach: async (runId, path, body, contentType) => {
    await api.attachBytes(runId, path, body, contentType);
  },
  exportSession: (name, sessionId) => agents.exportSession(name, sessionId),
  attachTranscript: async (runId, name, body) => { await api.attachArtifact(runId, name, body); },
  repositoryUrl: () => current?.repository_url ?? null,
  copyText: (text) => navigator.clipboard.writeText(text),
  openUrl: (url) => openUrl(url),
});

// The preview photographs states that have no natural trigger — a turn's
// offer exists only after a turn, and no button leads there. Named and
// narrow: this is how `bin/preview` stages the commit row (#206), not a
// public API.
(window as unknown as { __workroom: unknown }).__workroom = { timeline };

const panel = createAgentsPanel({
  agents,
  prefix: () => prefix,
  openSession: async (name) => {
    if (!current) return;
    const dir = boundFolder(current.slug, bindings)
      ?? await agents.workspace(rooms.current!, current.slug);
    await agents.sessionFor(name, current.slug, dir, api.rail(current.slug));
  },
  onTrouble: (message) => alert(message),
  currentChannel: () => current,
});

/// The room's setting and this machine's folder choice, in one dialog (#203).
const channelSettings = createChannelSettings({
  currentChannel: () => current,
  workspaceSlug: () => rooms.current ?? null,
  updateChannel: (slug, url) => api.updateChannel(slug, url),
  bindings: () => bindings,
  bind: (slug, folder) => { bindings = settings.bind(slug, folder); },
  chooseFolder: (title) => chooseFolder({ directory: true, title }) as Promise<string | null>,
  derivedFolder: () => agents.workspace(rooms.current!, current!.slug),
  clone: (url, dir) => invoke<void>("agent_clone", { url, dir }),
  repoInfo: (path) => invoke<RepoInfo>("agent_repo_info", { path }),
  releaseChannel: (slug) => agents.releaseChannel(slug),
  applied: (updated) => {
    current = current ? { ...current, ...updated } : updated;
    renderBinding();
  },
  copyText: (text) => navigator.clipboard.writeText(text),
});

/// The channel's folder, made ready on its own when the room names a
/// repository (#204). Local from end to end: the rows are this machine's
/// process, never said to the room.
const provision = createProvision({
  bindings: () => bindings,
  derivedPath: (slug) => invoke<string>("agent_derived_path",
    { workspace: rooms.current!, channel: slug }),
  folderState: (dir) => invoke<FolderState>("agent_folder_state", { dir }),
  clone: (url, dir) => invoke<void>("agent_clone", { url, dir }),
  isOpen: (slug) => current?.slug === slug,
  openSettings: () => channelSettings.open(),
});

/// Runs executing right now. While one is, the gate does not measure: the
/// run's own work is not the person's unreviewed changes (#207).
let activeRuns = 0;

/// The local agent, asked a local question (#207). No run is started and
/// nothing is posted: the room never learns the question was asked, because
/// the summary orients the person in their own unreviewed work — it is not a
/// turn, and charging the room for it would be a lie about who asked. Null
/// whenever asking is impossible: no agent running, or one mid-run that
/// should not be handed a second question.
function localQuestion(): ((question: string, context: string) => Promise<string>) | null {
  if (!current || activeRuns > 0) return null;
  const name = defaultAgent(agents.definitions());
  if (!name || !agents.isRunning(name)) return null;
  const channel = current;
  return async (question, context) => {
    const workspace = boundFolder(channel.slug, bindings)
      ?? await agents.workspace(rooms.current!, channel.slug);
    const sessionId = await agents.sessionFor(name, channel.slug, workspace,
                                              api.rail(channel.slug));
    let reply = "";
    const stop = await agents.onUpdate(sessionId, (u: Update) => {
      if (u.kind === "text") reply += u.text;
    });
    try {
      await agents.prompt(name, sessionId, question, context, null);
    } finally {
      stop();
    }
    return reply.trim();
  };
}

/// The review dialog: the gate's Review and Commit buttons lead here.
const reviewDialog = createReviewDialog({
  fileDiff: (dir, path) => invoke<string>("agent_file_diff", { dir, path }),
  commit: (dir, paths, message) => invoke<string>("agent_commit", { dir, paths, message }),
  gitInit: (dir) => invoke<void>("agent_git_init", { dir }),
  humanChanges: (dir) => invoke<HumanChangeSet>("agent_human_changes", { dir }),
  personName: () => $("who").textContent || "you",
  askAgent: localQuestion,
  resolve: (how, sha) => humanGate.resolve(how, sha),
  recheck: () => { if (current) humanGate.check(current); },
});

/// Work the person wrote outside any run pauses runs until it is reviewed.
/// The banner and the feed row are this machine's; the room is never told.
const humanGate = createHumanGate({
  humanChanges: (dir) => invoke<HumanChangeSet>("agent_human_changes", { dir }),
  stash: (dir) => invoke<void>("agent_stash", { dir }),
  folderFor: async (channel) => boundFolder(channel.slug, bindings)
    ?? await invoke<string>("agent_derived_path",
      { workspace: rooms.current!, channel: channel.slug }),
  runActive: () => activeRuns > 0,
  isOpen: (slug) => current?.slug === slug,
  // Every Review and Commit button lands in the dialog; the resolutions
  // come back through `resolve` above, so both doors end the same cycle.
  openReview: (changes, folder) => reviewDialog.open(changes, folder),
  onChange: () => renderBinding(),
});

function renderChannels() {
  $("channels").innerHTML = "";
  for (const c of channels) {
    const b = document.createElement("button");
    b.className = c.slug === current?.slug ? "active" : "";
    b.onclick = () => open(c.slug);

    const name = document.createElement("span");
    name.textContent = `# ${c.slug}`;
    b.append(name);

    const unread = unreadCount(c.message_count ?? 0, seenCount.get(c.slug));
    if (unread && c.slug !== current?.slug) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = String(unread);
      b.append(pill);
      b.classList.add("unread");
    }

    if (working.inChannel(c.slug).length) {
      const dot = document.createElement("span");
      dot.className = "working-dot";
      dot.title = working.label(c.slug) ?? "";
      b.append(dot);
    }

    $("channels").append(b);
  }
}

/// One line of a panel: a mark, a title, and the overview under it. Memory and
/// skills are listed the same way and marked differently, because a fact and a
/// procedure are read the same way and must not be mistaken for each other.
function entryEl(into: string, mark: string, title: string, overview: string | null, extra = "") {
  const el = document.createElement("div");
  el.className = `entry ${extra}`;
  el.innerHTML = `<div class="t"><span class="mark">${mark}</span></div><div class="o"></div>`;
  el.querySelector(".t")!.append(title);
  el.querySelector<HTMLElement>(".o")!.textContent = overview ?? "";
  $(into).append(el);
}

/// What the folder a channel works in is, asked once per folder per window.
/// The answer — a repository's mainline, whether merging ships something —
/// changes rarely and never mid-turn, so every consumer (the turn's boundary,
/// the memory panel, a permission ask) reads the same promise rather than
/// each shelling out for itself (#205).
const repoInfoCache = new Map<string, Promise<RepoInfo | null>>();

function repoInfoFor(folder: string): Promise<RepoInfo | null> {
  let pending = repoInfoCache.get(folder);
  if (!pending) {
    pending = invoke<RepoInfo>("agent_repo_info", { path: folder }).catch(() => null);
    repoInfoCache.set(folder, pending);
  }
  return pending;
}

/// The open channel's repository, when its folder is one. A bound folder is
/// asked directly; an unbound one is the derived path — asked for, not
/// created, because looking is not provisioning (#204). A folder that is no
/// repository answers both questions with null, which reads as: nothing
/// standing here to say.
async function channelRepo(slug: string): Promise<RepoInfo | null> {
  const folder = boundFolder(slug, bindings)
    ?? await invoke<string>("agent_derived_path",
      { workspace: rooms.current!, channel: slug }).catch(() => null);
  if (!folder) return null;
  const info = await repoInfoFor(folder);
  return info?.default_branch ? info : null;
}

/// The standing rules every session in a repository works under, drawn with
/// what the room has learned but never written into it — they are this
/// client's prompt to the agent, not the room's memory (#205). First in the
/// list, because they are always true while every learned entry ages; the
/// AUTO mark is what keeps a rule nobody learned from reading as a fact
/// somebody taught.
function renderGitBoundary(info: RepoInfo) {
  const el = document.createElement("div");
  el.className = "entry auto";
  el.innerHTML = `<div class="t"><span class="auto-badge">AUTO</span></div><div class="o"></div>`;
  el.querySelector(".t")!.append("Repository session boundary");
  el.querySelector<HTMLElement>(".o")!.textContent =
    `Sessions here work on agent/<topic> branches and never commit or push to ` +
    `${info.default_branch}. Commits carry a Co-Authored-By trailer.`;
  $("memory-list").prepend(el);
}

async function renderMemory() {
  if (!current) return;
  const [ entries, repo ] = await Promise.all([
    api.memory(current.slug),
    channelRepo(current.slug),
  ]);
  $("memory-uri").textContent = current.memory_uri;
  $("memory-list").innerHTML = "";
  if (repo) renderGitBoundary(repo);
  for (const e of entries) {
    entryEl("memory-list", e.trust === "human" ? "●" : "○", e.title, e.overview ?? null, e.trust);
  }
}

/// Who is in the room, so a name in the timeline is a colleague rather than a
/// stranger.
async function renderMembers() {
  if (!current) return;
  const members = await api.members(current.slug);
  const box = $("members");
  box.innerHTML = "";
  for (const m of members) {
    const id = identity({ kind: "user", name: m.name });
    const el = document.createElement("div");
    el.className = "member";
    el.innerHTML = `<span class="avatar" style="--hue:${id.hue}">${escape(id.initials)}</span>`;
    el.append(m.name + (m.role === "owner" ? " · owner" : ""));
    box.append(el);
  }
}

/// Procedures, alongside what the room knows but never mixed into it. A fact
/// goes stale and a procedure does not, and a reader has to be able to tell.
async function renderSkills() {
  if (!current) return;
  const skills = await api.skills(current.slug);
  $("skill-list").innerHTML = "";
  for (const s of skills) {
    entryEl("skill-list", "▸", s.title, s.overview ?? null, "skill");
  }
}

// ---------- channel ----------

/// A colleague at work must be distinguishable from a colleague who is absent —
/// otherwise `private` turns translucent into invisible.
type Presence = RunSignal & { context_used?: number; context_size?: number };

const occupancyByRun = new Map<number, string>();
const working = new WorkingSignal();

function showPresence(run: Presence) {
  if (run.status === "running") {
    working.observed({ runId: run.id, channel: current?.slug ?? "", who: run.user, at: Date.now() });
  } else {
    working.ended(run.id);
  }
  // Occupancy is why somebody starts a fresh session; it belongs beside the
  // line that says work is happening.
  if (run.context_used != null && run.context_size != null) {
    const label = occupancyLabel(run.context_used, run.context_size);
    if (label) occupancyByRun.set(run.id, label);
    else occupancyByRun.delete(run.id);
  }

  // The rail sits in the composer dock and does not move the timeline: an
  // agent starting work must not shift what somebody is reading.
  const rail = $("activity");
  const label = current ? working.label(current.slug) : null;
  const occupancy = [ ...occupancyByRun.values() ][0];
  rail.textContent = label ? `${label}…${occupancy ? `  (${occupancy})` : ""}` : "";
  rail.classList.toggle("on", Boolean(label));
  renderChannels();
}

async function open(slug: string) {
  // Fetched beside the channel, not after it — and a listing that fails must
  // not keep the room shut: the artifacts are the record's, the room is not
  // theirs (#160).
  const [ full, artifacts ] = await Promise.all([
    api.channel(slug),
    api.artifacts(slug).catch(() => []),
  ]);
  current = full;
  renderChannels();
  $("channel-name").textContent = `# ${full.slug}`;
  $("channel-purpose").textContent = full.purpose ?? "";
  renderBinding();
  // Before the timeline draws, not after: what it draws counts itself as seen
  // through `onShown`, and setting the count afterwards would throw that away.
  seenCount.set(slug, full.messages.length);
  timeline.open(full, artifacts);

  // After the room is drawn, and never in its way: provisioning is this
  // machine making the channel's folder ready, not something the room waits
  // on (#204).
  provision.consider(full);
  // Opening a room is one of the moments the person's unreviewed work is
  // most likely to be sitting in its folder (#207).
  humanGate.check(full);

  renderChannels();
  if (!$("memory").hidden) { renderMemory(); renderSkills(); renderMembers(); }
  panel.renderOptions();

  socket?.close();
  socket = api.live(slug, (e) => {
    if (e.type === "message") timeline.add(e.message);
    if (e.type === "step") timeline.addStep(e.step.run_id, e.step.label ?? e.step.kind, e.step.id);
    if (e.type === "run") showPresence(e.run);
    if (e.type === "plan") timeline.showPlan(e.plan.run_id, e.plan.entries);
    if (e.type === "artifact") timeline.addArtifact(e.artifact);
    if (e.type === "elsewhere" && e.channel !== current?.slug) {
      const c = channels.find((x) => x.slug === e.channel);
      if (c) { c.message_count = (c.message_count ?? 0) + 1; renderChannels(); }
    }
    if (e.type === "channel" && e.channel?.slug === current?.slug) {
      // The room's setting changed — saved here through the dialog, or on
      // another machine. Either way what is on screen follows the room (#203).
      current = { ...current!, ...e.channel };
      channelSettings.refresh(e.channel);
      renderBinding();
    }
  }, () => catchUp(slug));
}

/// The cable replays nothing, so a socket that was away came back to a room that
/// moved without it (#180). What it missed is `api.caughtUp`'s to work out; all
/// this adds is that the answer is only for the room still on screen — the room
/// can be left while the request is in flight, and pouring another channel's
/// messages into this one is worse than staying behind.
///
/// The rejection is deliberately not swallowed here: a server that has only just
/// come back can refuse this request, and `live()` reads the rejection as a room
/// still behind and asks again. Returning the promise is what makes that work.
async function catchUp(slug: string) {
  if (current?.slug !== slug) return;
  const missed = await api.caughtUp(slug, timeline.held());
  if (current?.slug !== slug) return;
  missed.forEach(timeline.add);
}

// ---------- the turn ----------

async function send(text: string) {
  if (!current) return;

  // Default is the room. An agent joins only when its owner calls it, and
  // `@agent` calls whichever one is default.
  const { addressed, agent: named, body } = parseAddress(text, agents.definitions());
  const posted = await api.post(current.slug, body);
  if (!addressed) return;

  const name = named ?? defaultAgent(agents.definitions());
  if (!name) return;
  if (!agents.isRunning(name)) {
    alert(`${name} is not running. Press Start agent first.`);
    return;
  }

  // What the room knows, plus what was just said in it — both belong to the
  // channel, so a colleague's message is context even though only the owner
  // may give the instruction.
  // The boundary is stated even when the room has learned nothing — `context`
  // is null there, and a new channel is where an agent has least to go on and
  // most room to wander (#114).
  const { context, boundary, store } = await api.context(current.slug);
  const history = timeline.recentHistory();
  const workspace = boundFolder(current.slug, bindings)
    ?? await agents.workspace(rooms.current!, current.slug);
  const sessionId = await agents.sessionFor(name, current.slug, workspace,
                                            api.rail(current.slug), store);
  const run = await api.startRun(current.slug, posted.id, name, sessionId,
                                 agents.modelFor(name, current.slug));
  activeRuns += 1;
  panel.renderOptions();

  // A workspace that is a repository has standing rules of its own (#205),
  // appended to the room's boundary for exactly the turns that run in it.
  // Asked once per folder, not per message — git does not change its mind
  // between two turns.
  const repo = await repoInfoFor(workspace);
  const guard = repo?.default_branch ? gitBoundary(repo.default_branch) : null;

  let reply = "";
  const stopAsking = await agents.onAsk(sessionId, (asked) => {
    // What the ask means, when the ask is git. The command the agent typed if
    // it said one, its title otherwise — shell asks often carry it there.
    const note = gitAskNote(asked.command ?? asked.title,
                            repo?.default_branch ?? null, repo?.deploys_on_push ?? false);
    timeline.askPermission(name, asked, note);
  });
  const stop = await agents.onUpdate(sessionId, (u: Update) => {
    if (u.kind === "text") reply += u.text;
    // Process: recorded against the run, never pushed at the room.
    else if (u.kind === "thought") api.step(run.id, "thought", u.text.slice(0, 200)).catch(() => {});
    else if (u.kind === "plan") api.plan(run.id, u.entries).catch(() => {});
    else if (u.kind === "usage") api.reportUsage(run.id, u.used, u.size, u.cost).catch(() => {});
    else if (u.kind === "config") { agents.rememberConfig(name, current!.slug, u.options); panel.renderOptions(); }
    else api.step(run.id, "tool_use", u.label).catch(() => {});
  });

  // A turn somebody can stop. Without it the only way out is quitting the app,
  // and the only stop that existed killed the process — taking the session, the
  // context window and every other channel's turn on that agent with it (#92).
  const stopTurn = say(`${name} is working in #${current.slug}.`, "Stop", async () => {
    await agents.cancel(name, sessionId);
  });

  try {
    // The offer at the end of this turn is measured from here: what was
    // already dirty stays the person's, only the delta is the run's (#202).
    await agents.turnStart(workspace).catch(() => {});
    await agents.prompt(name, sessionId, withClosing(body),
                        [ boundary, guard, context ].filter(Boolean).join("\n\n") || null, history);
    if (reply.trim()) await api.agentSay(run.id, reply.trim());
    await api.finishRun(run.id, "succeeded");
    timeline.offerTranscript(run.id, name, sessionId);
    await timeline.offerProduced(run.id, workspace).catch(() => {});
  } catch (err) {
    await api.agentSay(run.id, `Agent error: ${String(err)}`).catch(() => {});
    await api.finishRun(run.id, "failed").catch(() => {});
  } finally {
    activeRuns -= 1;
    stopTurn();
    stop();
    stopAsking();
    // The turn's end is the third moment: whatever the person wrote while it
    // ran is now visible to the gate (#207).
    if (current) humanGate.check(current);
  }
}

// ---------- wiring ----------

function refreshDestination() {
  const input = $<HTMLInputElement>("input");
  const { addressed, agent: named } = parseAddress(input.value, agents.definitions());
  $("destination").textContent = addressed ? `→ ${named ?? "your agent"}` : "→ the room";
  $("destination").className = addressed ? "to-agent" : "muted";
}

$("input").addEventListener("input", refreshDestination);

$("summon").addEventListener("click", () => {
  const input = $<HTMLInputElement>("input");
  if (!parseAddress(input.value, agents.definitions()).addressed) {
    input.value = `@${panel.chosen() ?? "agent"} ${input.value}`;
  }
  input.focus();
  refreshDestination();
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("input");
  const text = input.value.trim();
  if (!text) return;
  // A run is work on the folder, and unreviewed work there pauses it (#207).
  // Refused does not mean discarded: the message stays typed, the reason is
  // said, and a plain message to the room was never the gate's concern.
  if (humanGate.refuse(parseAddress(text, agents.definitions()).addressed)) return;
  input.value = "";
  $("gate-refused").textContent = "";
  refreshDestination();
  await send(text).catch((err) => alert(String(err)));
  offerToAdd(text).catch(() => {});
});

/// The first run, and any run asked for again from the agents panel. All the
/// actions are the panel's own — setup is another door into the same room,
/// not a room of its own.
function openOnboarding() {
  showOnboarding({
    cards: () => panel.cards(),
    agentCard: panel.agentCard,
    onFinish: (chosen) => {
      if (chosen) panel.pick(chosen);
      settings.markOnboarded();
      panel.render();
      panel.renderOptions();
    },
    initialPicked: panel.picked(),
  });
}

$("agents-open").addEventListener("click", () => {
  panel.render();
  $<HTMLDialogElement>("agents-dialog").showModal();
});

$("agents-setup").addEventListener("click", () => {
  $<HTMLDialogElement>("agents-dialog").close();
  openOnboarding();
});

$("show-steps").addEventListener("change", (e) => {
  timeline.revealSteps((e.target as HTMLInputElement).checked);
});

$("memory-toggle").addEventListener("click", () => {
  const memory = $("memory");
  memory.hidden = !memory.hidden;
  if (!memory.hidden) { renderMemory(); renderSkills(); renderMembers(); }
});

// Coming back to the window is the other moment: the person has been
// working somewhere, and that somewhere may be this folder (#207).
window.addEventListener("focus", () => {
  if (current) humanGate.check(current);
});


/// Ask for a name and an address. One dialog, because making a room and making
/// a channel ask the same two questions.
function askForOne(
  title: string, note: string, templates: RoomTemplate[] = [],
): Promise<{ slug: string; name: string; template?: string } | null> {
  const dialog = $<HTMLDialogElement>("make");
  $("make-title").textContent = title;
  $("make-note").textContent = note;
  const name = $<HTMLInputElement>("make-name");
  const slug = $<HTMLInputElement>("make-slug");
  name.value = "";
  slug.value = "";

  // The address is derived while it is untouched, and left alone once it is
  // not — somebody who typed one meant it.
  let typed = false;
  slug.oninput = () => { typed = true; };
  name.oninput = () => {
    if (!typed) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  };

  const chosen = renderTemplates(templates, name, slug);

  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "go") return resolve(null);
      if (chosen.key) return resolve({ slug: chosen.key, name: name.value, template: chosen.key });
      resolve(slug.value ? { slug: slug.value, name: name.value } : null);
    }, { once: true });
  });
}

/// The offer, drawn. Picking fills the two fields with what the server would
/// name the room and puts them beyond editing: they are a preview of somebody
/// else's answer, and a name typed over one that is never sent would be a lie
/// the dialog told. Picking again takes it back.
function renderTemplates(
  templates: RoomTemplate[], name: HTMLInputElement, slug: HTMLInputElement,
): { key: string | null } {
  const block = $("make-templates");
  const list = $("make-template-list");
  const state: { key: string | null } = { key: null };

  list.innerHTML = "";
  block.hidden = templates.length === 0;
  // Before the early return: the dialog is shared with New workspace, which
  // offers no shapes, and fields left disabled by a previous pick would open it
  // with nothing that can be typed into.
  name.disabled = slug.disabled = false;
  if (!templates.length) return state;

  const buttons = templates.map((t) => {
    const b = document.createElement("button");
    b.type = "button";                      // never submits the dialog
    b.className = "template";
    b.disabled = !pickable(t);
    b.append(Object.assign(document.createElement("strong"), { textContent: t.name }));
    b.append(Object.assign(document.createElement("span"),
                           { className: "muted", textContent: templateNote(t) }));
    b.onclick = () => {
      state.key = state.key === t.key ? null : t.key;
      for (const [ other, el ] of buttons) el.classList.toggle("chosen", other.key === state.key);
      // Disabled fields sit out constraint validation, so `required` does not
      // block the one submit that does not need them.
      name.disabled = slug.disabled = state.key !== null;
      name.value = state.key ? t.name : "";
      slug.value = state.key ? t.key : "";
    };
    list.append(b);
    return [ t, b ] as const;
  });

  return state;
}

/// Every channel of the room this token names, and the first one opened. Called
/// at boot and again whenever the room changes, because everything on screen
/// belongs to one of them.
async function loadChannels() {
  channels = await api.channels();
  renderChannels();
  if (channels.length) await open(channels[0].slug);
}

function renderWorkspaces() {
  const slugs = reachableRooms(rooms);
  // The rail appears when there is a choice to make; one room is no choice.
  $("rail").hidden = slugs.length < 2;
  const box = $("rail-workspaces");
  box.innerHTML = "";
  for (const slug of slugs) {
    const b = document.createElement("button");
    b.className = `rail-workspace${slug === rooms.current ? " active" : ""}`;
    b.textContent = (slug[0] ?? "?").toUpperCase();
    b.title = slug;
    b.onclick = () => enterWorkspace(slug);
    box.append(b);
  }
}

/// Everything on screen belongs to one room, so changing rooms reloads it all.
async function enterWorkspace(slug: string) {
  const token = tokenForRoom(rooms, slug);
  if (!token) {
    say(`This client has no way into ${slug}. Sign in again to reach it.`);
    return;
  }
  rooms = settings.saveWorkspaces(enterRoom(rooms, slug));
  api.useToken(token);
  // Sessions belong to the agent and the channel of the room that opened them.
  await agents.stop().catch(() => {});
  current = null;
  renderWorkspaces();
  await loadChannels();
}

async function renderInvitations() {
  const open = await api.invitations().catch(() => []);
  const box = $("invite-open");
  box.textContent = open.length ? "" : "None.";
  for (const one of open) {
    const row = document.createElement("div");
    row.textContent = `${one.email ?? "anybody"} · ${one.role} · ${one.code}`;
    box.append(row);
  }
}

$("workspace-join").addEventListener("click", async () => {
  const dialog = $<HTMLDialogElement>("join");
  const field = $<HTMLInputElement>("join-code");
  field.value = "";
  dialog.showModal();
  await new Promise<void>((r) => dialog.addEventListener("close", () => r(), { once: true }));
  if (dialog.returnValue !== "go" || !field.value.trim()) return;

  try {
    const joined = await api.acceptInvitation(field.value.trim());
    // Redeeming is the third and last place a token for another room arrives.
    rooms = settings.saveWorkspaces(enterRoom(rooms, joined.workspace.slug, joined.token));
    await enterWorkspace(joined.workspace.slug);
    say(`You are in ${joined.workspace.name}.`);
  } catch (err) {
    alert(String(err));
  }
});

$("workspace-invite").addEventListener("click", async () => {
  const dialog = $<HTMLDialogElement>("invite");
  $("invite-result").textContent = "";
  await renderInvitations();
  dialog.showModal();
});

$("invite-go").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("invite-email").value.trim();
  const role = $<HTMLSelectElement>("invite-role").value;
  try {
    const made = await api.invite(email || undefined, role);
    // The code is the invitation. Shown rather than sent: this client has no
    // way to send mail, and pretending otherwise would lose somebody's invite.
    $("invite-result").textContent = `Send them this code: ${made.code}`;
    await renderInvitations();
  } catch (err) {
    $("invite-result").textContent = String(err);
  }
});

$("workspace-new").addEventListener("click", async () => {
  const asked = await askForOne("New workspace",
    "A room of its own: its own channels, its own memory, and nothing of this one's.");
  if (!asked) return;

  try {
    const made = await api.createWorkspace(asked.slug, asked.name);
    // The only place a token for another room legitimately arrives.
    rooms = settings.saveWorkspaces(enterRoom(rooms, made.slug, made.token));
    await enterWorkspace(made.slug);
    say(`${made.name} is yours. It opened with general, random and meetings.`);
  } catch (err) {
    alert(String(err));
  }
});

$("channel-new").addEventListener("click", async () => {
  // A server too old to offer shapes, or one that cannot be reached for them,
  // still opens the dialog. The templates are the offer, not the feature.
  const templates = await api.channelTemplates().catch(() => []);
  const asked = await askForOne("New channel", "Everybody in this workspace can find it.", templates);
  const body = channelToCreate(asked);
  if (!body) return;

  try {
    const made = await api.createChannel(body);
    await loadChannels();
    await open(made.slug);
  } catch (err) {
    alert(String(err));
  }
});

/// Somebody was named who is not in this room. Offered, never done: adding a
/// colleague to a channel is a thing a person decides, and this is the one
/// moment they are thinking about it.
async function offerToAdd(text: string) {
  if (!current) return;

  const [ present, workspace ] = await Promise.all([
    api.members(current.slug).catch(() => []),
    api.workspaceMembers().catch(() => []),
  ]);

  for (const person of missingFrom(text, present, workspace, agents.definitions())) {
    const slug = current.slug;
    const dismiss = say(`${person.name} is not in #${slug}.`, `Add @${person.handle}`, async () => {
      await api.addMember(slug, person.handle);
      dismiss();
      say(`${person.name} is in #${slug}.`);
    });
  }
}

function renderBinding() {
  const folder = current ? boundFolder(current.slug, bindings) : null;
  const el = $("folder");
  el.textContent = folder ? folder.replace(/^.*\/(?=[^/]+\/?[^/]*$)/, "…/") : "Use a folder…";
  // The gate's count rides the folder button: unreviewed work is about this
  // folder, so that is where the number belongs (#207).
  const pending = humanGate.pending();
  if (pending) el.textContent += ` · ${pending}`;
  el.title = folder
    ? `${folder} — this channel's agent works here. Click to change, shift-click to unbind.`
    : "Bind this channel to a folder you already have";
  el.classList.toggle("bound", Boolean(folder));
}

/// Binding is deliberate. An agent in somebody's real repository can change
/// anything in it — which is normal for a coding agent, and normal precisely
/// because the person opened it there.
///
/// The picker itself moved into the channel settings dialog (#203), where the
/// choice sits beside the repository it refers to; the shift-click unbind
/// stayed, because taking a binding back is one gesture, not a dialog.
$("folder").addEventListener("click", async (e) => {
  if (!current) return;
  const slug = current.slug;

  if ((e as MouseEvent).shiftKey) {
    const before = boundFolder(slug, bindings);
    bindings = settings.bind(slug, null);
    renderBinding();
    // The session was opened against the old directory and cannot follow it.
    if (before) await agents.releaseChannel(slug);
    return;
  }

  channelSettings.open();
});

/// The room's name is the other door into the same settings.
$("channel-name").addEventListener("click", () => channelSettings.open());

$("thread-close").addEventListener("click", () => timeline.closeThread());

$("thread-composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("thread-input");
  const text = input.value.trim();
  const root = timeline.openThread();
  if (!current || !text || root === null) return;
  input.value = "";
  try {
    await api.post(current.slug, text, root);
  } catch (err) { alert(String(err)); }
});

let signedInThroughBrowser = false;

/// The browser round trip. The client holds the same bearer token either way —
/// only how a person comes to hold one changes.
$("signin-provider").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("signin-provider");
  button.disabled = true;
  button.textContent = "Waiting for your browser…";
  try {
    const token = await invoke<string>("sign_in_with_provider",
      { server: import.meta.env.VITE_WORKROOM_SERVER ?? "http://127.0.0.1:3000" });
    api.useToken(token);
    signedInThroughBrowser = true;
    $<HTMLDialogElement>("signin").close();
  } catch (err) {
    alert(String(err));
  } finally {
    button.disabled = false;
    button.textContent = "Sign in with your organisation";
  }
});

$("memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $<HTMLInputElement>("memory-title").value.trim();
  const detail = $<HTMLTextAreaElement>("memory-detail").value.trim();
  if (!current || !title || !detail) return;
  try {
    await api.remember(current.slug, title, detail);
    $<HTMLInputElement>("memory-title").value = "";
    $<HTMLTextAreaElement>("memory-detail").value = "";
    renderMemory();
  } catch (err) { alert(String(err)); }
});

$("skill-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $<HTMLInputElement>("skill-title").value.trim();
  const body = $<HTMLTextAreaElement>("skill-body").value.trim();
  if (!current || !title || !body) return;
  try {
    await api.writeSkill(current.slug, title, body);
    $<HTMLInputElement>("skill-title").value = "";
    $<HTMLTextAreaElement>("skill-body").value = "";
    renderSkills();
  } catch (err) { alert(String(err)); }
});

/// Told, never done for them. An agent workspace that replaces its own binary
/// without being asked is a thing people are right to distrust — so it checks,
/// it says, and the person decides.
async function offerUpdate() {
  const update = await orAfter(check().catch(() => null), 8000, null);
  if (!update?.available) return;

  const current = await getVersion().catch(() => "");
  const notice = updateNotice({ current, available: update.version });
  if (!notice) return;

  say(notice, "Install and restart", async () => {
    await update.downloadAndInstall();
    await relaunch();
  });
}

/// A client and a workspace that have drifted apart do not fail loudly. They
/// fail by quietly doing nothing, so this is said out loud.
function noticeDrift(client: string, server?: string) {
  const notice = driftNotice(client, server);
  if (notice) say(notice);
}

/// A line at the top of the room, and a way to act on it if there is one.
/// Returns a way to take it back down — most notices stay until the window is
/// gone, and one that offers to stop a turn has to leave when the turn does.
function say(text: string, action?: string, run?: () => Promise<void>): () => void {
  const el = document.createElement("div");
  el.className = "notice";
  el.append(document.createTextNode(`${text} `));
  if (action && run) el.append(ghostButton(action, action, run));
  $("notices").append(el);
  return () => el.remove();
}

async function boot() {
  const dialog = $<HTMLDialogElement>("signin");
  const how = await api.methods().catch(() => ({ development: true, provider: false, version: undefined }));
  $("signin-provider-block").hidden = !how.provider;
  $("signin-dev").hidden = !how.development;
  $("signin-none").hidden = how.provider || how.development;

  dialog.showModal();
  await new Promise<void>((r) => dialog.addEventListener("close", () => r(), { once: true }));

  const { user } = signedInThroughBrowser
    ? await api.whoAmI()
    : await api.signIn($<HTMLInputElement>("email").value.trim());
  const myName = user.name;
  $("who").textContent = myName;

  // Signing in is where a token for a room arrives. The other place is making
  // one; there is deliberately no third, because a token fetched for another
  // room would be fetchable by an agent holding this one.
  const [ mine ] = await api.workspaces().catch(() => []);
  if (mine) rooms = settings.saveWorkspaces(enterRoom(rooms, mine.slug, api.token));
  renderWorkspaces();

  // The room first. It is the product, and everything below is a detail of the
  // toolbar that can arrive late without anybody minding.
  await loadChannels();

  // Agents already running from an earlier window of this session stay
  // addressable — the registry is the process's, not this view's. If the bridge
  // does not answer, the panel is briefly wrong, which is better than a room
  // that never appeared.
  agents.use(settings.load());
  for (const name of await orAfter(agents.listRunning(), 2000, [])) agents.markRunning(name);
  prefix = await orAfter(join(await appDataDir(), "npm"), 2000, "");
  panel.render();
  // What each of them is on this machine, said once the room is up. Until it
  // answers a row reads as missing, which is what it was before this existed.
  // The first run asks which agent this person has — after the probe answers,
  // so the cards open with what the machine actually said, and only once;
  // after that the panel carries it and setup is re-opened from there.
  panel.refresh().catch(() => {}).then(() => {
    if (!settings.isOnboarded()) openOnboarding();
  });

  // An agent that stopped says so once, with whatever it said on the way down.
  // Restarting is offered, never done: the process runs under this person's own
  // credentials and respawning it unasked is not ours to decide.
  await agents.onClosed(({ name, diagnostics }) => {
    panel.render();
    const who = name ?? "The agent";
    const why = diagnostics.length ? ` It said: ${diagnostics.slice(-3).join(" ")}` : "";
    if (name) say(`${who} stopped.${why}`, "Start agent", () => panel.start(name));
    else say(`${who} stopped.${why}`);
  });

  const version = await getVersion().catch(() => "");
  noticeDrift(version, how.version);
  offerUpdate().catch(() => {});
}

boot().catch((e) => alert(`Cannot reach the server.\n\n${String(e)}`));
