// One agent turn, end to end: what it is given, what it asks, what it says
// back, and the record it leaves.

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
  /// The command the agent means to run, when the tool call carries one. More
  /// precise than the title, which for a shell ask often *is* the command but
  /// is not obliged to be (#205).
  command?: string;
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
    command: typeof params.toolCall?.rawInput?.command === "string"
      ? params.toolCall.rawInput.command
      : undefined,
    options: (params.options ?? []).map((o: any) => ({
      id: String(o.optionId), name: String(o.name ?? o.optionId), kind: o.kind,
    })),
  };
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
  | { kind: "usage"; used: number; size: number; cost?: Cost }
  | { kind: "config"; options: ConfigOption[] }
  | { kind: "other"; label: string };

/// The protocol's own shape: an amount and an ISO 4217 code. Reading it as a
/// bare number is how this column stayed empty — `Number({amount, currency})`
/// is NaN — and inventing "USD" for a missing currency is how two rooms'
/// totals become one wrong number (#97).
export interface Cost { amount: number; currency?: string }

function costOf(raw: unknown): Cost | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? { amount: raw } : undefined;
  const c = raw as { amount?: unknown; currency?: unknown } | null | undefined;
  const amount = Number(c?.amount);
  if (!Number.isFinite(amount)) return undefined;
  return { amount,
           ...(typeof c?.currency === "string" && c.currency ? { currency: c.currency } : {}) };
}

/// The reply to session/prompt — the run's own summary, which this client used
/// to discard entirely: a turn that stopped at max_tokens was recorded exactly
/// like one that finished (#97). `usage` fields stay absent where the agent
/// said nothing.
export interface TurnOutcome {
  stopReason?: string;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number;
            thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number };
  _meta?: Record<string, unknown>;
}

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
    return { kind: "usage", used: Number(u.used), size: Number(u.size), cost: costOf(u.cost) };
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

/// What an attached transcript is called. Named after the session, because the
/// record is the session's: one document when it ends, not one growing copy
/// per turn (#124).
export function transcriptName(sessionId: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  return `session ${sessionId} transcript ${stamp}.json`;
}

/// The session's record as this client rendered it — said in the document
/// itself, because it is assembled from the updates the dispatcher received,
/// not read from the agent's own storage. The entries speak the vocabulary the
/// room already shows (`text`, `thought`, `tool`, `plan`, `usage`); `config`
/// is a session option changing, which is nobody's transcript.
export function transcriptOf(sessionId: string, at: string, updates: Update[]): string {
  return JSON.stringify({
    session: sessionId,
    at,
    rendered_by: "workroom-desktop",
    entries: updates.filter((u) => u.kind !== "config"),
  }, null, 2);
}
