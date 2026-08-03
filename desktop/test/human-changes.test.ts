import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHumanGate, fingerprint, type HumanChangeSet, type HumanGateDeps } from "../src/human-changes";
import type { Channel } from "../src/api";

// The fragments of index.html the gate draws into: the feed, the banner above
// the composer, and the muted line a refused run gets. Kept in step with the
// real markup by hand, the way the other module specs keep theirs.
const MARKUP = `
  <section id="messages"></section>
  <div id="gate" hidden>
    <span id="gate-summary"></span>
    <button type="button" id="gate-review" class="ghost">Review</button>
    <button type="button" id="gate-keep" class="ghost">Keep</button>
  </div>
  <div id="gate-refused" class="muted"></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DIR = "/home/alice/WorkRoom/farol/meetings";

function room(over: Partial<Channel> = {}): Channel {
  return {
    id: 1, slug: "meetings", name: "Meetings", purpose: null, visibility: "open",
    memory_uri: "viking://resources/channels/meetings/", message_count: 0,
    ...over,
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

function deps(over: Partial<HumanGateDeps> = {}): HumanGateDeps {
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

const row = () => document.querySelector<HTMLElement>(".gate-row");
const bannerShown = () => !$("gate").hidden;
const rowButtons = () =>
  [ ...document.querySelectorAll<HTMLButtonElement>(".gate-row button") ].map((b) => b.textContent);

beforeEach(() => { document.body.innerHTML = MARKUP; });

describe("the human-changes gate (#207)", () => {
  test("work outside the line pauses runs, in the banner and in the feed", async () => {
    const gate = createHumanGate(deps());
    gate.check(room());

    await vi.waitFor(() => expect(bannerShown()).toBe(true));

    expect($("gate-summary").textContent).toBe("Runs paused — 2 unreviewed changes");
    expect(row()!.textContent).toContain("✎ 2 files changed outside any run");
    expect(rowButtons()).toEqual([ "Review", "Commit", "Stash", "Keep" ]);
    expect(gate.gated()).toBe(true);
    expect(gate.pending()).toBe(2);
  });

  test("checking while a run executes measures nothing — the run's own work is not the person's", async () => {
    const d = deps({ runActive: () => true });
    const gate = createHumanGate(d);
    gate.check(room());
    await new Promise((r) => setTimeout(r, 10));

    expect(d.humanChanges).not.toHaveBeenCalled();
    expect(gate.gated()).toBe(false);
  });

  test("a folder that is not a repository is not gated", async () => {
    const d = deps({ humanChanges: vi.fn(async () => changes({ is_repo: false, files: [] })) });
    const gate = createHumanGate(d);
    gate.check(room());

    await vi.waitFor(() => expect(d.humanChanges).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));

    expect(gate.gated()).toBe(false);
    expect(bannerShown()).toBe(false);
  });

  test("a clean tree is not gated", async () => {
    const d = deps({ humanChanges: vi.fn(async () => changes({ files: [] })) });
    const gate = createHumanGate(d);
    gate.check(room());

    await vi.waitFor(() => expect(d.humanChanges).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));

    expect(gate.gated()).toBe(false);
  });

  test("Keep lifts the gate, the same set stays kept, and new work re-gates", async () => {
    const d = deps();
    const gate = createHumanGate(d);
    gate.check(room());
    await vi.waitFor(() => expect(bannerShown()).toBe(true));

    row()!.querySelectorAll<HTMLButtonElement>("button")[3].click();   // Keep
    await vi.waitFor(() => expect(gate.gated()).toBe(false));

    expect(bannerShown()).toBe(false);
    expect(row()!.textContent).toContain("— kept");

    // Checking again with exactly the accepted set: nothing new to review.
    gate.check(room());
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.gated()).toBe(false);

    // Anything more or less is a new question.
    d.humanChanges = vi.fn(async () =>
      changes({ files: [ ...changes().files, { path: "more.rs", bytes: 10 } ] }));
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));
  });

  test("Stash sets the work aside, says how to bring it back, and lifts the gate", async () => {
    const d = deps();
    const gate = createHumanGate(d);
    gate.check(room());
    await vi.waitFor(() => expect(bannerShown()).toBe(true));

    row()!.querySelectorAll<HTMLButtonElement>("button")[2].click();   // Stash
    await vi.waitFor(() => expect(gate.gated()).toBe(false));

    expect(d.stash).toHaveBeenCalledWith(DIR);
    expect(row()!.textContent).toContain("— stashed, can be brought back: git stash pop");
    expect(bannerShown()).toBe(false);
  });

  test("a refused run keeps the message and says why; a plain message is not refused", async () => {
    const gate = createHumanGate(deps());
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));

    // Addressed to an agent: refused, with the reason shown. The input itself
    // is never the module's to touch, so the typed text survives by
    // construction — the caller clears it only after a send.
    expect(gate.refuse(true)).toBe(true);
    expect($("gate-refused").textContent).toContain("Runs are paused");

    expect(gate.refuse(false)).toBe(false);
  });

  test("Review and Commit both go to the review hook part B hangs its dialog on", async () => {
    const d = deps();
    const gate = createHumanGate(d);
    gate.check(room());
    await vi.waitFor(() => expect(bannerShown()).toBe(true));

    row()!.querySelectorAll<HTMLButtonElement>("button")[0].click();   // Review
    expect(d.openReview).toHaveBeenCalledWith(
      expect.objectContaining({ is_repo: true }), DIR);

    row()!.querySelectorAll<HTMLButtonElement>("button")[1].click();   // Commit
    expect(d.openReview).toHaveBeenCalledTimes(2);

    $("gate-review").click();                                          // banner Review
    expect(d.openReview).toHaveBeenCalledTimes(3);
  });

  test("an answer for a room nobody is looking at anymore is not drawn", async () => {
    const gate = createHumanGate(deps({ isOpen: () => false }));
    gate.check(room());
    await new Promise((r) => setTimeout(r, 10));

    expect(gate.gated()).toBe(false);
    expect(bannerShown()).toBe(false);
    expect(row()).toBeNull();
  });

  test("a stash git refused keeps the gate and says git's own words", async () => {
    const d = deps({ stash: vi.fn(async () => { throw new Error("error: cannot stash"); }) });
    const gate = createHumanGate(d);
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));

    row()!.querySelectorAll<HTMLButtonElement>("button")[2].click();   // Stash
    await vi.waitFor(() => expect(row()!.textContent).toContain("cannot stash"));

    expect(gate.gated()).toBe(true);
  });

  test("the fingerprint recognises exactly the accepted set", () => {
    const files = [ { path: "b.md", bytes: 2 }, { path: "a.md", bytes: 1 } ];
    expect(fingerprint(files)).toBe(fingerprint([ ...files ].reverse()));
    expect(fingerprint(files)).not.toBe(fingerprint([ { path: "a.md", bytes: 1 } ]));
    expect(fingerprint(files)).not.toBe(
      fingerprint([ { path: "b.md", bytes: 3 }, { path: "a.md", bytes: 1 } ]));
  });
});

describe("the review dialog's end of the gate (#207 part B)", () => {
  test("a folder without history is named quietly, and never gated", async () => {
    const d = deps({
      humanChanges: vi.fn(async () => changes({ is_repo: false, branch: null })),
    });
    const gate = createHumanGate(d);
    gate.check(room());

    await vi.waitFor(() => expect(row()).not.toBeNull());

    expect(row()!.textContent).toContain("no history");
    expect(rowButtons()).toEqual([ "Review" ]);
    expect(gate.gated()).toBe(false);
    expect(bannerShown()).toBe(false);

    row()!.querySelector<HTMLButtonElement>("button")!.click();
    expect(d.openReview).toHaveBeenCalledWith(
      expect.objectContaining({ is_repo: false }), DIR);
  });

  test("a commit through the dialog resolves the row with its sha", async () => {
    const gate = createHumanGate(deps());
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));

    await gate.resolve("committed", "abc1234");

    expect(row()!.textContent).toContain("— committed as abc1234");
    expect(gate.gated()).toBe(false);
    expect(bannerShown()).toBe(false);
  });

  test("the dialog's Keep and Stash are the row's own resolutions", async () => {
    const d = deps();
    const gate = createHumanGate(d);
    gate.check(room());
    await vi.waitFor(() => expect(gate.gated()).toBe(true));

    await gate.resolve("stashed");

    expect(d.stash).toHaveBeenCalledWith(DIR);
    expect(row()!.textContent).toContain("git stash pop");
  });
});
