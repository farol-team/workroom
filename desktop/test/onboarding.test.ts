import { beforeEach, describe, expect, test, vi } from "vitest";
import { showOnboarding, type OnboardingHooks } from "../src/onboarding";
import { createAgentsPanel, type AgentsPanel } from "../src/agents-panel";
import { Agents } from "../src/agent";
import { profileFor } from "../src/agents/catalog";
import { onboardingCards, type AgentDef } from "../src/rules";

// The bridge, doubled at the one seam that is a real process boundary: every
// effect the panel has on this machine leaves through `invoke`, and nothing
// else about the agents is pretended here.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

// The overlay's half of index.html plus the agents panel's, because the two are
// two doors into the same room. Kept in step with the real markup by hand, the
// way the preview keeps its selectors.
const MARKUP = `
  <div id="onboarding" hidden>
    <h2 id="ob-title"></h2><p id="ob-note"></p><div id="ob-cards"></div>
    <span id="ob-dots"></span>
    <button id="ob-back" hidden></button><button id="ob-next"></button>
  </div>
  <div id="agents"></div><button id="agents-open"></button>
  <div id="session-options"></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PREFIX = "/Users/alice/Library/Application Support/workroom/npm";
const INSTALL = `npm install -g --prefix "${PREFIX}" @agentclientprotocol/codex-acp`;

/// Two agents this person has written down: the one that ships, and one that
/// would have to be fetched.
const DEFS: AgentDef[] = [
  { name: "claude", command: "claude-agent-acp", args: [] },
  { name: "codex", command: "codex-acp", args: [] },
];

const OK = { ok: true, code: 0, stdoutTail: "", stderrTail: "" };

type Call = { command: string; args: Record<string, unknown> };

/// The Rust side, answering as the machine would. `where` is what the probe
/// finds, which is the whole of what "ready" means for an agent that does not
/// ship here.
function bridge(over: Record<string, (args: never) => unknown> = {}) {
  const calls: Call[] = [];
  const where = new Map<string, string>();
  const answers: Record<string, (args: never) => unknown> = {
    agent_probe: ({ commands }: never & { commands: string[] }) =>
      commands.map((c) => where.get(c) ?? null),
    agent_start: () => null,
    agent_stop: () => null,
    agent_install: () => OK,
    ...over,
  };

  vi.mocked(invoke).mockImplementation(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    const answer = answers[command];
    if (!answer) throw new Error(`nothing doubles ${command}`);
    return answer(args as never);
  });

  return { calls, where, of: (command: string) => calls.filter((c) => c.command === command) };
}

function panelWith(over: Record<string, unknown> = {}) {
  const agents = new Agents(DEFS);
  const openSession = vi.fn(async () => {});
  const onTrouble = vi.fn();
  const panel: AgentsPanel = createAgentsPanel(
    { agents, prefix: () => PREFIX, openSession, onTrouble, ...over } as never);
  return { agents, panel, openSession, onTrouble };
}

/// The cards are the panel's own inputs — what the machine said about each
/// agent — so the setup and the panel cannot disagree about an agent.
const cardsFrom = (agents: Agents) =>
  onboardingCards(agents.definitions().map((d) => ({
    name: d.name,
    label: profileFor(d.name)?.label ?? d.name,
    state: agents.stateOf(d.name),
    running: agents.isRunning(d.name),
  })));

function hooks(agents: Agents, panel: AgentsPanel,
               over: Partial<OnboardingHooks> = {}): OnboardingHooks {
  return {
    cards: () => cardsFrom(agents),
    agentCard: panel.agentCard,
    onFinish: vi.fn(),
    ...over,
  };
}

const cards = () => [ ...document.querySelectorAll<HTMLElement>("#ob-cards .ob-card") ];
const rows = () => [ ...document.querySelectorAll<HTMLElement>("#agents .agent-row") ];
/// The one thing to do about an agent: the last button of its drawing.
const actionIn = (el: HTMLElement) => [ ...el.querySelectorAll<HTMLButtonElement>("button") ].at(-1)!;
/// The state it is really in, said the same way in both drawings.
const saysIn = (el: HTMLElement) => el.querySelector<HTMLElement>(".muted")!.textContent;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  localStorage.clear();
  vi.clearAllMocks();
});

describe("the first-run setup", () => {
  test("the first step is what the machine has, with each card's one action", () => {
    bridge();
    const { agents, panel } = panelWith();
    showOnboarding(hooks(agents, panel));

    expect($("onboarding").hidden).toBe(false);
    expect($("ob-title").textContent).toBe("Your agent");
    expect($("ob-dots").textContent).toBe("1 of 2");

    expect(cards().map((el) => actionIn(el).textContent)).toEqual([ "Start", "Install" ]);
    // The command is shown before it runs.
    expect(document.querySelector("#ob-cards code")?.textContent).toBe(INSTALL);
  });

  test("a card's action is the panel's action", async () => {
    const rust = bridge();
    const { agents, panel } = panelWith();
    showOnboarding(hooks(agents, panel));

    const [ claude, codex ] = cards();
    actionIn(claude).click();
    await vi.waitFor(() => expect(rust.of("agent_start")).toHaveLength(1));
    actionIn(codex).click();
    await vi.waitFor(() =>
      expect(rust.of("agent_install")[0].args).toEqual({ command: INSTALL }));
  });

  test("the second step is the default, and finishing hands the choice over", () => {
    bridge();
    const { agents, panel } = panelWith();
    const h = hooks(agents, panel);
    showOnboarding(h);

    $("ob-next").click();   // Continue
    expect($("ob-dots").textContent).toBe("2 of 2");

    const picks = [ ...document.querySelectorAll<HTMLButtonElement>("#ob-cards .ob-card") ];
    expect(picks[1].disabled).toBe(true);   // not installed is not a default
    picks[0].click();
    // Render rebuilds the cards, so the chosen one is a fresh element.
    expect(document.querySelector("#ob-cards .ob-card")!.className).toContain("chosen");

    $("ob-next").click();   // Finish
    expect(h.onFinish).toHaveBeenCalledWith("claude");
    expect($("onboarding").hidden).toBe(true);
  });

  test("nothing ready is not a lock — finishing hands over undefined", () => {
    bridge();
    const { agents, panel } = panelWith();
    const h = hooks(agents, panel, {
      cards: () => onboardingCards([
        { name: "codex", label: "Codex", state: "missing", running: false },
      ]),
    });
    showOnboarding(h);

    $("ob-next").click();
    expect($("ob-note").textContent).toContain("Nothing is ready");
    $("ob-next").click();
    expect(h.onFinish).toHaveBeenCalledWith(undefined);
  });
});

// What the panel does to the machine, asserted where it leaves for the machine.
// An agent reported as ready that is not there is worse than no panel at all,
// so nothing here is judged by what the panel drew alone.
describe("the agents panel, acting", () => {
  test("starting one starts the command this person wrote down", async () => {
    const rust = bridge();
    const { agents, panel, openSession } = panelWith();
    panel.render();

    await panel.start("claude");

    expect(rust.of("agent_start")[0].args)
      .toEqual({ name: "claude", command: "claude-agent-acp", args: [] });
    expect(agents.isRunning("claude")).toBe(true);
    expect(saysIn(rows()[0])).toBe("running");
    expect(actionIn(rows()[0]).textContent).toBe("Stop");
    // And its session opens in the room that is on screen.
    expect(openSession).toHaveBeenCalledWith("claude");
    expect(panel.busy.has("claude")).toBe(false);
  });

  test("what a start is doing is on the row while it is doing it", async () => {
    let finish = () => {};
    bridge({ agent_start: () => new Promise((r) => { finish = () => r(null); }) });
    const { panel } = panelWith();
    panel.render();

    const starting = panel.start("claude");
    expect(saysIn(rows()[0])).toBe("starting…");
    expect(actionIn(rows()[0]).disabled).toBe(true);

    finish();
    await starting;
    expect(panel.busy.has("claude")).toBe(false);
  });

  test("toggling stops what is running and starts what is not", async () => {
    const rust = bridge();
    const { agents, panel } = panelWith();
    panel.render();

    await panel.toggle("claude");
    expect(rust.of("agent_start")).toHaveLength(1);
    expect(agents.isRunning("claude")).toBe(true);

    await panel.toggle("claude");
    expect(rust.of("agent_stop")[0].args).toEqual({ name: "claude" });
    expect(agents.isRunning("claude")).toBe(false);
    expect(saysIn(rows()[0])).toBe("ready");
    expect(actionIn(rows()[0]).textContent).toBe("Start");
  });

  test("an agent that will not start says why, and is not called running", async () => {
    bridge({ agent_start: () => { throw new Error("spawn ENOENT"); } });
    const { agents, panel, onTrouble } = panelWith();
    panel.render();

    await panel.toggle("claude");

    expect(agents.isRunning("claude")).toBe(false);
    expect(onTrouble.mock.calls[0][0]).toContain("spawn ENOENT");
    expect(panel.busy.has("claude")).toBe(false);
    expect(actionIn(rows()[0]).textContent).toBe("Start");
  });

  test("installing runs exactly the command that was shown, then asks again", async () => {
    const rust = bridge();
    const { panel } = panelWith();
    panel.render();
    expect(document.querySelector("#agents code")?.textContent).toBe(INSTALL);

    // What it did is the machine's to say, not the exit code's — so the panel
    // looks for the command again before it calls anything ready.
    rust.where.set("codex-acp", `${PREFIX}/bin/codex-acp`);
    await panel.install("codex");

    expect(rust.of("agent_install")[0].args).toEqual({ command: INSTALL });
    expect(rust.of("agent_probe").at(-1)!.args)
      .toEqual({ commands: [ "claude-agent-acp", "codex-acp" ] });
    expect(saysIn(rows()[1])).toBe("ready");
    expect(actionIn(rows()[1]).textContent).toBe("Start");
    expect(document.querySelector("#agents code")).toBeNull();
  });

  test("an install npm refused says what npm said, and nothing is called ready", async () => {
    const rust = bridge({
      agent_install: () => ({ ok: false, code: 1, stdoutTail: "", stderrTail: "E404 Not Found" }),
    });
    const { panel, onTrouble } = panelWith();
    panel.render();

    await panel.install("codex");

    const [ said ] = onTrouble.mock.calls[0];
    expect(said).toContain(INSTALL);
    expect(said).toContain("E404 Not Found");
    expect(rust.of("agent_probe")).toHaveLength(1);   // asked anyway
    expect(saysIn(rows()[1])).toBe("missing");
    expect(actionIn(rows()[1]).textContent).toBe("Install");
  });

  // A press is the one place the work is started and nobody is waiting on the
  // promise. What the bridge refused has to arrive somewhere a person can read
  // it — an unhandled rejection is a button that did nothing and said nothing.
  test("a stop the bridge refuses is said, not swallowed", async () => {
    bridge({ agent_stop: () => { throw new Error("no such process"); } });
    const { panel, onTrouble } = panelWith();
    await panel.start("claude");
    panel.render();

    actionIn(rows()[0]).click();   // Stop

    await vi.waitFor(() => expect(onTrouble.mock.calls[0][0]).toContain("no such process"));
  });

  test("the one that ships is never offered an install", () => {
    bridge();
    const { panel } = panelWith();
    panel.render();

    expect(document.querySelectorAll("#agents code")).toHaveLength(1);
    expect(actionIn(rows()[0]).textContent).toBe("Start");
  });
});

// One agent, one answer about it, whichever door somebody came through. Two
// drawings of the same state that can drift apart is what this replaces: an
// install running in one and offered again in the other starts it twice.
describe("the setup and the agents panel, one answer", () => {
  test("the overlay draws no agent of its own", () => {
    bridge();
    const { agents, panel } = panelWith();
    const drawn: HTMLElement[] = [];
    showOnboarding(hooks(agents, panel, {
      agentCard: (card, refresh) => {
        const el = panel.agentCard(card, refresh);
        drawn.push(el);
        return el;
      },
    }));

    expect(drawn).toHaveLength(2);
    expect(cards()).toHaveLength(2);
    cards().forEach((el, i) => expect(el).toBe(drawn[i]));
  });

  test("the panel and the setup say the same thing about the same agent", () => {
    bridge();
    const { agents, panel } = panelWith();
    panel.render();
    showOnboarding(hooks(agents, panel));

    expect(rows().map(saysIn)).toEqual([ "ready", "missing" ]);
    expect(cards().map(saysIn)).toEqual(rows().map(saysIn));
    expect(cards().map((el) => actionIn(el).textContent))
      .toEqual(rows().map((el) => actionIn(el).textContent));
    // And the footer of the sidebar carries the same answer in one line.
    expect($("agents-open").textContent).toBe("Claude · ready");
  });

  test("an agent that is running is running in both", async () => {
    bridge();
    const { agents, panel } = panelWith();
    await panel.start("claude");
    showOnboarding(hooks(agents, panel));

    expect(rows().map(saysIn)).toEqual([ "running", "missing" ]);
    expect(cards().map(saysIn)).toEqual([ "running", "missing" ]);
    expect(cards().map((el) => actionIn(el).textContent)).toEqual([ "Stop", "Install" ]);
  });

  test("an install started in the agents panel is busy in the overlay too", async () => {
    let finish = () => {};
    bridge({ agent_install: () => new Promise((r) => { finish = () => r(OK); }) });
    const { agents, panel } = panelWith();
    panel.render();

    panel.install("codex");   // in flight, deliberately not awaited
    expect(saysIn(rows()[1])).toBe("installing…");
    expect(actionIn(rows()[1]).disabled).toBe(true);

    showOnboarding(hooks(agents, panel));
    expect(saysIn(cards()[1])).toBe("installing…");
    expect(actionIn(cards()[1]).disabled).toBe(true);

    finish();
    await vi.waitFor(() => expect(panel.busy.has("codex")).toBe(false));
  });

  // The same press, through the other door: what the bridge refused is said
  // there too, because it is the panel's press either way.
  test("an install the bridge could not run is said in the setup too", async () => {
    bridge({ agent_install: () => { throw new Error("npm is not on the PATH"); } });
    const { agents, panel, onTrouble } = panelWith();
    panel.render();
    showOnboarding(hooks(agents, panel));

    actionIn(cards()[1]).click();

    await vi.waitFor(() =>
      expect(onTrouble.mock.calls[0][0]).toContain("npm is not on the PATH"));
  });

  test("an install started in the setup is busy in the agents panel too", async () => {
    let finish = () => {};
    const rust = bridge({ agent_install: () => new Promise((r) => { finish = () => r(OK); }) });
    const { agents, panel } = panelWith();
    panel.render();
    showOnboarding(hooks(agents, panel));

    actionIn(cards()[1]).click();

    expect(rust.of("agent_install")[0].args).toEqual({ command: INSTALL });
    expect(panel.busy.get("codex")).toBe("installing…");
    expect(saysIn(cards()[1])).toBe("installing…");
    expect(saysIn(rows()[1])).toBe("installing…");

    finish();
    await vi.waitFor(() => expect(panel.busy.has("codex")).toBe(false));
    expect(rust.of("agent_probe").length).toBeGreaterThan(0);
  });
});
