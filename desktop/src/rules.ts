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

/// Who the room should currently be told is working. Presence survives every
/// visibility level — without it a private session is indistinguishable from an
/// absent colleague.
export function presenceState(signals: RunSignal[]): Map<number, string> {
  const working = new Map<number, string>();
  for (const s of signals) {
    if (s.status === "running") working.set(s.id, s.user);
    else working.delete(s.id);
  }
  return working;
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
