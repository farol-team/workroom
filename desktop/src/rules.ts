// The client's decision logic, kept out of main.ts so it can be exercised
// without a window. Everything here decides something; nothing here draws.

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

/// opencode ships a first-party ACP server, so a person who has configured
/// nothing still has an agent.
export const FALLBACK_AGENT: AgentDef = {
  name: "opencode", command: "opencode", args: ["acp"], default: true,
};

/// Definitions come from a file a person edits, so they arrive malformed. Two
/// defaults is a coin toss over who answers `@agent`; none is a dead `@agent`.
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

  if (!clean.length) return [{ ...FALLBACK_AGENT }];

  const first = clean.findIndex((d) => d.default);
  return clean.map((d, i) => {
    const isDefault = first === -1 ? i === 0 : i === first;
    const { default: _, ...rest } = d;
    return isDefault ? { ...rest, default: true } : rest;
  });
}

/// A session belongs to the agent that opened it, in the channel it was opened
/// for. Keyed by anything less, two agents in one room share a session id.
export function sessionKey(agent: string, slug: string): string {
  return `${agent}/${slug}`;
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
    return { kind: "tool", label: (u.title ?? u.kind ?? u.toolCallId ?? "tool") as string };
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
