import { Api, type Channel, type Message } from "./api";
import { StepLedger, WorkingSignal, boundFolder, contentTypeFor, driftNotice, updateNotice, orAfter, dayLabel, identity, inTimeline, offerable, onScreen, threadOf, threadSummary, defaultAgent, formatHistory, occupancyLabel, parseAddress, selectable, transcriptName, unreadCount, withClosing, worthOffering, type PlanEntry, type RunSignal } from "./rules";
import { Agents, type Update } from "./agent";
import { invoke } from "@tauri-apps/api/core";
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
let socket: WebSocket | null = null;
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
let bindings = settings.loadBindings();   // a room with ten thousand messages is not ten thousand elements

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
  el.innerHTML = `<div class="from">` +
    `<span class="avatar${id.isAgent ? " is-agent" : ""}" style="--hue:${id.hue}">` +
    `${escape(id.initials)}</span>${escape(who)}</div><div class="body"></div>`;
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

async function renderMemory() {
  if (!current) return;
  const entries = await api.memory(current.slug);
  $("memory-uri").textContent = current.memory_uri;
  $("memory-list").innerHTML = "";
  for (const e of entries) {
    const el = document.createElement("div");
    el.className = `entry ${e.trust}`;
    el.innerHTML = `<div class="t"><span class="mark">${e.trust === "human" ? "●" : "○"}</span></div>
                    <div class="o"></div>`;
    el.querySelector(".t")!.append(e.title);
    el.querySelector<HTMLElement>(".o")!.textContent = e.overview ?? "";
    $("memory-list").append(el);
  }
}

/// Procedures, alongside what the room knows but never mixed into it. A fact
/// goes stale and a procedure does not, and a reader has to be able to tell.
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

async function renderSkills() {
  if (!current) return;
  const skills = await api.skills(current.slug);
  $("skill-list").innerHTML = "";
  for (const s of skills) {
    const el = document.createElement("div");
    el.className = "entry skill";
    el.innerHTML = `<div class="t"><span class="mark">▸</span></div><div class="o"></div>`;
    el.querySelector(".t")!.append(s.title);
    el.querySelector<HTMLElement>(".o")!.textContent = s.overview ?? "";
    $("skill-list").append(el);
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

/// Attaching is a decision made with the work in front of you, so it is an
/// action on the finished run rather than a setting chosen once in the abstract.
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

    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = "Share with the channel";
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "Sharing…";
      try {
        const body = await agents.read(workspace, file.path);
        await api.attachBytes(runId, file.path, body, contentTypeFor(file.path));
        el.remove();
      } catch (err) {
        button.disabled = false;
        button.textContent = "Share with the channel";
        alert(String(err));
      }
    };

    el.append(button);
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

function offerTranscript(runId: number, name: string, sessionId: string) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "offer";

  const button = document.createElement("button");
  button.className = "ghost";
  button.textContent = "Attach transcript";
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = "Attaching…";
    try {
      const body = await agents.exportSession(name, sessionId);
      if (!body) { el.textContent = "This agent keeps no transcript."; return; }
      await api.attachArtifact(runId, transcriptName(runId, new Date()), body);
      el.remove();
    } catch (err) {
      button.disabled = false;
      button.textContent = "Attach transcript";
      alert(String(err));
    }
  };

  el.append(button);
  box.append(el);
  box.scrollTop = box.scrollHeight;
}

/// Whatever the agent offers, rendered as it comes. Per channel, because the
/// session is per channel — a cheap model here and an expensive one there.
function renderOptions() {
  const box = $("session-options");
  box.innerHTML = "";
  const name = activeAgent();
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
  });
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
  const { context } = await api.context(current.slug);
  const history = recentHistory();
  const workspace = boundFolder(current.slug, bindings)
    ?? await agents.workspace(me, name, current.slug);
  const sessionId = await agents.sessionFor(name, current.slug, workspace, api.rail(current.slug));
  const run = await api.startRun(current.slug, posted.id, name, sessionId,
                                 agents.modelFor(name, current.slug));
  renderOptions();

  let reply = "";
  const stopAsking = await agents.onAsk((asked) => askPermission(name, asked));
  const stop = await agents.onUpdate((u: Update) => {
    if (u.kind === "text") reply += u.text;
    else if (u.kind === "plan") api.plan(run.id, u.entries).catch(() => {});
    else if (u.kind === "usage") api.reportUsage(run.id, u.used, u.size, u.cost).catch(() => {});
    else if (u.kind === "config") { agents.rememberConfig(name, current!.slug, u.options); renderOptions(); }
    else api.step(run.id, "tool_use", u.label).catch(() => {});
  });

  try {
    await agents.prompt(name, sessionId, withClosing(body), context, history);
    if (reply.trim()) await api.agentSay(run.id, reply.trim());
    await api.finishRun(run.id, "succeeded");
    offerTranscript(run.id, name, sessionId);
    await offerProduced(run.id, workspace).catch(() => {});
  } catch (err) {
    await api.agentSay(run.id, `Agent error: ${String(err)}`).catch(() => {});
    await api.finishRun(run.id, "failed").catch(() => {});
  } finally {
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
    input.value = `@${activeAgent() ?? "agent"} ${input.value}`;
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
});

/// Which agent the controls act on: the one picked, or the default.
function activeAgent(): string | undefined {
  const picked = $<HTMLSelectElement>("agent-pick")?.value;
  return picked || defaultAgent(agents.definitions());
}

function renderAgentPicker() {
  const pick = $<HTMLSelectElement>("agent-pick");
  const chosen = pick.value;
  pick.innerHTML = "";
  for (const def of agents.definitions()) {
    const el = document.createElement("option");
    el.value = def.name;
    el.textContent = agents.isRunning(def.name) ? `${def.name} ●` : def.name;
    pick.append(el);
  }
  pick.value = chosen && agents.definitions().some((d) => d.name === chosen)
    ? chosen : (defaultAgent(agents.definitions()) ?? "");
  pick.hidden = agents.definitions().length < 2;

  const name = activeAgent();
  const on = !!name && agents.isRunning(name);
  $("agent-status").textContent = on ? "ready" : "off";
  $("agent-toggle").textContent = on ? `Stop ${name}` : `Start ${name ?? "agent"}`;
}

$("agent-pick").addEventListener("change", () => { renderAgentPicker(); renderOptions(); });

$("agent-toggle").addEventListener("click", async () => {
  const name = activeAgent();
  if (!name) return;
  try {
    if (agents.isRunning(name)) {
      await agents.stop(name);
      renderAgentPicker();
    } else {
      $("agent-status").textContent = "starting…";
      await agents.start(name);
      renderAgentPicker();
      if (current) {
        const dir = boundFolder(current.slug, bindings)
          ?? await agents.workspace(me, name, current.slug);
        await agents.sessionFor(name, current.slug, dir, api.rail(current.slug));
        renderOptions();
      }
    }
  } catch (err) {
    $("agent-status").textContent = "failed";
    alert(`Could not start ${name}.\n\n${String(err)}\n\nInstall it with: npm i -g opencode-ai`);
  }
});

// A local view preference, not a property of the session. The record is
// complete either way; this only decides how much of it is on screen.
let showSteps = true;

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
  if ((e as MouseEvent).shiftKey) {
    bindings = settings.bind(current.slug, null);
    renderBinding();
    return;
  }
  const chosen = await chooseFolder({ directory: true, title: `Where # ${current.slug} works` });
  if (typeof chosen === "string") bindings = settings.bind(current.slug, chosen);
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
function say(text: string, action?: string, run?: () => Promise<void>) {
  const el = document.createElement("div");
  el.className = "notice";
  el.append(document.createTextNode(`${text} `));
  if (action && run) {
    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = action;
    button.onclick = async () => {
      button.disabled = true;
      try { await run(); } catch (err) { button.disabled = false; alert(String(err)); }
    };
    el.append(button);
  }
  $("notices").append(el);
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

  // The room first. It is the product, and everything below is a detail of the
  // toolbar that can arrive late without anybody minding.
  channels = await api.channels();
  renderChannels();
  if (channels.length) await open(channels[0].slug);

  // Agents already running from an earlier window of this session stay
  // addressable — the registry is the process's, not this view's. If the bridge
  // does not answer, the picker is briefly wrong, which is better than a room
  // that never appeared.
  agents.use(settings.load());
  for (const name of await orAfter(agents.listRunning(), 2000, [])) agents.markRunning(name);
  renderAgentPicker();

  const version = await getVersion().catch(() => "");
  noticeDrift(version, how.version);
  offerUpdate().catch(() => {});
}

boot().catch((e) => alert(`Cannot reach the server.\n\n${String(e)}`));
