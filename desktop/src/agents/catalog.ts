// The agents this application knows about: what each is called, what it runs,
// and what having it would take. Data and two decisions — nothing here reaches
// the machine, and nothing here installs anything.

/// An agent this project has pinned. A person may still name any command they
/// like; a profile is what lets the client say something truthful about one
/// without being told.
export interface AgentProfile {
  name: string;
  label: string;
  command: string;
  args: string[];
  /// Whether it comes in the bundle. The one that does is there before anything
  /// is looked for, and is never offered an install (#120).
  shipped: boolean;
  /// What to fetch, for the ones that are not carried. Named here rather than
  /// in the panel, so the state and the offer cannot disagree.
  package?: string;
  docsUrl: string;
}

/// What the panel says about an agent. Two states, because a third would be a
/// guess: either the command is on this machine or it is not.
export type AgentState = "ready" | "missing";

/// The three, in the order they are shown. The shipped one leads because it is
/// the one that is certainly there.
///
/// Commands and packages verified against the registry on 2026-08-01 — the
/// command is the one `npm view <package> bin` reports, which is what ends up
/// on the machine. `desktop/test/catalog.test.ts` pins them by value, and
/// #111's bench is what keeps them honest as the vendors move.
export const BASELINE: AgentProfile[] = [
  {
    name: "claude", label: "Claude", command: "claude-agent-acp", args: [],
    shipped: true, docsUrl: "https://docs.claude.com/en/docs/claude-code/overview",
  },
  {
    name: "codex", label: "Codex", command: "codex-acp", args: [],
    shipped: false, package: "@agentclientprotocol/codex-acp",
    docsUrl: "https://developers.openai.com/codex/cli/",
  },
  {
    name: "opencode", label: "OpenCode", command: "opencode", args: [ "acp" ],
    shipped: false, package: "opencode-ai", docsUrl: "https://opencode.ai/docs/",
  },
];

/// The profile for a name, when this project pinned one. An agent nobody
/// pinned is not an error — it is somebody's own, and belongs beside these.
export function profileFor(name: string): AgentProfile | undefined {
  return BASELINE.find((p) => p.name === name.toLowerCase());
}

/// Whether an agent can be addressed right now. `resolved` is where the machine
/// says its command is, as the bridge looks for it, or null for nowhere.
export function stateOf(profile: AgentProfile, resolved: string | null): AgentState {
  return profile.shipped || resolved ? "ready" : "missing";
}

/// The one command installing this agent would run, or null for the one that
/// ships — there is nothing to fetch, and offering to fetch it would install a
/// second copy of what the bundle already carries.
///
/// Into a prefix this application owns, never the person's own node
/// installation: what WorkRoom fetches, WorkRoom keeps to itself. The prefix is
/// quoted because the app data directory on macOS has a space in it, and an
/// unquoted one reads as another package to install.
export function installCommand(profile: AgentProfile, prefix: string): string | null {
  if (profile.shipped || !profile.package) return null;
  return `npm install -g --prefix "${prefix}" ${profile.package}`;
}
