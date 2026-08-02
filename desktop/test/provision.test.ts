import { beforeEach, describe, expect, test, vi } from "vitest";
import { createProvision, type FolderState, type ProvisionDeps } from "../src/provision";
import type { Channel } from "../src/api";

// The feed the provision rows are drawn into. Kept in step with the real
// markup by hand, the way the timeline spec keeps its own.
const MARKUP = `<section id="messages"></section>`;

const URL = "https://github.com/acme/widgets";
const DIR = "/home/alice/WorkRoom/farol/meetings";

function room(over: Partial<Channel> = {}): Channel {
  return {
    id: 1, slug: "meetings", name: "Meetings", purpose: null, visibility: "open",
    memory_uri: "viking://resources/channels/meetings/", message_count: 0,
    repository_url: URL,
    ...over,
  };
}

const missing: FolderState = { exists: false, empty: true, remote: null };
const emptyDir: FolderState = { exists: true, empty: true, remote: null };
const sameRepo: FolderState = { exists: true, empty: false, remote: URL };
const otherRepo: FolderState = { exists: true, empty: false, remote: "https://github.com/acme/other" };
const notARepo: FolderState = { exists: true, empty: false, remote: null };

/// The seams provisioning cannot own: this machine's bindings, the bridge,
/// and the settings dialog a warning sends the person to.
function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    bindings: () => ({}),
    derivedPath: vi.fn(async () => DIR),
    folderState: vi.fn(async () => missing),
    clone: vi.fn(async () => {}),
    isOpen: () => true,
    openSettings: vi.fn(),
    ...over,
  };
}

const row = () => document.querySelector<HTMLElement>(".provision");

beforeEach(() => { document.body.innerHTML = MARKUP; });

describe("provisioning the channel folder", () => {
  test("a channel with no repository is left alone entirely", () => {
    const d = deps();
    createProvision(d).consider(room({ repository_url: null }));

    expect(d.derivedPath).not.toHaveBeenCalled();
    expect(row()).toBeNull();
  });

  test("a binding always wins: a chosen folder is never auto-cloned over", () => {
    const d = deps({ bindings: () => ({ meetings: "/home/alice/src/widgets" }) });
    createProvision(d).consider(room());

    expect(d.derivedPath).not.toHaveBeenCalled();
    expect(d.clone).not.toHaveBeenCalled();
    expect(row()).toBeNull();
  });

  test.each([ [ "missing", missing ], [ "empty", emptyDir ] ])(
    "a %s folder gets the repository cloned into it, and the row says so",
    async (_name, state) => {
      const d = deps({ folderState: vi.fn(async () => state) });
      createProvision(d).consider(room());

      await vi.waitFor(() => expect(row()?.textContent).toContain("Repository ready"));

      expect(d.clone).toHaveBeenCalledWith(URL, DIR);
    },
  );

  test("a folder already holding the room's repository is used as-is", async () => {
    const d = deps({ folderState: vi.fn(async () => sameRepo) });
    createProvision(d).consider(room());

    await vi.waitFor(() => expect(d.folderState).toHaveBeenCalledWith(DIR));

    expect(d.clone).not.toHaveBeenCalled();
    expect(row()).toBeNull();
  });

  test.each([ [ "a different repository", otherRepo ], [ "work that is no repository", notARepo ] ])(
    "a folder holding %s is warned about and never touched",
    async (_name, state) => {
      const d = deps({ folderState: vi.fn(async () => state) });
      createProvision(d).consider(room());

      await vi.waitFor(() =>
        expect(row()?.textContent).toContain("holds a different repository"));

      expect(d.clone).not.toHaveBeenCalled();

      row()!.querySelector<HTMLButtonElement>("button.ghost")!.click();
      expect(d.openSettings).toHaveBeenCalled();
    },
  );

  test("a failed clone keeps the row, says git's own words, and offers Retry", async () => {
    const d = deps({
      clone: vi.fn(async () => { throw new Error("fatal: repository not found"); }),
    });
    createProvision(d).consider(room());

    await vi.waitFor(() => expect(row()?.textContent).toContain("fatal: repository not found"));

    expect(row()!.querySelector("button.ghost")!.textContent).toBe("Retry");
  });

  test("Retry runs the same flow again, and success replaces the failure", async () => {
    let attempts = 0;
    const d = deps({
      clone: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("fatal: could not read from remote");
      }),
    });
    const provision = createProvision(d);
    provision.consider(room());
    await vi.waitFor(() => expect(row()?.textContent).toContain("could not read"));

    row()!.querySelector<HTMLButtonElement>("button.ghost")!.click();

    await vi.waitFor(() => expect(row()?.textContent).toContain("Repository ready"));
    expect(d.clone).toHaveBeenCalledTimes(2);
  });

  test("opening the same room twice does not race two clones into one folder", async () => {
    let release!: () => void;
    const d = deps({ clone: vi.fn(() => new Promise<void>((r) => { release = r; })) });
    const provision = createProvision(d);
    provision.consider(room());
    await vi.waitFor(() => expect(d.clone).toHaveBeenCalledTimes(1));

    provision.consider(room());
    release();
    await vi.waitFor(() => expect(row()?.textContent).toContain("Repository ready"));

    expect(d.clone).toHaveBeenCalledTimes(1);
  });

  test("a folder the bridge cannot read is still cloned into, never deleted from", async () => {
    // folderState failing is answered by attempting the clone: agent_clone
    // refuses a non-empty directory itself, so the destructive case is
    // impossible either way, and the common case — the folder simply is not
    // there — is not held up by a broken probe.
    const d = deps({ folderState: vi.fn(async () => { throw new Error("bridge is away"); }) });
    createProvision(d).consider(room());

    await vi.waitFor(() => expect(row()?.textContent).toContain("Repository ready"));

    expect(d.clone).toHaveBeenCalledWith(URL, DIR);
  });

  test("a row for a room nobody is looking at anymore is not drawn", async () => {
    // The channel can be left while the bridge answers; pouring one room's
    // clone progress into another room's feed is worse than dropping it.
    const d = deps({ isOpen: () => false });
    createProvision(d).consider(room());

    await vi.waitFor(() => expect(d.clone).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    expect(row()).toBeNull();
  });
});
