// Where the room's work lives (#203). Two facts side by side in one dialog,
// because the second only means anything next to the first: the repository is
// a fact of the *room* — the server holds it, journals the change, and tells
// everybody — while where *this machine* works on it is a choice of this
// machine, kept in the local binding the way it always was. One person keeps
// the repository in ~/src and a colleague in ~/work; a filesystem layout is
// not something the workspace should learn.

import type { Channel } from "./api";
import { boundFolder, type Bindings } from "./rules";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// What the bridge could say about a folder that is a repository.
export interface RepoInfo {
  remote: string | null;
  default_branch: string | null;
  deploys_on_push: boolean;
}

/// What the dialog draws but does not decide. The room's setting crosses the
/// API; the machine's choice stays in localStorage; and everything that
/// touches a disk crosses the bridge — which is why all three are seams a
/// test can stand behind.
export interface ChannelSettingsDeps {
  currentChannel: () => Channel | null;
  workspaceSlug: () => string | null;
  updateChannel: (slug: string, repositoryUrl: string | null) => Promise<Channel>;
  bindings: () => Bindings;
  bind: (slug: string, folder: string | null) => void;
  chooseFolder: (title: string) => Promise<string | null>;
  /// The derived folder, made real. The bridge owns where it is; the client
  /// only displays the pattern.
  derivedFolder: () => Promise<string>;
  clone: (url: string, dir: string) => Promise<void>;
  repoInfo: (path: string) => Promise<RepoInfo>;
  /// The agent's session was opened against the old directory and cannot
  /// follow the folder to a new one.
  releaseChannel: (slug: string) => Promise<void>;
  /// The room on screen learned its new description — header, folder button.
  applied: (channel: Channel) => void;
  copyText: (text: string) => Promise<void>;
}

export interface ChannelSettings {
  open(): void;
  /// The room said its setting changed while the dialog might be open.
  refresh(channel: Channel): void;
}

type Where = "derived" | "clone" | "existing";

/// What protecting the branch means, as a checklist to paste wherever the
/// team keeps its runbooks. Advice, not enforcement: the permission to push
/// is git's and the provider's, not this application's to grant or refuse.
export function setupSteps(branch: string): string {
  return [
    `Branch protection for ${branch}:`,
    `1. Protect the default branch (${branch}) — refuse direct pushes to it.`,
    "2. Require a pull request for every change.",
    "3. Require at least one approving review before a merge lands.",
  ].join("\n");
}

/// A path shortened for display, the way the header's folder button does it.
const shorten = (folder: string) => folder.replace(/^.*\/(?=[^/]+\/?[^/]*$)/, "…/");

export function createChannelSettings(deps: ChannelSettingsDeps): ChannelSettings {
  /// The channel the dialog was opened for — radio and save handlers are
  /// wired once, so the room they act on is read from here.
  let openedFor = "";
  let where: Where = "derived";
  let existingPath: string | null = null;

  const radios = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[name="cs-where"]'));

  const error = (message: string) => { $("cs-error").textContent = message; };

  /// A repository that ships on merge is ordinary, and the person needs the
  /// checklist rather than an alarm — so this is a bordered block in the
  /// dialog, not a modal of its own.
  function warnAbout(info: RepoInfo) {
    const branch = info.default_branch ?? "the default branch";
    $("cs-warning-text").textContent =
      `This repository deploys on merge to ${branch}. The agent will be able to commit and push here.`;
    $("cs-warning").hidden = false;
    $<HTMLButtonElement>("cs-copy-steps").onclick = () => {
      const button = $<HTMLButtonElement>("cs-copy-steps");
      deps.copyText(setupSteps(info.default_branch ?? "main")).then(
        () => { button.textContent = "Copied"; },
        () => { button.textContent = "Copy setup steps"; },
      );
    };
  }

  /// Ask the bridge what a folder is, and warn if merging there ships
  /// something. A folder the bridge cannot read is a folder with nothing to
  /// warn about — the warning is advice, and silence is its failure mode.
  async function considerWarning(path: string) {
    const info = await deps.repoInfo(path).catch(() => null);
    if (info?.deploys_on_push) warnAbout(info);
    else $("cs-warning").hidden = true;
  }

  function open() {
    const channel = deps.currentChannel();
    if (!channel) return;
    openedFor = channel.slug;

    $<HTMLInputElement>("cs-name").value = `#${channel.slug}`;
    $<HTMLInputElement>("cs-repository").value = channel.repository_url ?? "";
    // Hidden while there is nothing to clone, not disabled: a control that
    // cannot be used is a promise the dialog cannot keep.
    $("cs-clone-row").hidden = !channel.repository_url;

    const bound = boundFolder(channel.slug, deps.bindings());
    existingPath = bound;
    where = bound ? "existing" : "derived";
    for (const radio of radios()) radio.checked = radio.value === where;
    $("cs-existing-path").textContent = bound ? shorten(bound) : "";

    // The bridge derives the real path and sanitizes each segment; both slugs
    // arrive from the server already safe, so this is the path, not a pattern.
    const workspace = deps.workspaceSlug() ?? "workspace";
    $("cs-derived-path").textContent = `~/WorkRoom/${workspace}/${channel.slug}`;

    $("cs-warning").hidden = true;
    error("");
    $<HTMLButtonElement>("cs-save").hidden = false;
    $<HTMLButtonElement>("cs-cancel").hidden = false;
    $<HTMLButtonElement>("cs-done").hidden = true;

    $<HTMLDialogElement>("channel-settings").showModal();
  }

  function refresh(channel: Channel) {
    const dialog = $<HTMLDialogElement>("channel-settings");
    if (!dialog.open || channel.slug !== openedFor) return;
    // What the room saved wins — a colleague named the repository while this
    // dialog was open, and a half-typed address here was never the room's.
    $<HTMLInputElement>("cs-repository").value = channel.repository_url ?? "";
    $("cs-clone-row").hidden = !channel.repository_url;
  }

  /// Picking the existing-folder choice is picking the folder — the dialog
  /// asks for it immediately, the way the header button used to. Declining
  /// the picker declines the choice with it.
  for (const radio of radios()) {
    radio.onchange = async () => {
      where = radio.value as Where;
      if (where !== "existing") return;

      const chosen = await deps.chooseFolder(`Where #${openedFor} works`);
      if (!chosen) {
        where = boundFolder(openedFor, deps.bindings()) ? "existing" : "derived";
        for (const other of radios()) other.checked = other.value === where;
        return;
      }
      existingPath = chosen;
      $("cs-existing-path").textContent = shorten(chosen);
      await considerWarning(chosen);
    };
  }

  function close() { $<HTMLDialogElement>("channel-settings").close(); }

  function finish(updated: Channel) {
    deps.applied(updated);
    close();
  }

  async function save() {
    const channel = deps.currentChannel();
    if (!channel || channel.slug !== openedFor) return;
    const saveButton = $<HTMLButtonElement>("cs-save");
    saveButton.disabled = true;
    error("");
    try {
      const url = $<HTMLInputElement>("cs-repository").value.trim() || null;
      // A save that changes nothing is not a write: the server journals every
      // change it gets, and a PATCH that says nothing would still be said in
      // the room's record (#203).
      let updated = channel;
      if (url !== (channel.repository_url ?? null)) {
        updated = await deps.updateChannel(channel.slug, url);
      }

      const bound = boundFolder(channel.slug, deps.bindings());
      if (where === "existing" && existingPath) {
        if (existingPath !== bound) {
          deps.bind(channel.slug, existingPath);
          await deps.releaseChannel(channel.slug);
        }
        finish(updated);
        return;
      }

      if (where === "clone") {
        const into = await deps.derivedFolder();
        await deps.clone(url ?? "", into);
        // The derived folder is the default once nothing is bound — the clone
        // landed exactly where an unbound channel already works.
        if (bound) deps.bind(channel.slug, null);
        await deps.releaseChannel(channel.slug);
        const info = await deps.repoInfo(into).catch(() => null);
        if (info?.deploys_on_push) {
          // The work is done, but the warning is the point of the dialog —
          // so the dialog stays, and what is left to press is Done.
          deps.applied(updated);
          warnAbout(info);
          saveButton.hidden = true;
          $<HTMLButtonElement>("cs-cancel").hidden = true;
          $<HTMLButtonElement>("cs-done").hidden = false;
          return;
        }
        finish(updated);
        return;
      }

      // Derived: hand the folder back to the derivation.
      if (bound) {
        deps.bind(channel.slug, null);
        await deps.releaseChannel(channel.slug);
      }
      finish(updated);
    } catch (err) {
      // Inline, not alert(): the dialog is where the mistake was made, and
      // git's own words are the explanation.
      error(String(err));
    } finally {
      saveButton.disabled = false;
    }
  }

  $<HTMLButtonElement>("cs-save").addEventListener("click", () => { save().catch(() => {}); });

  return { open, refresh };
}
