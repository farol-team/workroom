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

export function save(defs: AgentDef[]): AgentDef[] {
  const clean = normalizeAgents(defs);
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
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
