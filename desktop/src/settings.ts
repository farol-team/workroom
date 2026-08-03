// What agents this person has, kept on this machine. Definitions are commands,
// never credentials — an agent authenticates itself (Article P2).

import { loadRooms, normalizeAgents, type AgentDef, type Bindings, type Rooms } from "./rules";

const KEY = "workroom.agents";
const BINDINGS = "workroom.bindings";

export function load(): AgentDef[] {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeAgents(raw ? JSON.parse(raw) : []);
  } catch {
    // A corrupt file should cost the person their customisation, not their agent.
    return normalizeAgents([]);
  }
}

/// The list as this person wrote it, before normalizeAgents has its say — what
/// the editor edits (#231). The baseline three are not in here unless somebody
/// changed one, which is exactly the difference between their entry and ours.
export function loadDefined(): AgentDef[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/// Persist the person's list and answer with what the application now runs —
/// normalized, baseline appended, one default resolved.
export function saveAgents(defs: AgentDef[]): AgentDef[] {
  try { localStorage.setItem(KEY, JSON.stringify(defs)); } catch { /* the session keeps the defs it was handed */ }
  return normalizeAgents(defs);
}

/// Which folder a channel works in, when somebody chose one.
///
/// Local, and deliberately so: one person keeps the repository in
/// `~/src/billing` and a colleague in `~/work/billing`. The same channel points
/// somewhere different for each of them, and a filesystem layout is not
/// something the workspace should learn.
export function loadBindings(): Bindings {
  try {
    return JSON.parse(localStorage.getItem(BINDINGS) ?? "{}");
  } catch {
    return {};
  }
}

export function bind(slug: string, folder: string | null): Bindings {
  const all = loadBindings();
  if (folder) all[slug] = folder;
  else delete all[slug];
  localStorage.setItem(BINDINGS, JSON.stringify(all));
  return all;
}

const MIRRORS = "workroom.mirrors";

/// Which channels mirror their journal into their folder (#220). Per machine,
/// like the binding: the mirror is files on this disk, and a colleague's disk
/// is their own to spend.
export function mirrorOn(slug: string): boolean {
  try {
    return Boolean(JSON.parse(localStorage.getItem(MIRRORS) ?? "{}")[slug]);
  } catch {
    return false;
  }
}

export function setMirror(slug: string, on: boolean): void {
  let all: Record<string, boolean>;
  try { all = JSON.parse(localStorage.getItem(MIRRORS) ?? "{}"); } catch { all = {}; }
  if (on) all[slug] = true;
  else delete all[slug];
  localStorage.setItem(MIRRORS, JSON.stringify(all));
}

const PICKED = "workroom.picked";

/// The agent this person addresses by default. Kept across windows because a
/// choice that evaporates on restart reads as never having been offered.
export function loadPicked(): string | undefined {
  return localStorage.getItem(PICKED) ?? undefined;
}

export function savePicked(name: string): void {
  localStorage.setItem(PICKED, name);
}

const ONBOARDED = "workroom.onboarded";

/// Whether the first-run setup has had its say. The flag, not the outcome: an
/// agent installed later through the panel is as good as one installed there.
export function isOnboarded(): boolean {
  return localStorage.getItem(ONBOARDED) === "done";
}

export function markOnboarded(): void {
  localStorage.setItem(ONBOARDED, "done");
}

const ROOMS = "workroom.rooms";

/// Where this person is, and what reaches the rooms they have been given a way
/// into. Not a cache of what the server knows — a token nobody handed this
/// client cannot appear here (see `Rooms`).
export function loadWorkspaces(): Rooms {
  return loadRooms(localStorage.getItem(ROOMS));
}

export function saveWorkspaces(rooms: Rooms): Rooms {
  localStorage.setItem(ROOMS, JSON.stringify(rooms));
  return rooms;
}
