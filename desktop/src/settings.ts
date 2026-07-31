// What agents this person has, kept on this machine. Definitions are commands,
// never credentials — an agent authenticates itself (Article P2).

import { normalizeAgents, type AgentDef } from "./rules";

const KEY = "workroom.agents";

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
