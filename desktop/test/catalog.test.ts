import { describe, expect, test } from "vitest";
import { BASELINE, installPlan, profileFor, stateOf, type AgentProfile } from "../src/agents/catalog";

/// An agent WorkRoom has never heard of: a name, a command, and nothing the
/// catalog can offer to install for it.
const hand = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "kimi", label: "Kimi", command: "kimi-acp", args: [], aliases: [],
  docsUrl: "https://example.invalid/kimi", hint: "Install it yourself.", ...over,
});

const claude = () => profileFor("claude")!;
const codex = () => profileFor("codex")!;
const opencode = () => profileFor("opencode")!;

describe("the agents this project has chosen to support", () => {
  test("three are named, and naming one installs nothing", () => {
    expect(BASELINE.map((p) => p.name).sort()).toEqual([ "claude", "codex", "opencode" ]);
  });

  test("each carries what a person needs to decide: a command, a place to read, a sentence", () => {
    for (const profile of BASELINE) {
      expect(profile.label.trim().length).toBeGreaterThan(0);
      expect(profile.command.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(profile.args)).toBe(true);
      expect(profile.docsUrl).toMatch(/^https:\/\//);
      expect(profile.hint.trim().length).toBeGreaterThan(0);
    }
  });

  test("a name the catalog pinned has a profile; one it never heard of has none", () => {
    // Not an error. A person may add an agent nobody pinned, and it is shown
    // beside these three rather than refused.
    expect(profileFor("claude")).toBe(BASELINE.find((p) => p.name === "claude"));
    expect(profileFor("kimi")).toBeUndefined();
  });

  test("the adapter that was renamed still answers to the name it had", () => {
    // `@zed-industries/claude-code-acp` became `@agentclientprotocol/claude-agent-acp`.
    // Somebody who installed it before the rename has `claude-code-acp` on their
    // PATH, and probing only the new name would report them as having nothing.
    expect(claude().aliases).toContain("claude-code-acp");
    expect(claude().aliases).not.toContain(claude().command);
  });
});

describe("what is actually on this machine", () => {
  test("the adapter resolving is the whole answer — it is what the client spawns", () => {
    for (const profile of BASELINE) {
      expect(stateOf(profile, { command: `/usr/local/bin/${profile.command}` })).toBe("available");
    }
  });

  test("a vendor CLI without its adapter is a missing adapter, not a missing agent", () => {
    // The difference is the whole point of the state: this person installs one
    // npm package, not an agent from scratch.
    expect(stateOf(claude(), { vendorCli: "/usr/local/bin/claude" })).toBe("adapter-missing");
    expect(stateOf(codex(), { vendorCli: "/usr/local/bin/codex" })).toBe("adapter-missing");
  });

  test("an adapter found without its vendor CLI is still available", () => {
    // The probe looks where it can. What the client will spawn resolved, so the
    // agent runs — reporting it as missing would be a guess contradicted by the
    // filesystem.
    expect(stateOf(claude(), { command: "/opt/homebrew/bin/claude-agent-acp" })).toBe("available");
  });

  test("neither, for an agent that needs a vendor CLI, is a missing CLI", () => {
    expect(stateOf(claude(), {})).toBe("cli-missing");
    expect(stateOf(codex(), {})).toBe("cli-missing");
  });

  test("neither, for an agent that needs no vendor CLI, is not installed", () => {
    // opencode ships its own ACP server; there is nothing to install but the
    // package itself, so `cli-missing` would name a step that does not exist.
    expect(opencode().vendorCli).toBeUndefined();
    expect(stateOf(opencode(), {})).toBe("not-installed");
  });

  test("an agent added by hand is read the same way as the three", () => {
    expect(stateOf(hand(), { command: "/home/alice/.local/bin/kimi-acp" })).toBe("available");
    expect(stateOf(hand(), {})).toBe("not-installed");
  });
});

describe("what installing would run", () => {
  test("an agent that ships its own ACP server is one step", () => {
    const steps = installPlan(opencode(), "unix");

    expect(steps).toHaveLength(1);
    expect(steps[0].command).toContain(opencode().adapterPackage!);
  });

  test("an agent behind a vendor CLI is the CLI first, then the adapter", () => {
    // The other order installs an adapter for a CLI that is not there yet, and
    // the failure arrives with the wrong command's name on it.
    for (const profile of [ claude(), codex() ]) {
      const steps = installPlan(profile, "unix");

      expect(steps.map((s) => s.kind)).toEqual([ "cli", "adapter" ]);
      expect(steps[1].command).toContain(profile.adapterPackage!);
    }
  });

  test("the platform picks the vendor's own command, not a translation of it", () => {
    for (const profile of [ claude(), codex() ]) {
      expect(installPlan(profile, "unix")[0].command).toBe(profile.cliInstall!.unix);
      expect(installPlan(profile, "windows")[0].command).toBe(profile.cliInstall!.windows);
    }
  });

  test("the adapter step is npm, and it names this agent's package", () => {
    for (const profile of BASELINE) {
      const adapter = installPlan(profile, "unix").at(-1)!;

      expect(adapter.kind).toBe("adapter");
      expect(adapter.command).toContain("npm");
      expect(adapter.command).toContain(profile.adapterPackage!);
    }
  });

  test("nothing runs that was not shown first", () => {
    // Every install is a press, never a consequence: what a person is asked to
    // accept is the command that will run, not a description of it.
    for (const profile of BASELINE) {
      for (const os of [ "unix", "windows" ] as const) {
        for (const step of installPlan(profile, os)) {
          expect(step.shown).toContain(step.command);
        }
      }
    }
  });

  test("no agent's plan names another agent's package", () => {
    // A failure that suggests installing somebody else's package sends a person
    // to fix an agent they were not installing.
    for (const profile of BASELINE) {
      const text = JSON.stringify(installPlan(profile, "unix"));

      for (const other of BASELINE) {
        if (other.name === profile.name) continue;
        expect(text).not.toContain(other.adapterPackage!);
        if (other.vendorCli) expect(text).not.toContain(other.cliInstall!.unix);
      }
    }
  });

  test("an agent the catalog knows nothing about is not offered an install", () => {
    // A command somebody typed is theirs. Inventing an npm package from a name
    // would install whatever happens to be published under it.
    expect(installPlan(hand(), "unix")).toEqual([]);
    expect(installPlan(hand(), "windows")).toEqual([]);
  });
});
