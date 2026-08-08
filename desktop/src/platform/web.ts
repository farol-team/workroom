// The shell, as a browser can provide it.
//
// Everything the room is made of — channels, the timeline, memory, artifacts,
// people, settings — lives on the server and needs nothing from here. What needs
// a machine is named below, and where a browser has no answer this says so rather
// than returning a quiet nothing: a folder picker that answers null without
// explaining is indistinguishable from a person who pressed cancel, and the window
// would carry on as though a folder had been chosen.

import type { AgentDef } from "../rules";
import type { AgentRuntime } from "../agent-runtime";
import type { Platform } from "../platform";
import { NoAgents } from "./web-agents";
import { folder } from "./web-folder";
import type { WorkingFolder } from "../working-folder";

const BROWSER = "this runs in a browser, which has no access to the machine";

export const platform: Platform = {
  kind: "web",

  async openLink(url: string) {
    window.open(url, "_blank", "noopener");
  },

  // The page is the version: whatever was served is what is running.
  async version() {
    return "web";
  },

  // Both are questions about this machine, and the honest answer is that there is
  // no such thing here — not an error, because nothing is broken.
  async dataDir(_sub?: string) { return null; },
  async chooseFolder(_title: string) { return null; },

  // A reload is the update. There is nothing to check for and nothing to install.
  async update() { return null; },

  async writeMirror(_dir: string, _files: Array<{ path: string; body: string }>): Promise<void> {
    throw new Error(`the workspace mirror is written to disk, and ${BROWSER}`);
  },

  // Not through the shell — there is no shell. Null rather than a rejection,
  // because a browser signs in by being redirected and coming back, which is the
  // normal path here and not a fallback from a failure.
  async signIn(_server: string) { return null; },

  folder: (): WorkingFolder => folder,

  agents(_defs: AgentDef[]): AgentRuntime {
    return new NoAgents();
  },
};
