// The first run, asked once: which agent does this person have, and which of
// the ready ones do they address by default. Two steps, because they are two
// questions — what the machine has, and what the person prefers.

import { anyReady, type OnboardingCard } from "./rules";

export interface OnboardingHooks {
  /// Fresh answers from the machine, asked on every render — an install that
  /// just finished must change what its card says without a restart.
  cards: () => OnboardingCard[];
  /// The exact command an install would run, shown before it runs. Null for
  /// the one that ships in the bundle — there is nothing to fetch.
  installCommand: (name: string) => string | null;
  onInstall: (name: string) => Promise<void>;
  onToggle: (name: string) => Promise<void>;
  /// The default chosen on the second step, when one was.
  onFinish: (picked: string | undefined) => void;
  /// The choice already made, when setup is run again from the agents panel.
  initialPicked?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// The two questions, in order. Named so the chrome can say where it is.
const STEPS = [
  { title: "Your agent", note: "Each person here works alongside their own agent, on their own machine. Install or start one — it answers when you address it in a channel." },
  { title: "The default", note: "When you address @agent without a name, this is the one that answers." },
] as const;

export function showOnboarding(hooks: OnboardingHooks): void {
  const overlay = $("onboarding");
  let step = 0;
  let picked = hooks.initialPicked;
  const busy = new Map<string, string>();

  function render() {
    const cards = hooks.cards();
    $("ob-title").textContent = STEPS[step].title;
    $("ob-note").textContent = step === 1 && !anyReady(cards)
      ? "Nothing is ready yet — finish anyway and install one later from the agents panel."
      : STEPS[step].note;
    $("ob-dots").textContent = `${step + 1} of ${STEPS.length}`;
    $("ob-back").hidden = step === 0;
    $("ob-next").textContent = step === STEPS.length - 1 ? "Finish" : "Continue";

    const box = $("ob-cards");
    box.innerHTML = "";
    for (const card of cards) box.append(step === 0 ? setupCard(card) : defaultCard(card));
  }

  function setupCard(card: OnboardingCard): HTMLElement {
    const el = document.createElement("div");
    el.className = "ob-card";

    const head = document.createElement("div");
    head.className = "ob-card-head";
    head.append(Object.assign(document.createElement("strong"), { textContent: card.label }));
    head.append(Object.assign(document.createElement("span"), {
      className: "muted",
      textContent: busy.has(card.name) ? busy.get(card.name)!
        : card.running ? "running" : card.state,
    }));

    el.append(head);

    const command = hooks.installCommand(card.name);
    if (card.action === "install" && command) {
      // The exact command, before it runs — an application that installs
      // something without saying what has asked for trust it has not earned.
      // The card is narrower than the command, so the full text is the title.
      el.append(Object.assign(document.createElement("code"),
        { className: "muted", textContent: command, title: command }));
    }

    const action = document.createElement("button");
    action.className = card.action === "install" ? "" : "ghost";
    action.disabled = busy.has(card.name);
    action.textContent = card.action === "install" ? "Install"
      : card.action === "start" ? "Start" : "Stop";
    action.onclick = async () => {
      busy.set(card.name, card.action === "install" ? "installing…" : "starting…");
      render();
      try {
        if (card.action === "install") await hooks.onInstall(card.name);
        else await hooks.onToggle(card.name);
      } finally {
        busy.delete(card.name);
        render();
      }
    };
    el.append(action);
    return el;
  }

  function defaultCard(card: OnboardingCard): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `ob-card pickable${picked === card.name ? " chosen" : ""}`;
    el.disabled = card.state !== "ready";
    el.append(Object.assign(document.createElement("strong"), { textContent: card.label }));
    el.append(Object.assign(document.createElement("span"), {
      className: "muted",
      textContent: card.state === "ready" ? (card.running ? "running" : "ready") : "not installed",
    }));
    el.onclick = () => { picked = card.name; render(); };
    return el;
  }

  $("ob-back").onclick = () => { step = Math.max(0, step - 1); render(); };
  $("ob-next").onclick = () => {
    if (step < STEPS.length - 1) { step += 1; render(); return; }
    overlay.hidden = true;
    hooks.onFinish(picked);
  };

  overlay.hidden = false;
  render();
}
