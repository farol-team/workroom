// The channel's folder on this machine.
//
// Nine bridge commands, one thing: a clone of the room's repository, its git state,
// and what the person changed in it by hand. They travel together because they are
// about the same object, and a flat interface of twenty-six methods named after
// bridge commands would be a rename of `invoke` rather than a seam.
//
// Two kinds of member, and the difference matters more than it looks. **Asking**
// about a folder — does it exist, what is in it, what changed — is answered with
// null where there is no folder, because the window asks these while drawing, before
// anybody has chosen anything, and a rejection there is an error dialog for a
// question nobody asked. **Acting** on a folder rejects, because a clone that
// silently did not happen is worse than one that failed loudly.

import type { RepoInfo } from "./channel-settings";
import type { FolderState } from "./provision";
import type { HumanChangeSet } from "./human-changes";

export interface WorkingFolder {
  /// Where this channel's folder would be if nobody chose one — derived from the
  /// workspace and the channel, not stored. Null where there is no disk to derive a
  /// path on.
  derivedPath(workspace: string, channel: string): Promise<string | null>;

  /// What repository this folder is a clone of, and whether it is clean. Null when
  /// the path is not a repository, and null in a browser, which is the same answer
  /// for the same reason: there is nothing there.
  repoInfo(path: string): Promise<RepoInfo | null>;

  /// Whether the folder exists, is empty, or already holds a clone — the question
  /// #204 asks before making one.
  folderState(dir: string): Promise<FolderState | null>;

  /// What the person changed outside any run (#207). Null where nothing could have
  /// been changed, which the gate reads as "nothing to review".
  humanChanges(dir: string): Promise<HumanChangeSet | null>;

  /// One file's diff, as text.
  fileDiff(dir: string, path: string): Promise<string>;

  clone(url: string, dir: string): Promise<void>;
  gitInit(dir: string): Promise<void>;

  /// Returns the sha, which is what the review dialog shows afterwards.
  commit(dir: string, paths: string[], message: string): Promise<string>;

  /// Put the person's unreviewed work aside so a run may proceed (#207).
  stash(dir: string): Promise<void>;
}
