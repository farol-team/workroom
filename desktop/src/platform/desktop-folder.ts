// The channel's folder, as the native shell reaches it.
//
// Nine `invoke` calls, moved out of `main.ts` rather than rewritten — the shape of
// each argument object is what the Rust side already expects, and a card that
// changed both ends at once would have nothing to compare against.

import { invoke } from "@tauri-apps/api/core";

import type { RepoInfo } from "../channel-settings";
import type { FolderState } from "../provision";
import type { HumanChangeSet } from "../human-changes";
import type { WorkingFolder } from "../working-folder";

// Asking about a folder answers null rather than throwing, on both sides of the
// seam. A path that is not a repository is not an error here either — it is how the
// window learns there is nothing to bind yet.
const asking = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const folder: WorkingFolder = {
  derivedPath: (workspace: string, channel: string) =>
    asking(invoke<string>("agent_derived_path", { workspace, channel })),

  repoInfo: (path: string) => asking(invoke<RepoInfo>("agent_repo_info", { path })),

  folderState: (dir: string) => asking(invoke<FolderState>("agent_folder_state", { dir })),

  humanChanges: (dir: string) => asking(invoke<HumanChangeSet>("agent_human_changes", { dir })),

  fileDiff: (dir: string, path: string) => invoke<string>("agent_file_diff", { dir, path }),

  clone: (url: string, dir: string) => invoke<void>("agent_clone", { url, dir }),

  gitInit: (dir: string) => invoke<void>("agent_git_init", { dir }),

  commit: (dir: string, paths: string[], message: string) =>
    invoke<string>("agent_commit", { dir, paths, message }),

  stash: (dir: string) => invoke<void>("agent_stash", { dir }),
};
