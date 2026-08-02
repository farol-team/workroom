// The review dialog (#207 part B): what the person changed outside any run,
// shown file by file, with the ways out at the bottom. Everything here is
// local — the diffs come from the bridge, the summary from this machine's
// agent, and the resolutions are the gate's own. Nothing is said to the
// room: reviewing is the person's reckoning with their own work, and a
// channel that heard it would be watching over a shoulder.

import type { HumanChangeSet } from "./human-changes";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// The local agent's answer to a local question.
export type LocalAsk = (question: string, context: string) => Promise<string>;

export interface ReviewDialogDeps {
  fileDiff: (dir: string, path: string) => Promise<string>;
  commit: (dir: string, paths: string[], message: string) => Promise<string>;
  gitInit: (dir: string) => Promise<void>;
  humanChanges: (dir: string) => Promise<HumanChangeSet>;
  /// Whose name pre-fills the commit message — the commit's author is the
  /// machine's git identity; the message says whose hands did the work.
  personName: () => string;
  /// The local agent answering a local question, asked for *lazily*: who
  /// can answer changes with every run, so the answer is taken at open time
  /// and at click time, never at wiring time. Null while a run is active or
  /// no agent is running — Summarize is disabled then, not broken.
  askAgent: () => LocalAsk | null;
  /// The gate's own resolution path: a resolution chosen here is the feed
  /// row's resolution too, with the same suffix and the same lifted gate.
  resolve: (how: "kept" | "stashed" | "committed", sha?: string) => Promise<void>;
  /// The gate re-reads the folder — after init, what was plain is a
  /// repository and the gate can finally see it.
  recheck: () => void;
}

export interface ReviewDialog {
  open(changes: HumanChangeSet, folder: string): void;
}

/// How much of one file's diff the summary question carries. Enough to say
/// what changed; the dialog is for reading, the summary for orienting.
const DIFF_FOR_SUMMARY_CHARS = 4000;

export function createReviewDialog(deps: ReviewDialogDeps): ReviewDialog {
  let current: { changes: HumanChangeSet; folder: string } | null = null;

  const error = (message: string) => { $("rc-error").textContent = message; };
  const dialog = () => $<HTMLDialogElement>("review-changes");

  /// A file's changes, expanded in place. Second click puts them away —
  /// the list is the map, and a diff that cannot collapse redraws it.
  async function toggleDiff(row: HTMLElement, folder: string, path: string) {
    const open = row.querySelector(".rc-diff");
    if (open) { open.remove(); return; }
    const pre = document.createElement("pre");
    pre.className = "rc-diff";
    pre.textContent = "…";
    row.append(pre);
    try {
      pre.textContent = await deps.fileDiff(folder, path);
    } catch (err) {
      pre.textContent = String(err);
    }
  }

  function renderFiles(changes: HumanChangeSet, folder: string) {
    const box = $("rc-files");
    box.innerHTML = "";
    for (const f of changes.files) {
      const row = document.createElement("div");
      row.className = "rc-file";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "rc-file-head";
      const kb = f.bytes < 1024 ? `${f.bytes} B` : `${Math.ceil(f.bytes / 1024)} kB`;
      head.textContent = `${f.path} · ${kb}`;
      head.onclick = () => { toggleDiff(row, folder, f.path).catch(() => {}); };
      row.append(head);
      box.append(row);
    }
  }

  /// Which of the menu's buttons the current folder earns. Pre-init there
  /// is one act that means anything; the rest arrive with the history.
  function showRepoActions(repo: boolean) {
    for (const id of [ "rc-summarize", "rc-stash", "rc-keep", "rc-commit" ]) {
      $(id).hidden = !repo;
    }
  }

  function open(changes: HumanChangeSet, folder: string) {
    current = { changes, folder };
    error("");
    $("rc-summary").hidden = true;
    $("rc-commit-row").hidden = true;
    $("rc-confirm").hidden = true;
    $("rc-commit").hidden = false;

    const summarize = $<HTMLButtonElement>("rc-summarize");
    const asker = deps.askAgent();
    summarize.disabled = !asker;
    // Disabled gets a reason in the tooltip: an agent that is not running
    // cannot summarize, and one mid-run should not be asked a second question.
    summarize.title = asker ? "" : "Available while your agent is running and idle";

    if (!changes.is_repo) {
      $("rc-context").textContent = "";
      $("rc-files").innerHTML = "";
      $("rc-norepo").hidden = false;
      showRepoActions(false);
    } else {
      $("rc-norepo").hidden = true;
      showRepoActions(true);
      $("rc-context").textContent =
        `${changes.files.length} files changed outside any run · on ${changes.branch ?? "HEAD"}`;
      renderFiles(changes, folder);
    }

    dialog().showModal();
  }

  async function finishWith(how: "kept" | "stashed") {
    await deps.resolve(how);
    dialog().close();
  }

  $("rc-stash").addEventListener("click", () => { finishWith("stashed").catch(() => {}); });
  $("rc-keep").addEventListener("click", () => { finishWith("kept").catch(() => {}); });

  // Commit… reveals the message rather than committing: a commit message is
  // written with the diff in view, not defaulted past the person.
  $("rc-commit").addEventListener("click", () => {
    const input = $<HTMLInputElement>("rc-message");
    input.value = `Manual edits by ${deps.personName()}`;
    $("rc-commit-row").hidden = false;
    $("rc-confirm").hidden = false;
    $("rc-commit").hidden = true;
    input.focus();
  });

  $("rc-confirm").addEventListener("click", () => {
    if (!current) return;
    const { folder, changes } = current;
    const confirm = $<HTMLButtonElement>("rc-confirm");
    confirm.disabled = true;
    error("");
    (async () => {
      const message = $<HTMLInputElement>("rc-message").value.trim()
        || `Manual edits by ${deps.personName()}`;
      const sha = await deps.commit(folder, changes.files.map((f) => f.path), message);
      await deps.resolve("committed", sha);
      dialog().close();
    })().catch((err) => {
      // git's own words — a missing identity is the common one, and the fix
      // is the person's git config, said by git better than by us.
      error(String(err));
    }).finally(() => { confirm.disabled = false; });
  });

  // A local question, not a channel message: no run is started, nothing is
  // posted, and the room never learns the question was asked. The summary
  // orients the person in their own unreviewed work; it is not a turn, and
  // charging the room for it would be both slower and a lie about who asked.
  $("rc-summarize").addEventListener("click", () => {
    const ask = deps.askAgent();
    if (!ask || !current) return;
    const { folder, changes } = current;
    const button = $<HTMLButtonElement>("rc-summarize");
    button.disabled = true;
    button.textContent = "Summarizing…";
    (async () => {
      const material: string[] = [];
      for (const f of changes.files) {
        const diff = await deps.fileDiff(folder, f.path).catch(() => "");
        material.push(`--- ${f.path}\n${diff.slice(0, DIFF_FOR_SUMMARY_CHARS)}`);
      }
      const answer = await ask(
        "Summarize these unreviewed changes in two sentences for the person who wrote them.",
        material.join("\n\n"));
      const summary = $("rc-summary");
      summary.textContent = answer;
      summary.hidden = false;
    })().catch((err) => error(String(err)))
      .finally(() => {
        button.disabled = false;
        button.textContent = "Summarize";
      });
  });

  // The upgrade path: a plain folder gains a history, locally and with no
  // remote, and then the dialog re-reads it as what it now is.
  $("rc-init").addEventListener("click", () => {
    if (!current) return;
    const { folder } = current;
    const button = $<HTMLButtonElement>("rc-init");
    button.disabled = true;
    (async () => {
      await deps.gitInit(folder);
      const fresh = await deps.humanChanges(folder);
      deps.recheck();
      open(fresh, folder);
    })().catch((err) => error(String(err)))
      .finally(() => { button.disabled = false; });
  });

  return { open };
}
