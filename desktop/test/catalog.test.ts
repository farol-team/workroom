import { describe, expect, test } from "vitest";
import { BASELINE, installCommand, profileFor, stateOf } from "../src/agents/catalog";

/// What the catalog must hold, written here as literals rather than read back
/// out of the module under test. A catalog compared against itself is green
/// whatever it says, and what it says is the whole of this card: a stale
/// package installs an adapter nobody publishes any more, and a wrong command
/// reports an agent somebody already has as missing.
///
/// Verified against the registry on 2026-08-01 — `npm view <package> bin` names
/// the command each one puts on the machine.
const PINNED = {
  claude: { command: "claude-agent-acp", args: [] as string[], shipped: true },
  codex: { command: "codex-acp", args: [] as string[], shipped: false },
  opencode: { command: "opencode", args: [ "acp" ], shipped: false },
} as const;

const PACKAGES = {
  codex: "@agentclientprotocol/codex-acp",
  opencode: "opencode-ai",
} as const;

const PREFIX = "/home/alice/.local/share/WorkRoom/npm";

const claude = () => profileFor("claude")!;
const codex = () => profileFor("codex")!;
const opencode = () => profileFor("opencode")!;

describe("the agents this application knows about", () => {
  test("three are named, and naming one installs nothing", () => {
    expect(BASELINE.map((p) => p.name).sort()).toEqual([ "claude", "codex", "opencode" ]);
  });

  test.each(Object.entries(PINNED))("%s is pinned to the command it publishes", (name, pin) => {
    const profile = profileFor(name)!;

    expect(profile.command).toBe(pin.command);
    expect(profile.args).toEqual(pin.args);
    expect(profile.shipped).toBe(pin.shipped);
  });

  test.each(Object.entries(PACKAGES))("%s is fetched under the name that publishes it", (name, pkg) => {
    expect(profileFor(name)!.package).toBe(pkg);
  });

  test("the codex adapter is the one that is current, not the one it was", () => {
    // `@zed-industries/codex-acp` is still on the registry at 0.16.0. Pinning it
    // installs the older adapter, which is why the catalog says which.
    expect(codex().package).not.toBe("@zed-industries/codex-acp");
  });

  test("each carries what somebody needs to decide: a label and a place to read", () => {
    for (const profile of BASELINE) {
      expect(profile.label.trim().length).toBeGreaterThan(0);
      expect(profile.docsUrl).toMatch(/^https:\/\//);
    }
  });

  test("a name the catalog pinned has a profile; one it never heard of has none", () => {
    // Not an error. A person may name an agent nobody pinned, and it belongs
    // beside these three rather than being refused.
    expect(profileFor("claude")).toBe(BASELINE.find((p) => p.name === "claude"));
    expect(profileFor("kimi")).toBeUndefined();
  });
});

describe("what the panel says about an agent", () => {
  test("the one that ships is ready before anything is looked for", () => {
    // It is in the bundle (#120). Reporting it as missing would offer an
    // install for something this application already carries.
    expect(stateOf(claude(), null)).toBe("ready");
  });

  test("an agent whose command is on this machine is ready", () => {
    expect(stateOf(opencode(), "/usr/local/bin/opencode")).toBe("ready");
  });

  test("an agent whose command is nowhere is missing", () => {
    expect(stateOf(opencode(), null)).toBe("missing");
    expect(stateOf(codex(), null)).toBe("missing");
  });
});

describe("what installing one would run", () => {
  test("nothing, for the agent that ships here", () => {
    // The state and the offer come from one place, so they cannot disagree.
    expect(installCommand(claude(), PREFIX)).toBeNull();
  });

  test.each(Object.entries(PACKAGES))("%s is one npm install into our own prefix", (name, pkg) => {
    const command = installCommand(profileFor(name)!, PREFIX)!;

    expect(command).toContain("npm install -g");
    expect(command).toContain("--prefix");
    expect(command).toContain(PREFIX);
    expect(command).toContain(pkg);
  });

  test("it installs nowhere else on the machine", () => {
    // A global install without a prefix writes into the person's node
    // installation. What this application fetches, it owns.
    const command = installCommand(opencode(), PREFIX)!;

    expect(command.indexOf("--prefix")).toBeLessThan(command.indexOf("opencode-ai"));
  });

  test("a prefix with a space in it survives being run", () => {
    // The app data directory on macOS is `~/Library/Application Support/…`.
    // Unquoted, npm reads `Support/WorkRoom/npm` as another package to install.
    const spaced = "/Users/alice/Library/Application Support/WorkRoom/npm";

    expect(installCommand(opencode(), spaced)).toContain(`"${spaced}"`);
  });
});
