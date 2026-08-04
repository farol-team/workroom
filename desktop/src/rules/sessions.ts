// Sessions, rooms and bindings: what this client remembers between windows.

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
