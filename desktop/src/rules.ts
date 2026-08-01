// The client's decision logic, kept out of main.ts so it can be exercised
// without a window. Everything here decides something; nothing here draws.

import { BASELINE } from "./agents/catalog";

/// An agent answers only when its owner addresses it. Parsed before the message
/// is posted, so the marker never reaches the channel body.
export const ADDRESS = /^\s*@agent\b[:,]?\s*/i;

/// A person's agent: a command to run, under a name they choose. Never a
/// credential — the agent authenticates itself on this machine (Article P2).
export interface AgentDef {
  name: string;
  command: string;
  args: string[];
  default?: boolean;
}

/// What a name may be, and therefore what `@` can reach.
export const AGENT_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const NAMED = /^\s*@([a-z0-9][a-z0-9._-]*)\b[:,]?\s*/i;

/// `@agent` summons whichever agent is default; `@<name>` summons that one. A
/// name nobody configured is a colleague, not a summons — the room is full of
/// people, and addressing one of them is not addressing an agent.
export function parseAddress(
  text: string,
  agents: AgentDef[] = [],
): { addressed: boolean; agent?: string; body: string } {
  const generic = text.match(ADDRESS);
  if (generic) {
    return { addressed: true, agent: defaultAgent(agents), body: text.slice(generic[0].length) };
  }

  const named = text.match(NAMED);
  const match = named && agents.find((a) => a.name.toLowerCase() === named[1].toLowerCase());
  if (match) return { addressed: true, agent: match.name, body: text.slice(named![0].length) };

  return { addressed: false, body: text };
}

export function defaultAgent(agents: AgentDef[]): string | undefined {
  return (agents.find((a) => a.default) ?? agents[0])?.name;
}

/// Which agent the controls act on: the one chosen, while it is still one this
/// person has, and otherwise the default. Choosing is separate from addressing
/// — `@agent` always means the default, and this is what the session options
/// and the summon button follow.
///
/// A name nothing answers to is not a choice, so a definition that went away
/// hands the controls back to the default rather than to nothing.
export function activeAgent(agents: AgentDef[], chosen?: string): string | undefined {
  return agents.some((a) => a.name === chosen) ? chosen : defaultAgent(agents);
}

/// Definitions come from a file a person edits, so they arrive malformed. Two
/// defaults is a coin toss over who answers `@agent`; none is a dead `@agent`.
///
/// Whatever survives, the agents this project supports are named beside it.
/// An agent you did not guess the name of is one you do not have: without this
/// the two that are not bundled exist only for somebody who already knew to
/// write them down. Naming one installs nothing — it is listed, with the state
/// it is really in.
export function normalizeAgents(defs: AgentDef[]): AgentDef[] {
  const seen = new Set<string>();
  const clean: AgentDef[] = [];

  for (const d of defs) {
    const name = d.name?.trim();
    const command = d.command?.trim();
    if (!name || !command || !AGENT_NAME.test(name)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    clean.push({ name, command, args: d.args ?? [], ...(d.default ? { default: true } : {}) });
  }

  // Appended, never imposed: a person running opencode from a checkout keeps
  // their own command for it, and keeps `@agent` pointing where they put it.
  for (const profile of BASELINE) {
    if (seen.has(profile.name)) continue;
    seen.add(profile.name);
    clean.push({ name: profile.name, command: profile.command, args: [ ...profile.args ] });
  }

  const first = clean.findIndex((d) => d.default);
  return clean.map((d, i) => {
    const isDefault = first === -1 ? i === 0 : i === first;
    const { default: _, ...rest } = d;
    return isDefault ? { ...rest, default: true } : rest;
  });
}

/// A session outlives the window that opened it. Without this every restart
/// creates a new one and loses the thread — in a product whose claim is that the
/// room does not forget.
export function remember(store: Record<string, string>, agent: string, slug: string, id: string) {
  store[sessionKey(agent, slug)] = id;
}

export function recall(store: Record<string, string>, agent: string, slug: string) {
  return store[sessionKey(agent, slug)];
}

export function forget(store: Record<string, string>, agent: string, slug: string) {
  delete store[sessionKey(agent, slug)];
}

/// A session belongs to the agent that opened it, in the channel it was opened
/// for. Keyed by anything less, two agents in one room share a session id.
export function sessionKey(agent: string, slug: string): string {
  return `${agent}/${slug}`;
}

/// Everybody mentioned in a message, as handles.
///
/// Anywhere in the line, not only at the start — `parseAddress` is about who
/// the message is *for*, and this is about who it names. A mention inside a
/// sentence still means somebody should be able to read it.
const MENTIONS = /(?:^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]*)/gi;

export function mentionsIn(text: string): string[] {
  return [ ...new Set([ ...text.matchAll(MENTIONS) ].map((m) => m[1].toLowerCase())) ];
}

/// Who was named and is not in the room. The people already here are not an
/// offer, and neither is the agent — `@agent` addresses one, it does not invite
/// a colleague.
export function missingFrom(
  text: string,
  present: Array<{ handle: string }>,
  workspace: Array<{ handle: string; name: string }>,
  agents: Array<{ name: string }> = [],
): Array<{ handle: string; name: string }> {
  const here = new Set(present.map((p) => p.handle.toLowerCase()));
  const addressed = new Set([ "agent", ...agents.map((a) => a.name.toLowerCase()) ]);

  return mentionsIn(text)
    .filter((handle) => !here.has(handle) && !addressed.has(handle))
    .map((handle) => workspace.find((w) => w.handle.toLowerCase() === handle))
    .filter((person): person is { handle: string; name: string } => Boolean(person));
}

/// The rooms this person can reach, and the token for each.
///
/// A token belongs to a membership, so somebody in two workspaces holds two —
/// and switching means having the other one already. It is never fetched: an
/// endpoint that hands over a token for another room would hand it to an agent
/// too, since an agent holds the same token the client does. So a token is here
/// because this client was given it, by signing in or by making the room.
export interface Rooms { current?: string; tokens: Record<string, string> }

export function loadRooms(raw: string | null): Rooms {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    const tokens = parsed?.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {};
    const current = typeof parsed?.current === "string" ? parsed.current : undefined;
    return { current: current && tokens[current] ? current : undefined, tokens };
  } catch {
    // A corrupt file should cost the person their place, not their account.
    return { tokens: {} };
  }
}

export function enterRoom(rooms: Rooms, slug: string, token?: string): Rooms {
  const tokens = token ? { ...rooms.tokens, [slug]: token } : rooms.tokens;
  return tokens[slug] ? { current: slug, tokens } : rooms;
}

export function tokenForRoom(rooms: Rooms, slug: string): string | undefined {
  return rooms.tokens[slug];
}

/// The rooms this client can actually open. A room somebody belongs to but has
/// no token for is not one of them — it needs signing in again, and saying so
/// is better than a switch that silently does nothing.
export function reachableRooms(rooms: Rooms): string[] {
  return Object.keys(rooms.tokens).sort();
}

/// Which cached keys belong to one agent. Sessions and their options are filed
/// under agent and channel, so forgetting an agent means forgetting those — and
/// not those of an agent whose name merely begins the same way, which is what
/// matching on the bare name would do.
export function keysOf(agent: string, keys: Iterable<string>): string[] {
  const prefix = sessionKey(agent, "");
  return [ ...keys ].filter((key) => key.startsWith(prefix));
}

/// Versions, as numbers. `0.10.0` is newer than `0.9.0`, and comparing the two
/// as text says the opposite.
function parts(version?: string): number[] | null {
  if (!version) return null;
  const numbers = version.trim().split(".").map((p) => Number(p));
  return numbers.length === 3 && numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/// What to say about a release that exists. Nothing is installed by saying it:
/// an agent workspace that replaces its own binary without being asked is a
/// thing people are right to distrust.
export function updateNotice(v: { current: string; available: string }): string | null {
  const here = parts(v.current);
  const there = parts(v.available);
  if (!here || !there || compare(there, here) <= 0) return null;

  return `WorkRoom ${v.available} is available. You have ${v.current}.`;
}

/// A client and a workspace that have drifted apart. The failure is not an
/// error — it is a feature that quietly does nothing, which is the most
/// expensive kind — so it is said plainly rather than discovered.
///
/// A patch apart is not drift: these ship together and will always be a few
/// commits apart, and saying so every launch teaches people to ignore the one
/// that matters.
export function driftNotice(client: string, server?: string): string | null {
  const here = parts(client);
  const there = parts(server);
  if (!here || !there) return null;
  if (here[0] === there[0] && here[1] === there[1]) return null;

  return compare(there, here) > 0
    ? `This workspace is running ${server} and this app is ${client}. Some things here may not work.`
    : `This app is ${client} and the workspace is running ${server}. Some things here may not work.`;
}

/// The channel's rail, as the protocol says an MCP server is described.
///
/// Headers are a list of `{ name, value }`. Sent as an object the agent reaches
/// the rail unauthenticated, every call comes back 401, and it answers from
/// nothing — which reads as the product not working rather than as a wire
/// format we got wrong.
export interface Rail { url: string; token: string }

/// The context store, reached directly. Permitted by the amendment to P1 dated
/// 2026-08-01: its own surface for agents is MCP, so this speaks the seam's
/// protocol rather than around it. What it does not give is a channel boundary
/// — the store isolates accounts and knows nothing of channels, which is why
/// the boundary is stated in the prompt and called a convention there.
export interface ContextStore { url: string; key: string }

export function mcpServersFor(rail?: Rail, store?: ContextStore | null): unknown[] {
  const servers: unknown[] = [];
  if (rail) {
    servers.push({
      name: "workroom", type: "http", url: rail.url,
      headers: [ { name: "Authorization", value: `Bearer ${rail.token}` } ],
    });
  }
  if (store) {
    servers.push({
      name: "context", type: "http", url: store.url,
      headers: [ { name: "Authorization", value: `Bearer ${store.key}` } ],
    });
  }
  return servers;
}

/// The agent asking to do something, and waiting.
///
/// Nothing is decided here and nothing is auto-allowed: the options are the
/// agent's, shown as it sent them. A client that answers on somebody's behalf
/// has quietly moved the decision, and a client that invents an option the
/// agent did not offer is answering a question it was not asked.
export interface Asked {
  /// As the agent sent it. JSON-RPC allows a string here, and `Number("abc")`
  /// is NaN — an answer addressed to nobody, which is a turn that never ends.
  id: unknown;
  /// Which turn is asking. Without it a dialog for one channel's agent is shown
  /// as though this channel's agent had asked, and the person authorises a call
  /// they were never shown (#91).
  sessionId?: string;
  title: string;
  options: Array<{ id: string; name: string; kind?: string }>;
}

/// Which session an ACP message belongs to. Both `session/update` and
/// `session/request_permission` carry it and neither was read, so what an agent
/// said was routed by who happened to be listening.
export function sessionOf(event: unknown): string | undefined {
  const e = event as { sessionId?: unknown; params?: { sessionId?: unknown };
                       request?: { params?: { sessionId?: unknown } } };
  const found = e?.params?.sessionId ?? e?.request?.params?.sessionId ?? e?.sessionId;
  return typeof found === "string" && found ? found : undefined;
}

export function permissionAsked(event: unknown): Asked | null {
  const e = event as { id?: unknown; request?: { method?: string; params?: any } };
  if (e?.request?.method !== "session/request_permission") return null;

  const params = e.request.params ?? {};
  return {
    // Passed through untouched, all the way back to the agent's stdin.
    id: e.id,
    sessionId: sessionOf(event),
    title: params.toolCall?.title ?? "The agent is asking to do something",
    options: (params.options ?? []).map((o: any) => ({
      id: String(o.optionId), name: String(o.name ?? o.optionId), kind: o.kind,
    })),
  };
}

/// What to do with an answer that may never come.
///
/// A call across the bridge to the native side usually answers. "Usually" is
/// what leaves somebody looking at a window that never filled in, with nothing
/// to report — so a call that hangs, or fails, falls back instead of winning.
export function orAfter<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/// Where a channel's work happens.
///
/// The default is a directory derived for it — safe, and a channel cannot
/// scribble in another channel's work. But `cwd` in ACP is the project root:
/// an agent reads its conventions from there, and the code somebody is asking
/// about lives there. So a channel may be bound to a folder they already have.
///
/// A binding is per person and stays on their machine. One keeps the repository
/// in `~/src/billing` and a colleague in `~/work/billing`; a filesystem layout
/// is not something the workspace should learn.
export type Bindings = Record<string, string>;

export function boundFolder(slug: string, bindings: Bindings): string | null {
  return bindings[slug]?.trim() || null;
}

/// What is worth putting in front of somebody at the end of a turn.
///
/// In a folder that is already theirs, one `npm install` turns the offer into
/// thousands of files. An offer nobody can read is worse than no offer, so it
/// is capped and says what it left out.
export function offerable<T extends { path: string; bytes: number }>(
  files: T[], limit: number,
): { files: T[]; omitted: number } {
  const real = files.filter((f) => f.bytes > 0);
  return real.length <= limit
    ? { files: real, omitted: 0 }
    : { files: real.slice(0, limit), omitted: real.length - limit };
}

/// What a produced file is, so it downloads as itself. Everything unrecognised
/// is bytes rather than a guess — a wrong type is worse than none.
const TYPES: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv",
  html: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", pdf: "application/pdf", zip: "application/zip",
};

export function contentTypeFor(path: string): string {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/// An empty file is not work product, and an empty offer is noise.
export function worthOffering(files: Array<{ path: string; bytes: number }>): boolean {
  return files.some((f) => f.bytes > 0);
}

/// The distiller is the agent, not a job on the server. It already runs on this
/// person's machine under their credentials, and it already reaches the room's
/// memory through the rail — so it needs no mechanism, only to be asked.
///
/// Asked, never told. An entry the agent did not choose to keep is an entry
/// nobody will come back and correct.
export function closingInstruction(): string {
  return [
    "---",
    "",
    "Before you finish: if this turn produced something the room should still",
    "know next week — a decision, a constraint, something that turned out to be",
    "true — record it with workroom://memory/remember, in your own words, as one",
    "entry. If it did not, keep nothing. Do not record the conversation itself;",
    "the room already has it.",
  ].join("\n");
}

/// Appended to the turn rather than sent after it: a second prompt is a second
/// model call the person pays for, on every turn, whether or not there was
/// anything worth keeping.
export function withClosing(text: string): string {
  if (!text.trim()) return text;
  return `${text}\n\n${closingInstruction()}`;
}

/// What the room just said, as the agent would read it. Channel history is
/// context even when it came from a colleague — an agent reads the room.
export function formatHistory(rows: Array<{ who: string; what: string }>, limit = 20): string | null {
  const recent = rows.slice(-limit).filter((r) => r.what.trim().length > 0);
  if (!recent.length) return null;
  return `Recently in this channel:\n\n${recent.map((r) => `${r.who}: ${r.what}`).join("\n")}`;
}

/// Under `full` a step arrives on both the room stream and the owner's.
/// Dedup belongs here rather than server-side: exclusion would require knowing
/// the subscriber, which Action Cable broadcasting deliberately does not.
export class StepLedger {
  private seen = new Set<number>();

  admit(id?: number): boolean {
    if (id === undefined) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }

  get size() { return this.seen.size; }
}

export type RunSignal = { id: number; status: string; user: string };

/// Who is working, computed once and read by every surface that shows it.
///
/// The pain this product exists for is not knowing what is going on, and a
/// signal each surface computes for itself disagrees with itself: the sidebar
/// says one thing, the room another. There is one of these.
export interface Working { who: string; since: number }

export class WorkingSignal {
  private runs = new Map<number, { channel: string; who: string; at: number }>();

  observed(run: { runId: number; channel: string; who: string; at: number }) {
    this.runs.set(run.runId, { channel: run.channel, who: run.who, at: run.at });
  }

  ended(runId: number) { this.runs.delete(runId); }

  /// One line per person, anchored at their earliest run — a second run
  /// starting must not reset the elapsed time a colleague is watching.
  inChannel(channel: string): Working[] {
    const earliest = new Map<string, number>();
    for (const r of this.runs.values()) {
      if (r.channel !== channel) continue;
      earliest.set(r.who, Math.min(earliest.get(r.who) ?? r.at, r.at));
    }
    return [...earliest].map(([ who, since ]) => ({ who, since }));
  }

  anywhere(): Array<Working & { channel: string }> {
    const seen = new Map<string, Working & { channel: string }>();
    for (const r of this.runs.values()) {
      const key = `${r.who} ${r.channel}`;
      const at = Math.min(seen.get(key)?.since ?? r.at, r.at);
      seen.set(key, { who: r.who, since: at, channel: r.channel });
    }
    return [...seen.values()];
  }

  /// What a room says out loud. Naming one person is worth more than a count;
  /// past that, a count is worth more than a list.
  label(channel: string): string | null {
    const working = this.inChannel(channel);
    if (!working.length) return null;
    return working.length === 1
      ? `${working[0].who}'s agent is working`
      : `${working.length} agents are working`;
  }
}

/// How a voice is recognised before the name is read. Derived from the name, so
/// it needs nothing from the server and never disagrees between two surfaces.
///
/// An agent carries its owner's colour and is marked as an agent: it is Alice's
/// agent, not a second Alice and not a stranger.
export interface Identity { initials: string; hue: number; isAgent: boolean }

export function identity(author: { kind: string; name: string }): Identity {
  const words = author.name.trim().split(/\s+/).filter(Boolean);
  const initials = words.length
    ? (words.length === 1 ? words[0][0] : words[0][0] + words[words.length - 1][0]).toUpperCase()
    : "?";

  let hash = 0;
  for (const ch of author.name.trim().toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 360;

  return { initials, hue: hash, isAgent: author.kind === "agent" };
}

/// A room with ten thousand messages in it should not put ten thousand elements
/// on screen. What is kept is the recent end, because that is what people read.
export function onScreen<T>(messages: T[], limit: number): { messages: T[]; hidden: number } {
  if (messages.length <= limit) return { messages, hidden: 0 };
  return { messages: messages.slice(-limit), hidden: messages.length - limit };
}

/// A message as the room deals with it: who wrote it, and what it answers.
export interface Threaded {
  id: number;
  parent_id: number | null;
  author: { kind: string; name: string };
}

/// What the room itself shows. A person replying to a message is starting a
/// side conversation; an agent answering is doing the room's work, and putting
/// that answer in a panel would leave a room full of questions and no answers.
export function inTimeline(m: Threaded): boolean {
  return m.parent_id === null || m.author.kind === "agent";
}

/// A thread is its root and everything hanging off it, in the order it was said.
export function threadOf<T extends Threaded>(all: T[], rootId: number): T[] {
  return all.filter((m) => m.id === rootId || m.parent_id === rootId);
}

/// What the room is told about a conversation it is not being shown. An agent's
/// answer is already in the room, so counting it would advertise a conversation
/// that never happened.
export function threadSummary(replies: Threaded[]): string | null {
  const people = replies.filter((m) => m.author.kind !== "agent");
  if (!people.length) return null;

  const voices = [ ...new Set(people.map((m) => m.author.name)) ];
  const count = `${people.length} ${people.length === 1 ? "reply" : "replies"}`;
  return `${count} · ${voices.join(", ")}`;
}

/// A conversation is read a day at a time.
export function dayLabel(at: string, today = new Date()): string {
  const day = at.slice(0, 10);
  const shift = (n: number) => new Date(today.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  if (day === shift(0)) return "Today";
  if (day === shift(-1)) return "Yesterday";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

/// The time of day on a message row — the day itself is the divider's job.
/// Read straight out of the timestamp, in the timezone the record carries, the
/// same way `dayLabel` compares the day it was given rather than converting.
export function timeLabel(at: string): string {
  return /T(\d{2}:\d{2})/.exec(at)?.[1] ?? "";
}

/// One card of the first-run setup: what the agent is called, what the machine
/// said about it, and the one thing pressing the card does. The states are the
/// panel's own inputs, so the setup and the panel cannot disagree about an
/// agent — they can only disagree about the drawing.
export interface OnboardingCard {
  name: string;
  label: string;
  state: "ready" | "missing";
  running: boolean;
  action: "install" | "start" | "stop";
}

export function onboardingCards(
  agents: Array<{ name: string; label: string; state: "ready" | "missing"; running: boolean }>,
): OnboardingCard[] {
  return agents.map((a) => ({
    ...a,
    action: a.state === "missing" ? "install" : a.running ? "stop" : "start",
  }));
}

/// Setup is worth finishing once one agent can be addressed. Zero ready is not
/// a lock — it is an empty room, and leaving is how somebody comes back with
/// one installed.
export function anyReady(cards: OnboardingCard[]): boolean {
  return cards.some((c) => c.state === "ready" || c.running);
}

/// What arrived since you last looked, from the count the channel already
/// reports. The client is subscribed to the room it has open and to nothing
/// else, so this cannot come from the stream.
///
/// A channel you have never opened is not a channel full of unread — it is a
/// channel you have not opened.
export function unreadCount(total: number, seen?: number): number {
  if (seen === undefined) return 0;
  return Math.max(0, total - seen);
}

/// Translate an ACP session/update notification into something the room can
/// display. Unknown update kinds surface as themselves rather than vanishing.
export interface ConfigChoice { value: string; name: string; description?: string }

export interface ConfigOption {
  id: string;
  name: string;
  type: string;
  currentValue: string;
  options?: ConfigChoice[];
  category?: string;
}

/// Only offer controls for shapes the agent actually sends. A control for a
/// type nobody has produced is a guess, and the option list is meant to be read
/// rather than assumed — a different agent names things differently.
export function selectable(options: ConfigOption[]): ConfigOption[] {
  return options.filter((o) => o.type === "select" && (o.options?.length ?? 0) > 0);
}

export interface PlanEntry { content: string; priority?: string; status?: string }

export type Update =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "usage"; used: number; size: number; cost?: number }
  | { kind: "config"; options: ConfigOption[] }
  | { kind: "other"; label: string };

export function translateAcp(msg: unknown): Update | null {
  const m = msg as { method?: string; params?: { update?: Record<string, unknown> } };
  if (m?.method !== "session/update") return null;
  const u = m.params?.update ?? {};
  const t = u.sessionUpdate as string | undefined;

  if (t === "agent_message_chunk") {
    const text = (u.content as { text?: string } | undefined)?.text ?? "";
    return text ? { kind: "text", text } : null;
  }
  // Process, and the rule already says process is recorded and never pushed at
  // the room. It is what lets somebody reconstruct why a turn went the way it
  // did, and it was being discarded.
  if (t === "agent_thought_chunk") {
    const text = (u.content as { text?: string } | undefined)?.text ?? "";
    return text ? { kind: "thought", text } : null;
  }
  if (t === "config_option_update") {
    const options = (u.configOptions as ConfigOption[] | undefined) ?? [];
    return options.length ? { kind: "config", options } : null;
  }
  if (t === "usage_update") {
    return { kind: "usage", used: Number(u.used), size: Number(u.size),
             cost: u.cost === undefined ? undefined : Number(u.cost) };
  }
  if (t === "plan") {
    const entries = (u.entries as PlanEntry[] | undefined) ?? [];
    return entries.length ? { kind: "plan", entries } : null;
  }
  if (t === "tool_call" || t === "tool_call_update") {
    // Named by what it is, or not recorded. An id is not a name: a step reading
    // `call_00_hWMqa5NQZWoHwgQfxDg70485` tells a colleague nothing and crowds
    // out the ones that do. A `tool_call_update` without a title is refining a
    // call that was already recorded.
    const label = (u.title ?? u.kind) as string | undefined;
    return label ? { kind: "tool", label } : null;
  }
  return t ? { kind: "other", label: t } : null;
}

/// What an attached transcript is called. Named after the run rather than the
/// session, because the run is what a colleague was watching.
export function transcriptName(runId: number, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  return `run-${runId} transcript ${stamp}.json`;
}

/// Occupancy is worth showing once it stops being noise. A run at nine percent
/// tells nobody anything; a run at eighty is why this exists.
export const OCCUPANCY_THRESHOLD = 0.6;

export function occupancyLabel(used: number, size: number): string | null {
  if (!size) return null;
  const fraction = used / size;
  if (fraction < OCCUPANCY_THRESHOLD) return null;
  return `context ${Math.round(fraction * 100)}% full`;
}

/// A shape a room can be added with, as the server offers it.
export interface RoomTemplate {
  key: string; name: string; purpose: string; skills: string[]; taken: boolean;
}

/// Offered, never created — the server's own rule, kept here. A template whose
/// room this workspace already has is still listed and cannot be picked: at the
/// moment somebody is about to make a `# legal`, the fact that there is one is
/// the thing they most need to know, and dropping it from the list would leave
/// them wondering why the shape they remember is missing.
export function pickable(t: RoomTemplate): boolean {
  return !t.taken;
}

/// What a template opens the room knowing. Skills and never memory: a template
/// cannot know a fact that is true for this room, but it can know how the work
/// is done. Rooms that carry none say so as their purpose alone — an empty
/// "opens knowing" reads as a promise the template does not keep.
export function templateNote(t: RoomTemplate): string {
  if (t.taken) return `${t.purpose} — this workspace already has one`;
  if (!t.skills.length) return t.purpose;
  return `${t.purpose} · opens knowing ${t.skills.join(", ").toLowerCase()}`;
}

/// What a filled-in dialog asks the server for. A chosen template travels as
/// its key and nothing else: the name and purpose are the server's, and sending
/// this client's copy of them would let the two drift apart on the first edit
/// to `channel_templates.yml`.
export function channelToCreate(
  asked: { template?: string; slug?: string; name?: string } | null,
): { template: string } | { slug: string; name: string } | null {
  if (!asked) return null;
  if (asked.template) return { template: asked.template };
  return asked.slug ? { slug: asked.slug, name: asked.name ?? asked.slug } : null;
}
