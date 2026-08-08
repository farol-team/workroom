// What the window asks of the shell around it.
//
// Of the twenty modules in `src/`, two knew there was a shell at all. Naming what
// they asked for is what lets the same source build for a native window and for a
// browser: the rest of the room needs nothing from either.
//
// The implementation is chosen by the build, not at runtime — `./platform/impl` is
// an alias Vite resolves to `desktop.ts` or `web.ts`. A runtime branch would put
// both in the bundle, and the whole point of the web build is that one of them is
// not in it.

import type { AgentDef } from "./rules";
import type { AgentRuntime } from "./agent-runtime";

export interface Platform {
  readonly kind: "desktop" | "web";

  /// Somewhere outside the window. A tab in a browser; the person's own browser
  /// from a native window.
  openLink(url: string): Promise<void>;

  /// What is running, for the about line and for a bug report.
  version(): Promise<string>;

  /// Where this application keeps its own files, optionally a named place inside
  /// it — joined here because a separator is the shell's business. Null where
  /// there is no such directory.
  dataDir(sub?: string): Promise<string | null>;

  /// A folder the person chose, null if they chose none — and null, too, where
  /// there is no picker to open.
  chooseFolder(title: string): Promise<string | null>;

  /// The room's files, written where the agent will look for them. Rejects where
  /// there is no disk to write to.
  writeMirror(dir: string, files: Array<{ path: string; body: string }>): Promise<void>;

  /// An update ready to install, or null when there is none — including where
  /// updating is not a thing this build does. Installing it restarts the
  /// application, because half an update is not one.
  update(): Promise<{ version: string; install(): Promise<void> } | null>;

  /// Whatever runs this person's agents. Never null: a window with no agent is a
  /// state the room already draws, and null would be the same check at every call
  /// site instead.
  agents(defs: AgentDef[]): AgentRuntime;
}

export { platform } from "./platform/impl";
