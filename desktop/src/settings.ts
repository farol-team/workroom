// What agents this person has, kept on this machine. Definitions are commands,
// never credentials — an agent authenticates itself (Article P2).

import { normalizeAgents, type AgentDef, type Bindings } from "./rules";

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
