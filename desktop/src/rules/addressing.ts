// Who a message is for, and who it names.

import type { AgentDef } from "./definitions";

/// An agent answers only when its owner addresses it. Parsed before the message
/// is posted, so the marker never reaches the channel body.
export const ADDRESS = /^\s*@agent\b[:,]?\s*/i;

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

/// Which agent the controls act on: the one chosen, while it is still one this
/// person has, and otherwise the default. Choosing is separate from addressing
/// — `@agent` always means the default, and this is what the session options
/// and the summon button follow.
///
/// A name nothing answers to is not a choice, so a definition that went away
/// hands the controls back to the default rather than to nothing.
export function activeAgent(agents: AgentDef[], chosen?: string): string | undefined {
  return agents.some((a) => a.name === chosen) ? chosen : defaultAgent(agents);
}

/// Everybody mentioned in a message, as handles.
///
/// Anywhere in the line, not only at the start — `parseAddress` is about who
/// the message is *for*, and this is about who it names. A mention inside a
/// sentence still means somebody should be able to read it.
const MENTIONS = /(?:^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]*)/gi;

export function mentionsIn(text: string): string[] {
  return [ ...new Set([ ...text.matchAll(MENTIONS) ].map((m) => m[1].toLowerCase())) ];
}

/// Who was named and is not in the room. The people already here are not an
/// offer, and neither is the agent — `@agent` addresses one, it does not invite
/// a colleague.
export function missingFrom(
  text: string,
  present: Array<{ handle: string }>,
  workspace: Array<{ handle: string; name: string }>,
  agents: Array<{ name: string }> = [],
): Array<{ handle: string; name: string }> {
  const here = new Set(present.map((p) => p.handle.toLowerCase()));
  const addressed = new Set([ "agent", ...agents.map((a) => a.name.toLowerCase()) ]);

  return mentionsIn(text)
    .filter((handle) => !here.has(handle) && !addressed.has(handle))
    .map((handle) => workspace.find((w) => w.handle.toLowerCase() === handle))
    .filter((person): person is { handle: string; name: string } => Boolean(person));
}
