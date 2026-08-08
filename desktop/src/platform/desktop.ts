// The shell, as the native window provides it.
//
// Everything here was in `main.ts` and is moved rather than rewritten: this file
// is where `@tauri-apps` is allowed to appear, so that the web build can be checked
// for its absence everywhere else.

import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { Agents } from "../agent";
import type { AgentDef } from "../rules";
import type { AgentRuntime } from "../agent-runtime";
import type { Platform } from "../platform";

export const platform: Platform = {
  kind: "desktop",

  openLink: (url: string) => openUrl(url),

  version: () => getVersion(),

  async dataDir(sub?: string) {
    const root = await appDataDir();
    return sub ? join(root, sub) : root;
  },

  chooseFolder: (title: string) =>
    pickFolder({ directory: true, title }) as Promise<string | null>,

  writeMirror: (dir: string, files: Array<{ path: string; body: string }>) =>
    invoke<void>("workspace_write_mirror", { dir, files }),

  // Told, never done for them: an agent workspace that replaces its own binary
  // without being asked is a thing people are right to distrust. So this reports
  // what is available and installs only when something calls `install`.
  async update() {
    const found = await check().catch(() => null);
    if (!found?.available) return null;

    return {
      version: found.version,
      install: async () => {
        await found.downloadAndInstall();
        await relaunch();
      },
    };
  },

  agents: (defs: AgentDef[]): AgentRuntime => new Agents(defs),
};
