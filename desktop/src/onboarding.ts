// The first run, asked once: which agent does this person have, and which of
// the ready ones do they address by default. Two steps, because they are two
// questions — what the machine has, and what the person prefers.

import { anyReady, type OnboardingCard } from "./rules";

export interface OnboardingHooks {
  /// Fresh answers from the machine, asked on every render — an install that
  /// just finished must change what its card says without a restart.
  cards: () => OnboardingCard[];
  /// The agents panel's drawing of one agent, borrowed rather than copied: the
  /// state, the command and the action are its answers, and an install started
  /// here is the same install the panel is showing. `refresh` is how the card
  /// asks this overlay to draw itself again.
  agentCard: (card: OnboardingCard, refresh: () => void) => HTMLElement;
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
    // The first step is the panel's own cards: the same agent, the same state,
    // the same one action — setup is another door into that room, not a room
    // of its own. The second step is this overlay's question and nobody else's.
    for (const card of cards) {
      box.append(step === 0 ? hooks.agentCard(card, render) : defaultCard(card));
    }
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
