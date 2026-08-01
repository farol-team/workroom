import { beforeEach, describe, expect, test, vi } from "vitest";
import { showOnboarding, type OnboardingHooks } from "../src/onboarding";
import { onboardingCards } from "../src/rules";

// The overlay's half of index.html — the ids showOnboarding looks up. Kept in
// step with the real markup by hand, the way the preview keeps its selectors.
const MARKUP = `
  <div id="onboarding" hidden>
    <h2 id="ob-title"></h2><p id="ob-note"></p><div id="ob-cards"></div>
    <span id="ob-dots"></span>
    <button id="ob-back" hidden></button><button id="ob-next"></button>
  </div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function hooks(over: Partial<OnboardingHooks> = {}): OnboardingHooks {
  return {
    cards: () => onboardingCards([
      { name: "claude", label: "Claude", state: "ready", running: false },
      { name: "codex", label: "Codex", state: "missing", running: false },
    ]),
    installCommand: (name) => name === "codex" ? `npm install -g codex-acp` : null,
    onInstall: vi.fn(async () => {}),
    onToggle: vi.fn(async () => {}),
    onFinish: vi.fn(),
    ...over,
  };
}

beforeEach(() => { document.body.innerHTML = MARKUP; });

describe("the first-run setup", () => {
  test("the first step is what the machine has, with each card's one action", () => {
    showOnboarding(hooks());

    expect($("onboarding").hidden).toBe(false);
    expect($("ob-title").textContent).toBe("Your agent");
    expect($("ob-dots").textContent).toBe("1 of 2");

    const actions = [ ...document.querySelectorAll("#ob-cards .ob-card > button:last-child") ]
      .map((b) => b.textContent);
    expect(actions).toEqual([ "Start", "Install" ]);
    // The command is shown before it runs.
    expect(document.querySelector("#ob-cards code")?.textContent).toContain("npm install");
  });

  test("a card's action is the panel's action", async () => {
    const h = hooks();
    showOnboarding(h);

    const [ start, install ] = [ ...document.querySelectorAll<HTMLButtonElement>("#ob-cards .ob-card > button:last-child") ];
    start.click();
    await vi.waitFor(() => expect(h.onToggle).toHaveBeenCalledWith("claude"));
    install.click();
    await vi.waitFor(() => expect(h.onInstall).toHaveBeenCalledWith("codex"));
  });

  test("the second step is the default, and finishing hands the choice over", () => {
    const h = hooks();
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
    const h = hooks({
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
