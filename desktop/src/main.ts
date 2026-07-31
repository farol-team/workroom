import { Api, type Channel, type Message } from "./api";
import { StepLedger, WorkingSignal, contentTypeFor, dayLabel, defaultAgent, formatHistory, occupancyLabel, parseAddress, selectable, transcriptName, unreadCount, withClosing, worthOffering, type PlanEntry, type RunSignal } from "./rules";
import { Agents, type Update } from "./agent";
import * as settings from "./settings";

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
  el.innerHTML = `<div class="from">${escape(who)}</div><div class="body"></div>`;
  el.querySelector<HTMLElement>(".body")!.textContent = m.body;
  return el;
}

function addMessage(m: Message) {
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
  const files = await agents.produced(workspace);
  if (!worthOffering(files)) return;

  const box = $("messages");
  for (const file of files.filter((f) => f.bytes > 0)) {
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
  $("messages").innerHTML = "";
  seenCount.set(slug, full.messages.length);
  if (full.messages.length) full.messages.forEach(addMessage);
  else showIntro(full);
  renderChannels();
  if (!$("memory").hidden) { renderMemory(); renderSkills(); }
  renderOptions();

  socket?.close();
  socket = api.live(slug, (e) => {
    if (e.type === "message") addMessage(e.message);
    if (e.type === "step") addStep(e.step.run_id, e.step.label ?? e.step.kind, e.step.id);
    if (e.type === "run") showPresence(e.run);
    if (e.type === "plan") showPlan(e.plan.run_id, e.plan.entries);
    if (e.type === "artifact") addArtifact(e.artifact);
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
  const workspace = await agents.workspace(me, name, current.slug);
  const sessionId = await agents.sessionFor(name, current.slug, workspace, api.rail(current.slug));
  const run = await api.startRun(current.slug, posted.id, name, sessionId,
                                 agents.modelFor(name, current.slug));
  renderOptions();

  let reply = "";
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
        const dir = await agents.workspace(me, name, current.slug);
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
  if (!panel.hidden) { renderMemory(); renderSkills(); }
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

async function boot() {
  const dialog = $<HTMLDialogElement>("signin");
  dialog.showModal();
  await new Promise<void>((r) => dialog.addEventListener("close", () => r(), { once: true }));

  const { user } = await api.signIn($<HTMLInputElement>("email").value.trim());
  me = user.email;
  $("who").textContent = user.name;

  // Agents already running from an earlier window of this session stay
  // addressable — the registry is the process's, not this view's.
  agents.use(settings.load());
  for (const name of await agents.listRunning()) agents.markRunning(name);
  renderAgentPicker();

  channels = await api.channels();
  renderChannels();
  if (channels.length) await open(channels[0].slug);
}

boot().catch((e) => alert(`Cannot reach the server.\n\n${String(e)}`));
