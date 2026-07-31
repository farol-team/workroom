// The client's decision logic, kept out of main.ts so it can be exercised
// without a window. Everything here decides something; nothing here draws.

/// An agent answers only when its owner addresses it. Parsed before the message
/// is posted, so the marker never reaches the channel body.
export const ADDRESS = /^\s*@agent\b[:,]?\s*/i;

export function parseAddress(text: string): { addressed: boolean; body: string } {
  const m = text.match(ADDRESS);
  return m ? { addressed: true, body: text.slice(m[0].length) } : { addressed: false, body: text };
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
export interface PlanEntry { content: string; priority?: string; status?: string }

export type Update =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "plan"; entries: PlanEntry[] }
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
  if (t === "plan") {
    const entries = (u.entries as PlanEntry[] | undefined) ?? [];
    return entries.length ? { kind: "plan", entries } : null;
  }
  if (t === "tool_call" || t === "tool_call_update") {
    return { kind: "tool", label: (u.title ?? u.kind ?? u.toolCallId ?? "tool") as string };
  }
  return t ? { kind: "other", label: t } : null;
}
