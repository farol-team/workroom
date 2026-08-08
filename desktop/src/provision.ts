// The channel's folder, made ready on its own (#204). A channel that names a
// repository should not wait for somebody to clone it by hand: opening the
// channel is already asking to work there, and the derived folder is where
// that work goes. Everything here is this machine's process — the rows it
// draws sit in the feed indented and muted like the other local rows, and
// none of it is ever said to the room.

import type { Channel } from "./api";
import { boundFolder, type Bindings } from "./rules";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// What the bridge said the channel's folder currently is.
export interface FolderState {
  exists: boolean;
  empty: boolean;
  remote: string | null;
}

export interface ProvisionDeps {
  bindings: () => Bindings;
  /// Where the channel would work. Answered without creating anything, and null
  /// where there is no disk to derive a path on (#299).
  derivedPath: (slug: string) => Promise<string | null>;
  folderState: (dir: string) => Promise<FolderState | null>;
  clone: (url: string, dir: string) => Promise<void>;
  /// Rows are this room's: whether the channel they belong to is still the
  /// one on screen. Checked before every draw, never before the work — a
  // clone is idempotent and local, a row in the wrong room is a lie.
  isOpen: (slug: string) => boolean;
  /// The mismatch warning's way out: the settings dialog is where a folder
  /// choice is made, so that is where the button goes.
  openSettings: () => void;
}

export interface Provision {
  /// The channel just opened. Fire and forget: the room is already on
  /// screen, and the answer arrives when the bridge answers.
  consider(channel: Channel): void;
}

export function createProvision(deps: ProvisionDeps): Provision {
  /// A clone already running for a channel is not started twice — opening
  /// the same room twice would otherwise race two clones into one folder.
  const cloning = new Set<string>();

  /// This channel's row in the feed, found or made. The timeline clears the
  /// feed on every open, so a row from another room is already gone; within
  /// the current one the slug picks the row back out.
  function row(channel: Channel): HTMLElement {
    let el = document.querySelector<HTMLElement>(`.provision[data-channel="${channel.slug}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "offer provision";
      el.dataset.channel = channel.slug;
      $("messages").append(el);
    }
    el.innerHTML = "";
    return el;
  }

  /// One quiet action at the end of a row. Disabled once pressed: the work
  /// redraws the row when it has an answer.
  function action(el: HTMLElement, label: string, work: () => void) {
    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = label;
    button.onclick = () => { button.disabled = true; work(); };
    el.append(document.createTextNode(" "), button);
  }

  function mismatch(channel: Channel) {
    if (!deps.isOpen(channel.slug)) return;
    const el = row(channel);
    el.textContent = "The channel folder holds a different repository.";
    action(el, "Open channel settings", () => deps.openSettings());
  }

  async function run(channel: Channel) {
    const slug = channel.slug;
    const url = channel.repository_url?.trim();
    if (!url) return;
    // A person's choice always wins. A binding is that choice made, and no
    // automation writes over it.
    if (boundFolder(slug, deps.bindings())) return;
    if (cloning.has(slug)) return;

    const dir = await deps.derivedPath(slug);
    // No path to derive means no folder to make ready. Nothing is wrong; there is
    // simply nowhere here for the room's repository to go.
    if (!dir) return;
    // A probe that cannot answer is answered by attempting the clone:
    // agent_clone refuses a non-empty directory itself, so the destructive
    // case is impossible either way, and the common one — the folder simply
    // is not there — is not held up by a broken probe.
    const state = await deps.folderState(dir).catch(() => null);

    if (state?.exists && !state.empty) {
      if (state.remote === url) return;   // already the room's repository
      mismatch(channel);
      return;
    }

    cloning.add(slug);
    if (deps.isOpen(slug)) row(channel).textContent = `Cloning ${url} into ${dir}…`;
    try {
      await deps.clone(url, dir);
      // Kept rather than removed: a row that vanishes reads as "did anything
      // happen?", and one muted line is what the answer costs.
      if (deps.isOpen(slug)) row(channel).textContent = "Repository ready.";
    } catch (err) {
      if (deps.isOpen(slug)) {
        // What failed, then git's own words as the explanation; the button
        // is the same flow run again, not a different one.
        const el = row(channel);
        el.textContent = `Could not clone the channel's repository — ${String(err)}`;
        action(el, "Retry", () => { run(channel).catch(() => {}); });
      }
    } finally {
      cloning.delete(slug);
    }
  }

  return {
    consider(channel) { run(channel).catch(() => {}); },
  };
}
