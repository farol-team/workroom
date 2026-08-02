import { Api, type Channel, type Live, type Message } from "./api";
import { StepLedger, WorkingSignal, activeAgent, missingFrom, channelToCreate, enterRoom, reachableRooms, tokenForRoom, boundFolder, contentTypeFor, driftNotice, updateNotice, onboardingCards, orAfter, dayLabel, identity, inTimeline, offerable, onScreen, pickable, templateNote, threadOf, threadSummary, timeLabel, defaultAgent, formatHistory, occupancyLabel, parseAddress, selectable, transcriptName, unreadCount, withClosing, worthOffering, type PlanEntry, type RoomTemplate, type RunSignal } from "./rules";
import { Agents, type Update } from "./agent";
import { installCommand, profileFor } from "./agents/catalog";
import { showOnboarding } from "./onboarding";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import * as settings from "./settings";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

const api = new Api(import.meta.env.VITE_WORKROOM_SERVER ?? "http://127.0.0.1:3000");
const agents = new Agents(settings.load());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let channels: Channel[] = [];
let current: Channel | null = null;
let socket: Live | null = null;
let runSteps = new Map<number, string[]>();
let me = "";   // who is signed in, so a workspace belongs to a person

// ---------- rendering ----------

/// What each channel has that you have not seen, and whether anyone's agent is
/// at work in it. Both read from state, never recomputed per surface.
const seenCount = new Map<string, number>();
let held: Message[] = [];      // every message of the open channel
let openThread: number | null = null;
const ON_SCREEN = 200;
const AT_MOST_OFFERED = 12;   // an offer nobody can read is worse than no offer
let bindings = settings.loadBindings();
/// Where this person is, and what reaches the rooms they have a way into.
let rooms = settings.loadWorkspaces();   // a room with ten thousand messages is not ten thousand elements

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

function messageEl(m: Message) {
  const el = document.createElement("div");
  el.className = `msg ${m.author.kind}`;
  el.dataset.id = String(m.id);
  const who = m.author.kind === "agent" ? `${m.author.name}'s agent` : m.author.name;
  const id = identity(m.author);
  // A face, then a head line (name, mark, time), then what was said. The name
  // keeps the `.from` class because `recentHistory` reads the room from the
  // DOM, and what it reads must stay the name.
  el.innerHTML =
    `<span class="avatar${id.isAgent ? " is-agent" : ""}" style="--hue:${id.hue}">` +
    `${escape(id.initials)}</span><div class="msg-main"><div class="msg-head">` +
    `<span class="from">${escape(who)}</span>` +
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

function addMessage(m: Message) {
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

  if (current) seenCount.set(current.slug, (seenCount.get(current.slug) ?? 0) + 1);
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

const stepLedger = new StepLedger();

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
    holder.hidden = !showSteps;
    box.append(holder);
  }
  const line = document.createElement("div");
  line.textContent = `· ${label}`;
  holder.append(line);
  box.scrollTop = box.scrollHeight;
  runSteps.set(runId, [...(runSteps.get(runId) ?? []), label]);
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

async function renderMemory() {
  if (!current) return;
  const entries = await api.memory(current.slug);
  $("memory-uri").textContent = current.memory_uri;
  $("memory-list").innerHTML = "";
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

/// The agent is waiting on a person, so this goes where that person is looking.
/// It is process rather than outcome, so it is theirs alone (Article S2).
function askPermission(name: string, asked: import("./rules").Asked) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "offer ask";
  el.append(document.createTextNode(`${asked.title} `));

  const answer = async (optionId: string | null) => {
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await agents.permit(name, asked.id, optionId);
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

/// The latest revision replaces the one on screen; the record keeps them all.
const PLAN_MARK: Record<string, string> = {
  completed: "\u2713", in_progress: "\u2192", pending: "\u00b7",
};

function addArtifact(a: { id: number; name: string; kind: string | null }) {
  const el = document.createElement("div");
  el.className = "artifact";
  el.textContent = `\u{1F4CE} ${a.name}`;
  $("messages").append(el);
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
    line.textContent = `${PLAN_MARK[e.status ?? "pending"] ?? "\u00b7"} ${e.content}`;
    el.append(line);
  }
  if (!el.isConnected) box.append(el);
  box.scrollTop = box.scrollHeight;
}

/// What the run wrote in its working directory, offered one file at a time.
/// Offered, not uploaded: work product belongs to the channel (Article D3), but
/// what leaves this machine stays the person's decision.
async function offerProduced(runId: number, workspace: string) {
  const produced = await agents.produced(workspace);
  if (!worthOffering(produced)) return;
  const { files, omitted } = offerable(produced, AT_MOST_OFFERED);

  const box = $("messages");
  for (const file of files) {
    const el = document.createElement("div");
    el.className = "offer";
    el.append(document.createTextNode(`${file.path} · ${Math.ceil(file.bytes / 1024)} kB `));

    el.append(ghostButton("Share with the channel", "Sharing…", async () => {
      const body = await agents.read(workspace, file.path);
      await api.attachBytes(runId, file.path, body, contentTypeFor(file.path));
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
    const body = await agents.exportSession(name, sessionId);
    if (!body) { el.textContent = "This agent keeps no transcript."; return; }
    await api.attachArtifact(runId, transcriptName(runId, new Date()), body);
    el.remove();
  }));
  box.append(el);
  box.scrollTop = box.scrollHeight;
}

/// Whatever the agent offers, rendered as it comes. Per channel, because the
/// session is per channel — a cheap model here and an expensive one there.
function renderOptions() {
  const box = $("session-options");
  box.innerHTML = "";
  const name = chosenAgent();
  if (!current || !name || !agents.isRunning(name)) return;

  for (const option of selectable(agents.configFor(name, current.slug))) {
    const label = document.createElement("label");
    label.className = "session-option";
    label.title = option.name;

    const select = document.createElement("select");
    for (const choice of option.options ?? []) {
      const el = document.createElement("option");
      el.value = choice.value;
      el.textContent = choice.name;
      el.selected = choice.value === option.currentValue;
      select.append(el);
    }
    select.onchange = async () => {
      select.disabled = true;
      try {
        agents.rememberConfig(name, current!.slug,
          await agents.setConfig(name, current!.slug, option.id, select.value));
      } catch (err) { alert(String(err)); }
      select.disabled = false;
      renderOptions();
    };

    label.append(select);
    box.append(label);
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

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
  const full = await api.channel(slug);
  current = full;
  renderChannels();
  $("channel-name").textContent = `# ${full.slug}`;
  $("channel-purpose").textContent = full.purpose ?? "";
  renderBinding();
  $("messages").innerHTML = "";
  held = [ ...full.messages ];
  closeThread();
  seenCount.set(slug, full.messages.length);

  const shown = onScreen(full.messages.filter(inTimeline), ON_SCREEN);
  if (shown.hidden) {
    const earlier = document.createElement("div");
    earlier.className = "earlier";
    earlier.textContent = `${shown.hidden} earlier messages are not shown`;
    $("messages").append(earlier);
  }
  if (full.messages.length) shown.messages.forEach(addMessage);
  else showIntro(full);
  renderChannels();
  if (!$("memory").hidden) { renderMemory(); renderSkills(); renderMembers(); }
  renderOptions();

  socket?.close();
  socket = api.live(slug, (e) => {
    if (e.type === "message") addMessage(e.message);
    if (e.type === "step") addStep(e.step.run_id, e.step.label ?? e.step.kind, e.step.id);
    if (e.type === "run") showPresence(e.run);
    if (e.type === "plan") showPlan(e.plan.run_id, e.plan.entries);
    if (e.type === "artifact") addArtifact(e.artifact);
    if (e.type === "elsewhere" && e.channel !== current?.slug) {
      const c = channels.find((x) => x.slug === e.channel);
      if (c) { c.message_count = (c.message_count ?? 0) + 1; renderChannels(); }
    }
  }, () => catchUp(slug));
}

/// The cable replays nothing, so a socket that was away came back to a room that
/// moved without it (#180). Asking the channel again is the whole of catching up:
/// what is already held is left alone, and only what is newer than the newest
/// message on hand is added — the same path a live message takes.
async function catchUp(slug: string) {
  if (current?.slug !== slug) return;
  const full = await api.channel(slug);
  const newest = held.reduce((max, m) => Math.max(max, m.id), 0);
  full.messages.filter((m) => m.id > newest).forEach(addMessage);
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
  const history = recentHistory();
  const workspace = boundFolder(current.slug, bindings)
    ?? await agents.workspace(me, name, current.slug);
  const sessionId = await agents.sessionFor(name, current.slug, workspace,
                                            api.rail(current.slug), store);
  const run = await api.startRun(current.slug, posted.id, name, sessionId,
                                 agents.modelFor(name, current.slug));
  renderOptions();

  let reply = "";
  const stopAsking = await agents.onAsk(sessionId, (asked) => askPermission(name, asked));
  const stop = await agents.onUpdate(sessionId, (u: Update) => {
    if (u.kind === "text") reply += u.text;
    // Process: recorded against the run, never pushed at the room.
    else if (u.kind === "thought") api.step(run.id, "thought", u.text.slice(0, 200)).catch(() => {});
    else if (u.kind === "plan") api.plan(run.id, u.entries).catch(() => {});
    else if (u.kind === "usage") api.reportUsage(run.id, u.used, u.size, u.cost).catch(() => {});
    else if (u.kind === "config") { agents.rememberConfig(name, current!.slug, u.options); renderOptions(); }
    else api.step(run.id, "tool_use", u.label).catch(() => {});
  });

  // A turn somebody can stop. Without it the only way out is quitting the app,
  // and the only stop that existed killed the process — taking the session, the
  // context window and every other channel's turn on that agent with it (#92).
  const stopTurn = say(`${name} is working in #${current.slug}.`, "Stop", async () => {
    await agents.cancel(name, sessionId);
  });

  try {
    await agents.prompt(name, sessionId, withClosing(body),
                        [ boundary, context ].filter(Boolean).join("\n\n") || null, history);
    if (reply.trim()) await api.agentSay(run.id, reply.trim());
    await api.finishRun(run.id, "succeeded");
    offerTranscript(run.id, name, sessionId);
    await offerProduced(run.id, workspace).catch(() => {});
  } catch (err) {
    await api.agentSay(run.id, `Agent error: ${String(err)}`).catch(() => {});
    await api.finishRun(run.id, "failed").catch(() => {});
  } finally {
    stopTurn();
    stop();
    stopAsking();
  }
}

/// The last few turns of the room, as the agent would read them.
function recentHistory(limit = 20): string | null {
  const rows = [...document.querySelectorAll<HTMLElement>("#messages .msg")].map((el) => ({
    who: el.querySelector(".from")?.textContent?.trim() ?? "?",
    what: el.querySelector(".body")?.textContent?.trim() ?? "",
  }));
  return formatHistory(rows, limit);
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
    input.value = `@${chosenAgent() ?? "agent"} ${input.value}`;
  }
  input.focus();
  refreshDestination();
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  refreshDestination();
  await send(text).catch((err) => alert(String(err)));
  offerToAdd(text).catch(() => {});
});

/// The one chosen, kept across windows — a choice that evaporates on restart
/// reads as never having been offered.
let picked: string | undefined = settings.loadPicked();
const chosenAgent = () => activeAgent(agents.definitions(), picked);

function pick(name: string) {
  picked = name;
  settings.savePicked(name);
}

/// What a row is doing right now, when it is doing something. Held here rather
/// than written into the row, because every render rebuilds it.
const busy = new Map<string, string>();

/// Where installs go: a directory this application owns, and the same one the
/// bridge looks in. An agent installed anywhere else would read as missing the
/// moment it finished installing.
let prefix = "";

/// One row per agent: what it is called, the state it is really in, and the
/// single thing to do about it. The state is the machine's answer — an agent
/// reported as ready that is not there is worse than no panel at all.
function renderAgents() {
  const box = $("agents");
  box.innerHTML = "";
  const chosen = chosenAgent();

  for (const def of agents.definitions()) {
    const profile = profileFor(def.name);
    const state = agents.stateOf(def.name);
    const running = agents.isRunning(def.name);
    const command = profile && prefix && state === "missing"
      ? installCommand(profile, prefix) : null;

    const row = document.createElement("div");
    row.className = "agent-row";

    // The name is how one of them is chosen — what the picker was for, and the
    // one thing the panel that replaced it did not carry over. Three agents are
    // listed for everybody now, so two running at once is ordinary, and the
    // second one's session options were reachable only by stopping the first.
    const name = document.createElement("button");
    name.className = "agent-name";
    name.style.cssText = "background: none; border: 0; padding: 0; font: inherit; cursor: pointer;"
      + `color: var(${def.name === chosen ? "--accent" : "--text"});`;
    name.textContent = profile?.label ?? def.name;
    name.title = `${[ def.command, ...def.args ].join(" ")} — press to address this one`;
    name.onclick = () => { pick(def.name); renderAgents(); renderOptions(); };

    const said = document.createElement("span");
    said.className = "muted";
    said.textContent = busy.get(def.name) ?? (running ? "running" : state);

    const action = document.createElement("button");
    action.className = "ghost";
    action.disabled = busy.has(def.name);
    if (command) {
      action.textContent = "Install";
      action.onclick = () => { installAgent(def.name).catch((err) => alert(String(err))); };
    } else {
      action.textContent = running ? "Stop" : "Start";
      action.onclick = () => { toggleAgent(def.name).catch((err) => alert(String(err))); };
    }

    row.append(name, said, action);
    box.append(row);

    // The exact command, before it runs. An application that installs something
    // without saying what it is about to run has asked for trust it has not
    // earned — and the answer to "what did that do to my machine" is on screen.
    if (command) {
      const shown = document.createElement("code");
      shown.className = "muted";
      shown.textContent = command;
      shown.title = command;
      box.append(shown);
    }
  }

  // The sidebar footer carries the same answer in one line, and is the way
  // into this panel. Nobody should have to open a dialog to learn whether
  // their agent is running.
  const chosenLabel = chosen ? (profileFor(chosen)?.label ?? chosen) : null;
  $("agents-open").textContent = chosenLabel
    ? `${chosenLabel} · ${agents.isRunning(chosen!) ? "running" : agents.stateOf(chosen!)}`
    : "Set up your agent";
}

/// Ask the machine which of these agents it actually has. Their state is what
/// the panel is for, and a guess would be worse than the silence it replaced.
async function refreshAgents() {
  await agents.probe(agents.definitions().map((d) => d.command));
  renderAgents();
}

/// Fetch one agent, on an explicit press. One npm command into a prefix this
/// application owns — nothing else on the machine is touched, and a failure
/// says what npm said rather than that something went wrong.
async function installAgent(name: string) {
  const profile = profileFor(name);
  const command = profile && prefix ? installCommand(profile, prefix) : null;
  if (!command) return;

  busy.set(name, "installing…");
  renderAgents();
  try {
    const out = await agents.install(command);
    if (!out.ok) {
      alert(`${profile!.label} was not installed.\n\n${command}\n\n`
        + `${out.stderrTail || out.stdoutTail || `npm exited ${out.code}`}`);
    }
  } finally {
    busy.delete(name);
    // Whether it worked is the machine's to say, not the exit code's.
    await refreshAgents();
  }
}

async function toggleAgent(name: string) {
  pick(name);
  if (agents.isRunning(name)) {
    await agents.stop(name);
    renderAgents();
    return;
  }
  try {
    await startAgent(name);
  } catch (err) {
    alert(`Could not start ${name}.\n\n${String(err)}`);
  }
}

/// Start one agent and open its session in the room that is on screen. Shared
/// with the notice an agent leaves when its process ends (#93) — the person
/// asks for the restart there, the same way they would here.
async function startAgent(name: string) {
  pick(name);
  busy.set(name, "starting…");
  renderAgents();
  try {
    await agents.start(name);
    busy.delete(name);
    renderAgents();
    if (current) {
      const dir = boundFolder(current.slug, bindings)
        ?? await agents.workspace(me, name, current.slug);
      await agents.sessionFor(name, current.slug, dir, api.rail(current.slug));
      renderOptions();
    }
  } catch (err) {
    busy.delete(name);
    renderAgents();
    throw err;
  }
}

// A local view preference, not a property of the session. The record is
// complete either way; this only decides how much of it is on screen.
let showSteps = true;

/// The first run, and any run asked for again from the agents panel. All the
/// actions are the panel's own — setup is another door into the same room,
/// not a room of its own.
function openOnboarding() {
  showOnboarding({
    cards: () => onboardingCards(agents.definitions().map((d) => ({
      name: d.name,
      label: profileFor(d.name)?.label ?? d.name,
      state: agents.stateOf(d.name),
      running: agents.isRunning(d.name),
    }))),
    installCommand: (name) => {
      const profile = profileFor(name);
      return profile && prefix ? installCommand(profile, prefix) : null;
    },
    onInstall: installAgent,
    onToggle: toggleAgent,
    onFinish: (chosen) => {
      if (chosen) pick(chosen);
      settings.markOnboarded();
      renderAgents();
      renderOptions();
    },
    initialPicked: picked,
  });
}

$("agents-open").addEventListener("click", () => {
  renderAgents();
  $<HTMLDialogElement>("agents-dialog").showModal();
});

$("agents-setup").addEventListener("click", () => {
  $<HTMLDialogElement>("agents-dialog").close();
  openOnboarding();
});

$("show-steps").addEventListener("change", (e) => {
  showSteps = (e.target as HTMLInputElement).checked;
  document.querySelectorAll<HTMLElement>(".steps").forEach((el) => {
    el.hidden = !showSteps;
  });
});

$("memory-toggle").addEventListener("click", () => {
  const panel = $("memory");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { renderMemory(); renderSkills(); renderMembers(); }
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
  el.title = folder
    ? `${folder} — this channel's agent works here. Click to change, shift-click to unbind.`
    : "Bind this channel to a folder you already have";
  el.classList.toggle("bound", Boolean(folder));
}

/// Binding is deliberate. An agent in somebody's real repository can change
/// anything in it — which is normal for a coding agent, and normal precisely
/// because the person opened it there.
$("folder").addEventListener("click", async (e) => {
  if (!current) return;
  const slug = current.slug;
  const before = boundFolder(slug, bindings);

  if ((e as MouseEvent).shiftKey) {
    bindings = settings.bind(slug, null);
    renderBinding();
    // The session was opened against the old directory and cannot follow it.
    if (before) await agents.releaseChannel(slug);
    return;
  }

  const chosen = await chooseFolder({ directory: true, title: `Where # ${slug} works` });
  if (typeof chosen === "string") {
    bindings = settings.bind(slug, chosen);
    if (chosen !== before) await agents.releaseChannel(slug);
  }
  renderBinding();
});

$("thread-close").addEventListener("click", closeThread);

$("thread-composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("thread-input");
  const text = input.value.trim();
  if (!current || !text || openThread === null) return;
  input.value = "";
  try {
    await api.post(current.slug, text, openThread);
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

/// A button for something that can fail. While it runs it says so and cannot be
/// pressed again; if it fails it says why and can be pressed again. Every offer
/// and every notice wanted the same six lines, and each wrote its own.
function ghostButton(label: string, busy: string, work: () => Promise<void>): HTMLButtonElement {
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
  me = user.email;
  $("who").textContent = user.name;

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
  renderAgents();
  // What each of them is on this machine, said once the room is up. Until it
  // answers a row reads as missing, which is what it was before this existed.
  // The first run asks which agent this person has — after the probe answers,
  // so the cards open with what the machine actually said, and only once;
  // after that the panel carries it and setup is re-opened from there.
  refreshAgents().catch(() => {}).then(() => {
    if (!settings.isOnboarded()) openOnboarding();
  });

  // An agent that stopped says so once, with whatever it said on the way down.
  // Restarting is offered, never done: the process runs under this person's own
  // credentials and respawning it unasked is not ours to decide.
  await agents.onClosed(({ name, diagnostics }) => {
    renderAgents();
    const who = name ?? "The agent";
    const why = diagnostics.length ? ` It said: ${diagnostics.slice(-3).join(" ")}` : "";
    if (name) say(`${who} stopped.${why}`, "Start agent", () => startAgent(name));
    else say(`${who} stopped.${why}`);
  });

  const version = await getVersion().catch(() => "");
  noticeDrift(version, how.version);
  offerUpdate().catch(() => {});
}

boot().catch((e) => alert(`Cannot reach the server.\n\n${String(e)}`));
