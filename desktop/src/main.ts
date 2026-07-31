import { Api, type Channel, type Message } from "./api";
import { StepLedger, formatHistory, parseAddress, presenceState, type RunSignal } from "./rules";
import { Agent, type Update } from "./agent";

const api = new Api(import.meta.env.VITE_WORKROOM_SERVER ?? "http://127.0.0.1:3000");
const agent = new Agent();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let channels: Channel[] = [];
let current: Channel | null = null;
let socket: WebSocket | null = null;
let runSteps = new Map<number, string[]>();

// ---------- rendering ----------

function renderChannels() {
  $("channels").innerHTML = "";
  for (const c of channels) {
    const b = document.createElement("button");
    b.textContent = `# ${c.slug}`;
    b.className = c.slug === current?.slug ? "active" : "";
    b.onclick = () => open(c.slug);
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
  box.append(messageEl(m));
  box.scrollTop = box.scrollHeight;
}

const stepLedger = new StepLedger();
const runSignals: RunSignal[] = [];

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

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- channel ----------

/// A colleague at work must be distinguishable from a colleague who is absent —
/// otherwise `private` turns translucent into invisible.
function showPresence(run: RunSignal) {
  runSignals.push(run);
  const working = presenceState(runSignals);
  const box = $("messages");

  box.querySelectorAll(".presence").forEach((el) => el.remove());
  for (const [ id, who ] of working) {
    const el = document.createElement("div");
    el.id = `presence-${id}`;
    el.className = "presence";
    el.textContent = `${who} is working with their agent…`;
    box.append(el);
  }
  box.scrollTop = box.scrollHeight;
}

async function open(slug: string) {
  const full = await api.channel(slug);
  current = full;
  renderChannels();
  $("channel-name").textContent = `# ${full.slug}`;
  $("channel-purpose").textContent = full.purpose ?? "";
  $("messages").innerHTML = "";
  full.messages.forEach(addMessage);
  if (!$("memory").hidden) renderMemory();

  socket?.close();
  socket = api.live(slug, (e) => {
    if (e.type === "message") addMessage(e.message);
    if (e.type === "step") addStep(e.step.run_id, e.step.label ?? e.step.kind, e.step.id);
    if (e.type === "run") showPresence(e.run);
  });
}

// ---------- the turn ----------

async function send(text: string) {
  if (!current) return;

  // Default is the room. The agent joins only when its owner calls it.
  const { addressed, body } = parseAddress(text);
  const posted = await api.post(current.slug, body);
  if (!addressed) return;

  if (!agent.running) {
    alert("Your agent is not running. Press Start agent first.");
    return;
  }

  // What the room knows, plus what was just said in it — both belong to the
  // channel, so a colleague's message is context even though only the owner
  // may give the instruction.
  const { context } = await api.context(current.slug);
  const history = recentHistory();
  const sessionId = await agent.sessionFor(current.slug, "/tmp");
  const run = await api.startRun(current.slug, posted.id, sessionId);
  if (visibility !== "outcomes") await api.setVisibility(run.agent_session_id, visibility).catch(() => {});

  let reply = "";
  const stop = await agent.onUpdate((u: Update) => {
    if (u.kind === "text") reply += u.text;
    else api.step(run.id, "tool_use", u.label).catch(() => {});
  });

  try {
    await agent.prompt(sessionId, body, context, history);
    if (reply.trim()) await api.agentSay(run.id, reply.trim());
    await api.finishRun(run.id, "succeeded");
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
  const { addressed } = parseAddress(input.value);
  $("destination").textContent = addressed ? "→ your agent" : "→ the room";
  $("destination").className = addressed ? "to-agent" : "muted";
}

$("input").addEventListener("input", refreshDestination);

$("summon").addEventListener("click", () => {
  const input = $<HTMLInputElement>("input");
  if (!parseAddress(input.value).addressed) input.value = `@agent ${input.value}`;
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

$("agent-toggle").addEventListener("click", async () => {
  try {
    if (agent.running) {
      await agent.stop();
      $("agent-status").textContent = "off";
      $("agent-toggle").textContent = "Start agent";
    } else {
      $("agent-status").textContent = "starting…";
      await agent.start();
      $("agent-status").textContent = "ready";
      $("agent-toggle").textContent = "Stop agent";
    }
  } catch (err) {
    $("agent-status").textContent = "failed";
    alert(`Could not start the agent.\n\n${String(err)}\n\nInstall it with: npm i -g opencode-ai`);
  }
});

let visibility: "full" | "outcomes" | "private" = "outcomes";

$("visibility").addEventListener("change", (e) => {
  visibility = (e.target as HTMLSelectElement).value as typeof visibility;
});

$("memory-toggle").addEventListener("click", () => {
  const panel = $("memory");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderMemory();
});

async function boot() {
  const dialog = $<HTMLDialogElement>("signin");
  dialog.showModal();
  await new Promise<void>((r) => dialog.addEventListener("close", () => r(), { once: true }));

  const { user } = await api.signIn($<HTMLInputElement>("email").value.trim());
  $("who").textContent = user.name;

  channels = await api.channels();
  renderChannels();
  if (channels.length) await open(channels[0].slug);
}

boot().catch((e) => alert(`Cannot reach the server.\n\n${String(e)}`));
