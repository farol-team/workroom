// A person's agent definitions: what they wrote down, made whole.
//
// AGENT_NAME comes from addressing, which takes AgentDef back as a type only —
// erased at compile, so the modules do not cycle at runtime.

import { BASELINE } from "../agents/catalog";
import { AGENT_NAME } from "./addressing";

/// A person's agent: a command to run, under a name they choose. Never a
/// credential — the agent authenticates itself on this machine (Article P2).
///
/// Two agents that fill a CRM and answer customers are not two names for one
/// thing (#232): a definition may also say what its agent is told and which
/// model it starts on. Both optional — a bare name-and-command stays exactly
/// what it always was.
export interface AgentDef {
  name: string;
  command: string;
  args: string[];
  default?: boolean;
  /// What this agent is for, said at the top of every turn. Through the
  /// prompt's context, never a vendor flag — every ACP agent takes a prompt,
  /// and an instruction that only works where a CLI has
  /// --append-system-prompt is an agent that behaves differently per vendor.
  instruction?: string;
  /// The model the agent starts on. Applied once, at a session's birth, so the
  /// per-channel override the session options offer survives every later turn.
  model?: string;
}

/// The persona line a turn opens with, when the definition carries one (#232).
export function instructionOf(def?: AgentDef): string | null {
  const text = def?.instruction?.trim();
  return text ? `You are @${def!.name}. ${text}` : null;
}

/// Definitions come from a file a person edits, so they arrive malformed. Two
/// defaults is a coin toss over who answers `@agent`; none is a dead `@agent`.
///
/// Whatever survives, the agents this project supports are named beside it.
/// An agent you did not guess the name of is one you do not have: without this
/// the three exist only for somebody who already knew to write them down.
/// Naming one installs nothing — it is listed, with the state it is really in.
export function normalizeAgents(defs: AgentDef[]): AgentDef[] {
  const seen = new Set<string>();
  const clean: AgentDef[] = [];

  for (const d of defs) {
    const name = d.name?.trim();
    const command = d.command?.trim();
    if (!name || !command || !AGENT_NAME.test(name)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const instruction = d.instruction?.trim();
    const model = d.model?.trim();
    clean.push({ name, command, args: d.args ?? [],
                 ...(instruction ? { instruction } : {}),
                 ...(model ? { model } : {}),
                 ...(d.default ? { default: true } : {}) });
  }

  // Appended, never imposed: a person running opencode from a checkout keeps
  // their own command for it, and keeps `@agent` pointing where they put it.
  for (const profile of BASELINE) {
    if (seen.has(profile.name)) continue;
    seen.add(profile.name);
    clean.push({ name: profile.name, command: profile.command, args: [ ...profile.args ] });
  }

  const first = clean.findIndex((d) => d.default);
  return clean.map((d, i) => {
    const isDefault = first === -1 ? i === 0 : i === first;
    const { default: _, ...rest } = d;
    return isDefault ? { ...rest, default: true } : rest;
  });
}

/// The editor's save (#231): the person's own list with `def` in place of any
/// entry answering to the same name, case-insensitively — a name is how an
/// agent is addressed, and `@Crm` and `@crm` must not become two agents. When
/// the saved one is the default, nobody else stays default: two defaults is
/// the coin toss normalizeAgents exists to resolve, and the editor should not
/// manufacture the situation it would have to resolve.
export function upsertDefinition(defs: AgentDef[], def: AgentDef): AgentDef[] {
  const rest = defs.filter((d) => d.name.toLowerCase() !== def.name.toLowerCase());
  return def.default
    ? [ ...rest.map(({ default: _, ...d }) => d), def ]
    : [ ...rest, def ];
}

/// Taking a definition out of the person's list. For one of the baseline three
/// this is a reset, not a removal — normalizeAgents appends them whatever was
/// saved, so the project's own definition comes back (#231).
export function removeDefinition(defs: AgentDef[], name: string): AgentDef[] {
  return defs.filter((d) => d.name.toLowerCase() !== name.toLowerCase());
}

/// Arguments as a person types them: one line, split on whitespace. An argument
/// that itself contains a space cannot be written here — the definitions this
/// edits have never carried one, and inventing quoting for the form would be a
/// shell nobody asked for.
export function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}
