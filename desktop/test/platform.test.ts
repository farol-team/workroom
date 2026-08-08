import { beforeEach, describe, expect, test, vi } from "vitest";

// The browser's half of the shell. What it can do it does; what it cannot it says,
// because a folder picker that quietly answers nothing is indistinguishable from a
// person who pressed cancel, and the window would go on as though a folder had been
// chosen.
import { platform } from "../src/platform/web";

describe("the web platform", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  test("knows which half it is", () => {
    expect(platform.kind).toBe("web");
  });

  test("a link opens in a tab", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);

    await platform.openLink("https://example.test/a");

    expect(opened).toHaveBeenCalledWith("https://example.test/a", "_blank", "noopener");
  });

  test("there is no folder to pick, and that is an answer rather than an error", async () => {
    await expect(platform.chooseFolder("Pick a folder")).resolves.toBeNull();
  });

  test("there is no directory of this machine's to name", async () => {
    await expect(platform.dataDir()).resolves.toBeNull();
  });

  test("there is no update to install here — the page is the update", async () => {
    await expect(platform.update()).resolves.toBeNull();
  });

  test("writing a mirror rejects, and says why", async () => {
    await expect(platform.writeMirror("/tmp/x", [ { path: "a.md", body: "hi" } ]))
      .rejects.toThrow(/browser/i);
  });
});

describe("the web platform's agent runtime", () => {
  const agents = platform.agents([]);

  test("reports no agents, which the window already renders", () => {
    expect(agents.definitions()).toEqual([]);
    expect(agents.running).toEqual([]);
    expect(agents.isRunning("opencode")).toBe(false);
  });

  test("no agent is ready here, which is what the sidebar asks", () => {
    // #93: an agent the window offers and cannot start is worse than one it never
    // offered. The answer here is the one a machine without the command gives.
    expect(agents.stateOf("opencode")).toBe("missing");
  });

  test("anything that would need a process rejects with the reason", async () => {
    await expect(agents.start("opencode")).rejects.toThrow(/browser/i);
    await expect(agents.sessionFor("opencode", "sales", "/tmp")).rejects.toThrow(/browser/i);
    await expect(agents.prompt("opencode", "s-1", "hello", null)).rejects.toThrow(/browser/i);
  });

  test("stopping what never started is not an error", async () => {
    await expect(agents.stop()).resolves.toBeUndefined();
    await expect(agents.releaseChannel("sales")).resolves.toBeUndefined();
  });

  test("nothing ever arrives, so a listener is a no-op that can still be removed", async () => {
    const off = await agents.onUpdate("s-1", () => { throw new Error("nothing sends here"); });

    expect(typeof off).toBe("function");
    off();
  });
});
