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
  /// What to fetch. Nothing rides along in the application, so every agent has
  /// one — named here rather than in the panel, so the state and the offer
  /// cannot disagree.
  package: string;
  docsUrl: string;
}

/// What the panel says about an agent. Two states, because a third would be a
/// guess: either the command is on this machine or it is not.
export type AgentState = "ready" | "missing";

/// The agents this application offers, generated from the table the client
/// itself uses (`acp-agents::HARNESSES`) rather than written twice.
///
/// The panel is drawn before anything has been invoked, so this stays a plain
/// constant; a spec on the Rust side fails when the two drift apart, and
/// `UPDATE_CATALOG=1 cargo test` in `desktop/src-tauri` regenerates it. Agents
/// with nothing to fetch — Cursor, today — are in the shared table and not
/// here: the panel's whole job is a button.
export { BASELINE } from "./generated";
import { BASELINE } from "./generated";

/// The profile for a name, when this project pinned one. An agent nobody
/// pinned is not an error — it is somebody's own, and belongs beside these.
export function profileFor(name: string): AgentProfile | undefined {
  return BASELINE.find((p) => p.name === name.toLowerCase());
}

/// Whether an agent can be addressed right now. `resolved` is where the machine
/// says its command is, as the bridge looks for it, or null for nowhere.
///
/// One question, asked of the machine, and the profile is not consulted: an
/// agent this project pinned is in exactly the state an agent it never heard of
/// would be, and there is nothing the panel can report as ready without having
/// found it (#120).
export function stateOf(resolved: string | null): AgentState {
  return resolved ? "ready" : "missing";
}

/// The one command installing this agent would run.
///
/// Into a prefix this application owns, never the person's own node
/// installation: what WorkRoom fetches, WorkRoom keeps to itself. The prefix is
/// quoted because the app data directory on macOS has a space in it, and an
/// unquoted one reads as another package to install.
export function installCommand(profile: AgentProfile, prefix: string): string {
  return `npm install -g --prefix "${prefix}" ${profile.package}`;
}
