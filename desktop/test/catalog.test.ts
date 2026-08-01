import { describe, expect, test } from "vitest";
import { BASELINE, installPlan, probeNames, profileFor, stateOf, type AgentProfile, type Resolved } from "../src/agents/catalog";

/// What the catalog must say, written here rather than read out of the module
/// under test. A catalog compared to itself is green whatever it holds, and
/// what it holds is the card: a stale package name installs the adapter that
/// was renamed away, and a wrong command reports an agent somebody has as
/// missing.
///
/// Verified against the npm registry and the vendors' own instructions on
/// 2026-08-01. #111's bench is what keeps them honest as the vendors move.
const PINNED = {
  opencode: {
    command: "opencode",
    args: [ "acp" ],
    vendorCli: undefined,
    adapterPackage: "opencode-ai",
    cliInstall: undefined,
  },
  claude: {
    command: "claude-agent-acp",
    args: [],
    vendorCli: "claude",
    adapterPackage: "@agentclientprotocol/claude-agent-acp",
    cliInstall: {
      unix: "curl -fsSL https://claude.ai/install.sh | bash",
      windows: "irm https://claude.ai/install.ps1 | iex",
    },
  },
  codex: {
    command: "codex-acp",
    args: [],
    vendorCli: "codex",
    adapterPackage: "@zed-industries/codex-acp",
    cliInstall: {
      unix: "npm install -g @openai/codex",
      windows: "npm install -g @openai/codex",
    },
  },
} as const;

/// An agent WorkRoom has never heard of: a name, a command, and nothing the
/// catalog can offer to install for it.
const hand = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "kimi", label: "Kimi", command: "kimi-acp", args: [], aliases: [],
  docsUrl: "https://example.invalid/kimi", hint: "Install it yourself.", ...over,
});

const claude = () => profileFor("claude")!;
const codex = () => profileFor("codex")!;
const opencode = () => profileFor("opencode")!;

/// A machine with these commands on it, read the way the client reads one: the
/// probe is asked for every name the profile answers to.
const on = (machine: string[]) => (profile: AgentProfile): Resolved => {
  const command = probeNames(profile).find((n) => machine.includes(n));
  const vendorCli = profile.vendorCli && machine.includes(profile.vendorCli)
    ? profile.vendorCli : undefined;
  return {
    ...(command ? { command: `/usr/local/bin/${command}` } : {}),
    ...(vendorCli ? { vendorCli: `/usr/local/bin/${vendorCli}` } : {}),
  };
};

describe("the agents this project has chosen to support", () => {
  test("three are named, and naming one installs nothing", () => {
    expect(BASELINE.map((p) => p.name).sort()).toEqual([ "claude", "codex", "opencode" ]);
  });

  test.each(Object.entries(PINNED))("%s is pinned to a real command and a real package", (name, pin) => {
    const profile = profileFor(name)!;

    expect(profile.command).toBe(pin.command);
    expect(profile.args).toEqual(pin.args);
    expect(profile.vendorCli).toBe(pin.vendorCli);
    expect(profile.adapterPackage).toBe(pin.adapterPackage);
    expect(profile.cliInstall).toEqual(pin.cliInstall);
  });

  test("the claude adapter is the one that is published, not the one it was", () => {
    // docs/AGENTS.md still names `@zed-industries/claude-code-acp`. Installing
    // that today installs an adapter nobody publishes any more.
    expect(claude().adapterPackage).not.toBe("@zed-industries/claude-code-acp");
    expect(claude().adapterPackage).toBe("@agentclientprotocol/claude-agent-acp");
  });

  test("each carries what a person needs to decide: a label, a place to read, a sentence", () => {
    for (const profile of BASELINE) {
      expect(profile.label.trim().length).toBeGreaterThan(0);
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
});

describe("the names a probe is asked about", () => {
  test("the command it will spawn comes first, then every name it also answers to", () => {
    // The claude adapter has been renamed once. A probe that asks only about
    // the current name reports somebody who installed it before the rename as
    // having nothing, and offers them an install they do not need.
    expect(probeNames(claude())).toEqual([ "claude-agent-acp", "claude-code-acp" ]);
    expect(probeNames(opencode())).toEqual([ "opencode" ]);
    expect(probeNames(hand())).toEqual([ "kimi-acp" ]);
  });

  test("the adapter installed before the rename reads as available", () => {
    const machine = on([ "claude-code-acp", "claude" ]);

    expect(stateOf(claude(), machine(claude()))).toBe("available");
    expect(installPlan(claude(), "unix", machine(claude()))).toEqual([]);
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
    // `cli-missing` and `not-installed` are both "nothing here" — they differ in
    // what pressing Install does, which is why the panel keeps them apart. The
    // copy a person reads for either may still say "not installed".
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
    expect(steps[0].command).toContain("opencode-ai");
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

  test("a vendor CLI already on the machine is not installed over again", () => {
    // Somebody who has `claude` and not the adapter installs one npm package.
    // Re-running the vendor's installer over a CLI they already have is a
    // download they did not ask for, and on a version they may have chosen.
    const steps = installPlan(claude(), "unix", { vendorCli: "/usr/local/bin/claude" });

    expect(steps.map((s) => s.kind)).toEqual([ "adapter" ]);
    expect(steps[0].command).toContain(claude().adapterPackage!);
    expect(JSON.stringify(steps)).not.toContain("claude.ai/install.sh");
  });

  test("an agent that is already available has nothing to install", () => {
    expect(installPlan(codex(), "unix", { command: "/usr/local/bin/codex-acp" })).toEqual([]);
  });

  test("with nothing found, the plan is the whole plan", () => {
    expect(installPlan(claude(), "unix", {}).map((s) => s.kind)).toEqual([ "cli", "adapter" ]);
    expect(installPlan(claude(), "unix").map((s) => s.kind)).toEqual([ "cli", "adapter" ]);
  });

  test("the platform picks the vendor's own command, not a translation of it", () => {
    expect(installPlan(claude(), "unix")[0].command)
      .toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installPlan(claude(), "windows")[0].command)
      .toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installPlan(codex(), "windows")[0].command).toBe("npm install -g @openai/codex");
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
