import { beforeEach, describe, expect, test, vi } from "vitest";
import { createReviewDialog, type ReviewDialogDeps } from "../src/review-changes";
import { createHumanGate, type HumanChangeSet, type HumanGateDeps } from "../src/human-changes";
import type { Channel } from "../src/api";

// The gate's and the dialog's markup, together: the resolutions cross
// between them, so they are tested together. Kept in step with index.html
// by hand, the way the other specs keep theirs.
const MARKUP = `
  <section id="messages"></section>
  <div id="gate" hidden>
    <span id="gate-summary"></span>
    <button type="button" id="gate-review" class="ghost">Review</button>
    <button type="button" id="gate-keep" class="ghost">Keep</button>
  </div>
  <div id="gate-refused" class="muted"></div>
  <dialog id="review-changes">
    <form method="dialog">
      <h3>Review changes</h3>
      <p id="rc-context" class="muted"></p>
      <div id="rc-summary" class="muted" hidden></div>
      <div id="rc-files"></div>
      <div id="rc-norepo" hidden>
        <p class="muted">This folder has no history.</p>
        <button type="button" id="rc-init" class="ghost">Make it a git repo</button>
      </div>
      <p id="rc-error" class="muted"></p>
      <div id="rc-commit-row" hidden>
        <label>Message <input id="rc-message" autocomplete="off" /></label>
      </div>
      <menu>
        <button value="cancel" formnovalidate>Cancel</button>
        <button type="button" id="rc-summarize" class="ghost">Summarize</button>
        <button type="button" id="rc-stash" class="ghost">Stash</button>
        <button type="button" id="rc-keep" class="ghost">Keep</button>
        <button type="button" id="rc-commit" class="ghost">Commit…</button>
        <button type="button" id="rc-confirm" hidden>Confirm</button>
      </menu>
    </form>
  </dialog>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DIR = "/home/alice/WorkRoom/farol/meetings";

function room(): Channel {
  return {
    id: 1, slug: "meetings", name: "Meetings", purpose: null, visibility: "open",
    memory_uri: "viking://resources/channels/meetings/", message_count: 0,
  };
}

function changes(over: Partial<HumanChangeSet> = {}): HumanChangeSet {
  return {
    files: [ { path: "notes.md", bytes: 128 }, { path: "src/main.rs", bytes: 2048 } ],
    branch: "main",
    is_repo: true,
    ...over,
  };
}

function gateDeps(over: Partial<HumanGateDeps> = {}): HumanGateDeps {
  return {
    humanChanges: vi.fn(async () => changes()),
    stash: vi.fn(async () => {}),
    folderFor: vi.fn(async () => DIR),
    runActive: () => false,
    isOpen: () => true,
    openReview: vi.fn(),
    ...over,
  };
}

/// The local agent's answer, held so the spec can ask what it was asked.
const ask = vi.fn(async () => "Two sentences about the changes.");

function reviewDeps(over: Partial<ReviewDialogDeps> = {}): ReviewDialogDeps {
  return {
    fileDiff: vi.fn(async () => "diff --git a/notes.md b/notes.md\n+added line"),
    commit: vi.fn(async () => "abc1234"),
    gitInit: vi.fn(async () => {}),
    humanChanges: vi.fn(async () => changes()),
    personName: () => "Alice",
    askAgent: () => ask,
    resolve: vi.fn(async () => {}),
    recheck: vi.fn(),
    ...over,
  };
}

const dialog = () => $<HTMLDialogElement>("review-changes");
const fileHeads = () => [ ...document.querySelectorAll<HTMLButtonElement>(".rc-file-head") ];

beforeEach(() => { document.body.innerHTML = MARKUP; });

describe("the review dialog (#207 part B)", () => {
  test("one row per file, with the room's context said above them", () => {
    const review = createReviewDialog(reviewDeps());
    review.open(changes(), DIR);

    expect($("rc-context").textContent).toBe("2 files changed outside any run · on main");
    expect(fileHeads().map((h) => h.textContent)).toEqual([
      "notes.md · 128 B", "src/main.rs · 2 kB",
    ]);
    expect(dialog().open).toBe(true);
  });

  test("a row expands its diff from the bridge, and collapses on a second click", async () => {
    const d = reviewDeps();
    createReviewDialog(d).open(changes(), DIR);

    fileHeads()[0].click();
    await vi.waitFor(() =>
      expect(document.querySelector(".rc-diff")?.textContent).toContain("+added line"));
    expect(d.fileDiff).toHaveBeenCalledWith(DIR, "notes.md");

    fileHeads()[0].click();
    expect(document.querySelector(".rc-diff")).toBeNull();
  });

  test("Commit pre-fills whose hands, and Confirm lands exactly the gated paths", async () => {
    const gate = createHumanGate(gateDeps());
    const d = reviewDeps({ resolve: (how, sha) => gate.resolve(how, sha) });
    const review = createReviewDialog(d);

    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));
    review.open(changes(), DIR);

    $<HTMLButtonElement>("rc-commit").click();
    expect($<HTMLInputElement>("rc-message").value).toBe("Manual edits by Alice");

    $<HTMLInputElement>("rc-message").value = "Manual edits by Alice, reviewed";
    $<HTMLButtonElement>("rc-confirm").click();
    await vi.waitFor(() => expect(dialog().open).toBe(false));

    expect(d.commit).toHaveBeenCalledWith(
      DIR, [ "notes.md", "src/main.rs" ], "Manual edits by Alice, reviewed");
    expect(document.querySelector(".gate-row")!.textContent).toContain("— committed as abc1234");
    expect(gate.gated()).toBe(false);
  });

  test("a commit git refused is said inline, and the dialog stays", async () => {
    const d = reviewDeps({
      commit: vi.fn(async () => { throw new Error("Author identity unknown"); }),
    });
    createReviewDialog(d).open(changes(), DIR);

    $<HTMLButtonElement>("rc-commit").click();
    $<HTMLButtonElement>("rc-confirm").click();
    await vi.waitFor(() =>
      expect($("rc-error").textContent).toContain("Author identity unknown"));

    expect(dialog().open).toBe(true);
  });

  test("Stash and Keep in the dialog are the gate's own resolutions", async () => {
    const gate = createHumanGate(gateDeps());
    const d = reviewDeps({ resolve: (how, sha) => gate.resolve(how, sha) });
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));
    createReviewDialog(d).open(changes(), DIR);

    $<HTMLButtonElement>("rc-stash").click();
    await vi.waitFor(() => expect(dialog().open).toBe(false));
    expect(document.querySelector(".gate-row")!.textContent).toContain("git stash pop");
  });

  test("Cancel leaves the gate exactly as it was", async () => {
    const gate = createHumanGate(gateDeps());
    const review = createReviewDialog(reviewDeps({ resolve: (how, sha) => gate.resolve(how, sha) }));
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));
    review.open(changes(), DIR);

    dialog().close();

    expect(gate.gated()).toBe(true);
    expect(gate.refuse(true)).toBe(true);
  });

  test("a folder without history is offered one, and init re-reads it", async () => {
    const d = reviewDeps();
    createReviewDialog(d).open(changes({ is_repo: false, branch: null }), DIR);

    expect($("rc-norepo").hidden).toBe(false);
    expect($("rc-files").innerHTML).toBe("");
    expect($<HTMLButtonElement>("rc-commit").hidden).toBe(true);

    $<HTMLButtonElement>("rc-init").click();
    await vi.waitFor(() => expect(d.recheck).toHaveBeenCalled());

    expect(d.gitInit).toHaveBeenCalledWith(DIR);
    expect(d.humanChanges).toHaveBeenCalledWith(DIR);
  });

  test("Summarize asks the local agent and shows the answer in the dialog", async () => {
    const d = reviewDeps();
    createReviewDialog(d).open(changes(), DIR);

    $<HTMLButtonElement>("rc-summarize").click();
    await vi.waitFor(() => expect($("rc-summary").hidden).toBe(false));

    expect($("rc-summary").textContent).toBe("Two sentences about the changes.");
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("two sentences"), expect.stringContaining("+added line"));
  });

  test("without an agent to ask, Summarize is disabled with the reason named", () => {
    createReviewDialog(reviewDeps({ askAgent: () => null })).open(changes(), DIR);

    const button = $<HTMLButtonElement>("rc-summarize");
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("agent");
  });
});
