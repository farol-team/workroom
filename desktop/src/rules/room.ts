// What the room shows and offers: the timeline, who is working, what a turn
// produced, and the shapes a room is added or set up with.

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

/// What a turn's offer is made of: the files, and how many changed paths
/// were held back because they were dirty before the turn began (#202).
export interface TurnProduced {
  files: Array<{ path: string; bytes: number }>;
  pre_existing: number;
  /// The turn's work as a commit, when it landed one (#206). Always present
  /// from the bridge, null outside a repository or when HEAD never moved.
  committed?: { branch: string; commits: number; stat: string; on_default: boolean } | null;
}

/// A quiet account of what the turn was *not* credited with — without it,
/// "the agent produced nothing" and "the offer is broken" look the same.
export function preExistingNotice(count: number): string | null {
  return count > 0
    ? `Nothing new this turn (${count} pre-existing changes not offered)`
    : null;
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
/// The toggle answers its own question before it is pressed (#161): the count
/// the server already paid one store call for at the moment the room opened.
/// A zero is a room that knows nothing and says so; an absent count is the
/// store being away, and inventing a number for it is the lie #146 closed.
export function memoryToggleLabel(count?: number): string {
  return count === undefined ? "What the room knows" : `What the room knows (${count})`;
}

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

/// Occupancy is worth showing once it stops being noise. A run at nine percent
/// tells nobody anything; a run at eighty is why this exists.
const OCCUPANCY_THRESHOLD = 0.6;

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
///
/// Visibility travels only when it is a decision: "open" is the server's own
/// default, and sending this client's copy of it would be the same drift. The
/// template path carries it too — `# legal` picked with "private" must not
/// open an open room (#255, #256).
export function channelToCreate(
  asked: { template?: string; slug?: string; name?: string; visibility?: string } | null,
): { template: string; visibility?: string } | { slug: string; name: string; visibility?: string } | null {
  if (!asked) return null;
  const chosen = asked.visibility === "private" ? { visibility: "private" } : {};
  if (asked.template) return { template: asked.template, ...chosen };
  return asked.slug ? { slug: asked.slug, name: asked.name ?? asked.slug, ...chosen } : null;
}

/// The act that brings work predating the channel into the room (#235): a
/// distillate, never files — spike #45 declined carrying files the other way
/// and #208/#220 kept the mirror one-way, so what enters the room is what the
/// work amounts to. It is an ordinary turn on purpose: asked in the open,
/// attributed to the asker, at the asker's expense, with the conclusions
/// arriving through the rail like any other — first-class in wording, not in
/// mechanism.
export function introductionAsk(): string {
  return "@agent This room's folder holds work that predates the channel. " +
    "Read the project and record what the room should know about it with " +
    "workroom://memory/remember — a handful of entries, in your own words: " +
    "what it is, how it runs, the decisions already visible in it, and where " +
    "it stands. Record what the work amounts to, never file listings; the " +
    "room needs conclusions, not a directory.";
}

/// The dialog says which room it is about to make (#256) — before the button
/// is pressed, because after is a surprise.
export function visibilityNote(visibility: string): string {
  return visibility === "private"
    ? "Only people added to this room will see it."
    : "Everybody in this workspace can find it.";
}
