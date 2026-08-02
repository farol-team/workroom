// The human-changes gate (#207). A channel's folder is shared between the
// agent and the person: work the person writes between turns must not become
// the ground an agent builds on unexamined. So work outside any run pauses
// runs — never messages, which are just talk — until the person says what it
// is: reviewed (Keep), set aside (Stash), or committed through the review
// dialog part B hangs on this module.
//
// Everything here is this machine's: the banner, the feed row, the count on
// the folder button. None of it is said to the room.

import type { Channel } from "./api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// What the bridge said changed outside any run.
export interface HumanChangeSet {
  files: Array<{ path: string; bytes: number }>;
  branch: string | null;
  is_repo: boolean;
}

export interface HumanGateDeps {
  humanChanges: (dir: string) => Promise<HumanChangeSet>;
  stash: (dir: string) => Promise<void>;
  /// Where the open channel works. Asked per check: a binding can change.
  folderFor: (channel: Channel) => Promise<string>;
  /// A run is executing — measuring then would read the run's own work as
  /// the person's.
  runActive: () => boolean;
  isOpen: (slug: string) => boolean;
  /// The review dialog's seam (#207 part B): the change set, and the folder
  /// it is in. Part A wires every Review and Commit button here; the dialog
  /// arrives behind this signature.
  openReview: (changes: HumanChangeSet, folder: string) => void;
  /// The gate's state changed — drawn, resolved or cleared. The folder
  /// button's count lives outside this module's DOM, so it re-reads here.
  onChange?: () => void;
}

export interface HumanGate {
  /// Re-ask whether the folder holds unreviewed work. Fire and forget — from
  /// channel open, window focus, and the end of a turn's offer.
  check(channel: Channel): void;
  gated(): boolean;
  /// How many unreviewed files, for the folder button's count.
  pending(): number;
  /// The composer asks before a message would start a run. Refused means:
  /// the reason is shown and the message stays typed. Plain messages are
  /// never refused — they are talk, not work.
  refuse(addressed: boolean): boolean;
  /// A resolution, from the row's buttons or from the review dialog (#207
  /// part B): both doors end the same cycle and leave the same suffix.
  resolve(how: "kept" | "stashed" | "committed", sha?: string): Promise<void>;
}

/// A change set recognised later: the sorted paths and sizes, hashed small.
/// Keep is the person saying "I have seen exactly this" — anything more or
/// less, even one byte, is a new question.
export function fingerprint(files: Array<{ path: string; bytes: number }>): string {
  const text = files.map((f) => `${f.path}:${f.bytes}`).sort().join("\n");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

export function createHumanGate(deps: HumanGateDeps): HumanGate {
  let gate: { changes: HumanChangeSet; folder: string; fingerprint: string } | null = null;
  /// The set the person accepted with Keep, per folder. Only exactly that
  /// set is accepted; the next byte of new work is a fresh cycle.
  let kept: { folder: string; fingerprint: string } | null = null;
  /// A generation per check, so a slow answer from an older question never
  /// draws over a newer one.
  let checking = 0;

  function clear() {
    if (gate) deps.onChange?.();
    gate = null;
    $("gate").hidden = true;
    document.querySelector(".gate-row")?.remove();
  }

  /// One quiet action at the end of the row. Disabled once pressed: the
  /// resolution redraws when it has an answer.
  function action(el: HTMLElement, label: string, work: () => void) {
    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = label;
    button.onclick = () => { button.disabled = true; work(); };
    el.append(document.createTextNode(" "), button);
  }

  function draw(changes: HumanChangeSet, folder: string) {
    const n = changes.files.length;
    $("gate-summary").textContent = `Runs paused — ${n} unreviewed changes`;
    $("gate").hidden = false;

    const el = document.createElement("div");
    el.className = "offer gate-row";
    el.append(document.createTextNode(`✎ ${n} files changed outside any run `));
    const review = () => deps.openReview(changes, folder);
    action(el, "Review", review);
    // Commit goes through the review too: a commit message is written with
    // the diff in front of the person, which is the dialog part B builds.
    action(el, "Commit", review);
    action(el, "Stash", () => { resolve("stashed").catch(() => {}); });
    action(el, "Keep", () => { resolve("kept").catch(() => {}); });
    $("messages").append(el);
    deps.onChange?.();
  }

  /// What the row says once the person has answered. The row stays: a
  /// resolution is part of what happened here, and a vanishing one reads as
  /// though nothing was ever asked.
  function settle(gateRow: Element | null, text: string) {
    if (gateRow) gateRow.textContent = text;
  }

  async function resolve(how: "kept" | "stashed" | "committed", sha?: string) {
    const g = gate;
    if (!g) return;   // pressed twice: one resolution is not two
    const n = g.changes.files.length;
    const row = document.querySelector(".gate-row");
    if (how === "committed") {
      // The commit itself happened in the dialog; what is left here is the
      // account of it — the sha, because a history entry nobody can find is
      // not one.
      settle(row, `✎ ${n} files changed outside any run — committed as ${sha ?? "?"}`);
    } else if (how === "stashed") {
      try {
        await deps.stash(g.folder);
      } catch (err) {
        // The work is still there, so the gate is too: the buttons come back
        // and the row adds what git said.
        if (row) {
          row.querySelectorAll("button").forEach((b) => (b.disabled = false));
          row.append(document.createTextNode(` ${String(err)}`));
        }
        return;
      }
      settle(row, `✎ ${n} files changed outside any run — stashed, can be brought back: git stash pop`);
    } else {
      kept = { folder: g.folder, fingerprint: g.fingerprint };
      settle(row, `✎ ${n} files changed outside any run — kept`);
    }
    gate = null;
    $("gate").hidden = true;
    deps.onChange?.();
  }

  function check(channel: Channel) {
    const mine = ++checking;
    clear();
    // Skipped outright: measuring mid-run reads the run's own work as the
    // person's, which is the one answer this gate exists to avoid.
    if (deps.runActive()) return;

    (async () => {
      const folder = await deps.folderFor(channel);
      const changes = await deps.humanChanges(folder).catch(() => null);
      if (mine !== checking || !deps.isOpen(channel.slug)) return;
      if (!changes || changes.files.length === 0) return;
      if (!changes.is_repo) {
        // Named, never gated: a folder without a history pauses nothing, but
        // the work in it is still the person's, and the review is where it
        // can gain one (#207 part B).
        const el = document.createElement("div");
        el.className = "offer gate-row";
        el.append(document.createTextNode(`✎ ${changes.files.length} files, no history yet `));
        action(el, "Review", () => deps.openReview(changes, folder));
        $("messages").append(el);
        return;
      }

      const fp = fingerprint(changes.files);
      if (kept && kept.folder === folder && kept.fingerprint === fp) return;

      gate = { changes, folder, fingerprint: fp };
      draw(changes, folder);
    })().catch(() => {});
  }

  // The banner's two buttons are the same acts as the row's, wired once:
  // Review opens the part-B dialog on the gated set, Keep accepts it.
  $("gate-review").addEventListener("click", () => {
    if (gate) deps.openReview(gate.changes, gate.folder);
  });
  $("gate-keep").addEventListener("click", () => { resolve("kept").catch(() => {}); });

  return {
    check,
    resolve,
    gated: () => gate !== null,
    pending: () => gate?.changes.files.length ?? 0,
    refuse(addressed) {
      if (!addressed || !gate) return false;
      $("gate-refused").textContent =
        "Runs are paused while there are unreviewed changes — Review or Keep first. Your message is still here.";
      return true;
    },
  };
}
