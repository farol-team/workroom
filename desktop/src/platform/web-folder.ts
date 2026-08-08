// The channel's folder, in a browser: there is not one.
//
// Not a stub that pretends. Asking answers null — the same answer the desktop gives
// for a path that is not a repository, so the window's existing "nothing bound yet"
// paths carry the browser without knowing it. Acting rejects and says why, because
// a clone that silently did not happen is a folder the person will look for later.

import type { WorkingFolder } from "../working-folder";

const BROWSER = "this runs in a browser, which has no folder on this machine";

const none = async () => null;
const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} needs a folder on disk, and ${BROWSER}`);
};

export const folder: WorkingFolder = {
  derivedPath: none,
  repoInfo: none,
  folderState: none,
  humanChanges: none,

  fileDiff: refuse("reading a diff"),
  clone: refuse("cloning a repository"),
  gitInit: refuse("starting a repository"),
  commit: refuse("committing"),
  stash: refuse("setting work aside"),
};
