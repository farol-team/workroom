import { beforeEach, describe, expect, test, vi } from "vitest";
import { showOnboarding, type OnboardingHooks } from "../src/onboarding";
import { createAgentsPanel, type AgentsPanel } from "../src/agents-panel";
import { profileFor } from "../src/agents/catalog";
import { onboardingCards } from "../src/rules";

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

/// What the machine says it has. The panel asks it and nothing else — an agent
/// reported as ready that is not there is worse than no panel at all.
function machine(over: Record<string, unknown> = {}) {
  const state: Record<string, "ready" | "missing"> = { claude: "ready", codex: "missing" };
  const running = new Set<string>();
  return {
    definitions: () => [ { name: "claude", command: "claude-agent-acp", args: [] },
                         { name: "codex", command: "codex-acp", args: [] } ],
    stateOf: (name: string) => state[name],
    isRunning: (name: string) => running.has(name),
    probe: vi.fn(async () => {}),
    install: vi.fn(async () => { state.codex = "ready"; return { ok: true, code: 0, stdoutTail: "", stderrTail: "" }; }),
    start: vi.fn(async (name: string) => { running.add(name); }),
    stop: vi.fn(async (name: string) => { running.delete(name); }),
    configFor: () => [],
    ...over,
  };
}

function panelFor(m: ReturnType<typeof machine>): AgentsPanel {
  return createAgentsPanel({ agents: m as never, prefix: () => PREFIX });
}

/// The cards are the panel's own inputs — what the machine said about each
/// agent — so the setup and the panel cannot disagree about an agent.
const cardsFrom = (m: ReturnType<typeof machine>) =>
  onboardingCards(m.definitions().map((d) => ({
    name: d.name,
    label: profileFor(d.name)?.label ?? d.name,
    state: m.stateOf(d.name),
    running: m.isRunning(d.name),
  })));

function hooks(m: ReturnType<typeof machine>, panel: AgentsPanel,
               over: Partial<OnboardingHooks> = {}): OnboardingHooks {
  return {
    cards: () => cardsFrom(m),
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

beforeEach(() => { document.body.innerHTML = MARKUP; localStorage.clear(); });

describe("the first-run setup", () => {
  test("the first step is what the machine has, with each card's one action", () => {
    const m = machine();
    showOnboarding(hooks(m, panelFor(m)));

    expect($("onboarding").hidden).toBe(false);
    expect($("ob-title").textContent).toBe("Your agent");
    expect($("ob-dots").textContent).toBe("1 of 2");

    expect(cards().map((el) => actionIn(el).textContent)).toEqual([ "Start", "Install" ]);
    // The command is shown before it runs.
    expect(document.querySelector("#ob-cards code")?.textContent)
      .toBe(`npm install -g --prefix "${PREFIX}" @agentclientprotocol/codex-acp`);
  });

  test("a card's action is the panel's action", async () => {
    const m = machine();
    showOnboarding(hooks(m, panelFor(m)));

    const [ claude, codex ] = cards();
    actionIn(claude).click();
    await vi.waitFor(() => expect(m.start).toHaveBeenCalledWith("claude"));
    actionIn(codex).click();
    await vi.waitFor(() => expect(m.install)
      .toHaveBeenCalledWith(`npm install -g --prefix "${PREFIX}" @agentclientprotocol/codex-acp`));
  });

  test("the second step is the default, and finishing hands the choice over", () => {
    const m = machine();
    const h = hooks(m, panelFor(m));
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
    const m = machine({ stateOf: () => "missing", definitions: () => [ { name: "codex", command: "codex-acp", args: [] } ] });
    const h = hooks(m, panelFor(m));
    showOnboarding(h);

    $("ob-next").click();
    expect($("ob-note").textContent).toContain("Nothing is ready");
    $("ob-next").click();
    expect(h.onFinish).toHaveBeenCalledWith(undefined);
  });
});

// One agent, one answer about it, whichever door somebody came through. Two
// drawings of the same state that can drift apart is what this replaces: an
// install running in one and offered again in the other starts it twice.
describe("the setup and the agents panel, one answer", () => {
  test("the overlay draws no agent of its own", () => {
    const m = machine();
    const panel = panelFor(m);
    const drawn: HTMLElement[] = [];
    showOnboarding(hooks(m, panel, {
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
    const m = machine();
    const panel = panelFor(m);
    panel.render();
    showOnboarding(hooks(m, panel));

    expect(rows().map(saysIn)).toEqual([ "ready", "missing" ]);
    expect(cards().map(saysIn)).toEqual(rows().map(saysIn));
    expect(cards().map((el) => actionIn(el).textContent))
      .toEqual(rows().map((el) => actionIn(el).textContent));
    // And the footer of the sidebar carries the same answer in one line.
    expect($("agents-open").textContent).toBe("Claude · ready");
  });

  test("an agent that is running is running in both", async () => {
    const m = machine();
    const panel = panelFor(m);
    await panel.start("claude");
    panel.render();
    showOnboarding(hooks(m, panel));

    expect(rows().map(saysIn)).toEqual([ "running", "missing" ]);
    expect(cards().map(saysIn)).toEqual([ "running", "missing" ]);
    expect(cards().map((el) => actionIn(el).textContent)).toEqual([ "Stop", "Install" ]);
  });

  test("an install started in the agents panel is busy in the overlay too", async () => {
    let finish = () => {};
    const m = machine({
      install: vi.fn(() => new Promise((r) => {
        finish = () => r({ ok: true, code: 0, stdoutTail: "", stderrTail: "" });
      })),
    });
    const panel = panelFor(m);
    panel.render();

    panel.install("codex");   // in flight, deliberately not awaited
    expect(saysIn(rows()[1])).toBe("installing…");
    expect(actionIn(rows()[1]).disabled).toBe(true);

    showOnboarding(hooks(m, panel));
    expect(saysIn(cards()[1])).toBe("installing…");
    expect(actionIn(cards()[1]).disabled).toBe(true);

    finish();
    await vi.waitFor(() => expect(panel.busy.has("codex")).toBe(false));
  });

  test("an install started in the setup is busy in the agents panel too", async () => {
    let finish = () => {};
    const m = machine({
      install: vi.fn(() => new Promise((r) => {
        finish = () => r({ ok: true, code: 0, stdoutTail: "", stderrTail: "" });
      })),
    });
    const panel = panelFor(m);
    panel.render();
    showOnboarding(hooks(m, panel));

    actionIn(cards()[1]).click();

    expect(panel.busy.get("codex")).toBe("installing…");
    expect(saysIn(cards()[1])).toBe("installing…");
    expect(saysIn(rows()[1])).toBe("installing…");

    finish();
    // What it did is the machine's to say, so the panel asks again when it ends.
    await vi.waitFor(() => expect(m.probe).toHaveBeenCalled());
    await vi.waitFor(() => expect(panel.busy.has("codex")).toBe(false));
  });
});
