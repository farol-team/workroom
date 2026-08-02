// The agents panel: what this person has, the state each one is really in, and
// the single thing to do about it. The first-run setup is another door into the
// same room, so the drawing of one agent lives here and is lent to the overlay
// — an install running behind one door must not be offered again behind the other.

import type { Agents } from "./agent";
import type { Channel } from "./api";
import { installCommand, profileFor } from "./agents/catalog";
import { activeAgent, onboardingCards, selectable, type OnboardingCard } from "./rules";
import * as settings from "./settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AgentsPanelDeps {
  agents: Agents;
  /// Where installs go: a directory this application owns, and the same one the
  /// bridge looks in. Asked for each time because it arrives after the room.
  prefix: () => string;
  /// The session of an agent that has just started, opened in the room on
  /// screen. Where that room works is not the panel's to know.
  openSession: (name: string) => Promise<void>;
  /// Something the person has to be told: an install npm refused, an agent that
  /// would not start. What was said, not that something went wrong.
  onTrouble: (message: string) => void;
  /// The room on screen, when there is one — session options are per channel,
  /// because a cheap model here and an expensive one there is the point.
  currentChannel?: () => Channel | null;
}

export interface AgentsPanel {
  render(): void;
  renderOptions(): void;
  /// Ask the machine which of these agents it actually has, then draw.
  refresh(): Promise<void>;
  /// What the machine said about each agent, which is what both doors draw.
  cards(): OnboardingCard[];
  /// One agent, drawn. `refresh` redraws the surface it was drawn into, so a
  /// card in the overlay and a row in the panel both follow the same install.
  agentCard(card: OnboardingCard, refresh: () => void): HTMLElement;
  install(name: string): Promise<void>;
  toggle(name: string): Promise<void>;
  start(name: string): Promise<void>;
  pick(name: string): void;
  /// The one chosen, and the one the controls act on when nothing is.
  picked(): string | undefined;
  chosen(): string | undefined;
  /// What each agent is doing right now, when it is doing something. Held here
  /// rather than written into a row, because every render rebuilds it.
  busy: Map<string, string>;
}

export function createAgentsPanel(deps: AgentsPanelDeps): AgentsPanel {
  const { agents } = deps;
  const busy = new Map<string, string>();
  /// The one chosen, kept across windows — a choice that evaporates on restart
  /// reads as never having been offered.
  let picked: string | undefined = settings.loadPicked();

  const chosen = () => activeAgent(agents.definitions(), picked);

  function pick(name: string) {
    picked = name;
    settings.savePicked(name);
  }

  const cards = (): OnboardingCard[] =>
    onboardingCards(agents.definitions().map((d) => ({
      name: d.name,
      label: profileFor(d.name)?.label ?? d.name,
      state: agents.stateOf(d.name),
      running: agents.isRunning(d.name),
    })));

  /// The one command an install would run, or null where there is nothing to
  /// fetch — the agent that ships in the bundle is never offered one.
  function commandFor(card: OnboardingCard): string | null {
    if (card.action !== "install") return null;
    const profile = profileFor(card.name);
    const prefix = deps.prefix();
    return profile && prefix ? installCommand(profile, prefix) : null;
  }

  /// What is true about one agent right now. Both drawings read this and only
  /// this, so the setup and the panel can differ in shape and never in answer.
  function answerFor(card: OnboardingCard) {
    const command = commandFor(card);
    return {
      says: busy.get(card.name) ?? (card.running ? "running" : card.state),
      action: command ? "Install" : card.action === "stop" ? "Stop" : "Start",
      working: busy.has(card.name),
      command,
    };
  }

  /// The one press, wherever it was pressed. The surface that drew the button
  /// is redrawn at once — busy is a thing you have to see immediately — and
  /// again when the work ends.
  function press(card: OnboardingCard, command: string | null, refresh: () => void) {
    const done = command ? install(card.name) : toggle(card.name);
    refresh();
    done.finally(refresh);
  }

  function agentCard(card: OnboardingCard, refresh: () => void): HTMLElement {
    const answer = answerFor(card);
    const el = document.createElement("div");
    el.className = "ob-card";

    const head = document.createElement("div");
    head.className = "ob-card-head";
    head.append(Object.assign(document.createElement("strong"), { textContent: card.label }));
    head.append(Object.assign(document.createElement("span"),
                              { className: "muted", textContent: answer.says }));
    el.append(head);

    // The exact command, before it runs. The card is narrower than the command,
    // so the full text is the title.
    if (answer.command) {
      el.append(Object.assign(document.createElement("code"),
                              { className: "muted", textContent: answer.command,
                                title: answer.command }));
    }

    const action = document.createElement("button");
    action.className = answer.command ? "" : "ghost";
    action.disabled = answer.working;
    action.textContent = answer.action;
    action.onclick = () => press(card, answer.command, refresh);
    el.append(action);
    return el;
  }

  /// One row per agent: what it is called, the state it is really in, and the
  /// single thing to do about it. The state is the machine's answer — an agent
  /// reported as ready that is not there is worse than no panel at all.
  function render() {
    const box = $("agents");
    box.innerHTML = "";
    const list = cards();
    const one = chosen();

    agents.definitions().forEach((def, i) => {
      const card = list[i];
      const answer = answerFor(card);

      const row = document.createElement("div");
      row.className = "agent-row";

      // The name is how one of them is chosen — what the picker was for, and the
      // one thing the panel that replaced it did not carry over. Three agents are
      // listed for everybody now, so two running at once is ordinary, and the
      // second one's session options were reachable only by stopping the first.
      const name = document.createElement("button");
      name.className = `agent-name${def.name === one ? " chosen" : ""}`;
      name.textContent = card.label;
      name.title = `${[ def.command, ...def.args ].join(" ")} — press to address this one`;
      name.onclick = () => { pick(def.name); render(); renderOptions(); };

      const said = document.createElement("span");
      said.className = "muted";
      said.textContent = answer.says;

      const action = document.createElement("button");
      action.className = "ghost";
      action.disabled = answer.working;
      action.textContent = answer.action;
      action.onclick = () => press(card, answer.command, render);

      row.append(name, said, action);
      box.append(row);

      // The exact command, before it runs. An application that installs something
      // without saying what it is about to run has asked for trust it has not
      // earned — and the answer to "what did that do to my machine" is on screen.
      if (answer.command) {
        const shown = document.createElement("code");
        shown.className = "muted";
        shown.textContent = answer.command;
        shown.title = answer.command;
        box.append(shown);
      }
    });

    // The sidebar footer carries the same answer in one line, and is the way
    // into this panel. Nobody should have to open a dialog to learn whether
    // their agent is running.
    const chosenLabel = one ? (profileFor(one)?.label ?? one) : null;
    $("agents-open").textContent = chosenLabel
      ? `${chosenLabel} · ${agents.isRunning(one!) ? "running" : agents.stateOf(one!)}`
      : "Set up your agent";
  }

  /// Whatever the agent offers, rendered as it comes. Per channel, because the
  /// session is per channel — a cheap model here and an expensive one there.
  function renderOptions() {
    const box = $("session-options");
    box.innerHTML = "";
    const name = chosen();
    const current = deps.currentChannel?.() ?? null;
    if (!current || !name || !agents.isRunning(name)) return;

    for (const option of selectable(agents.configFor(name, current.slug))) {
      const label = document.createElement("label");
      label.className = "session-option";
      label.title = option.name;

      const select = document.createElement("select");
      for (const choice of option.options ?? []) {
        const el = document.createElement("option");
        el.value = choice.value;
        el.textContent = choice.name;
        el.selected = choice.value === option.currentValue;
        select.append(el);
      }
      select.onchange = async () => {
        select.disabled = true;
        try {
          agents.rememberConfig(name, current.slug,
            await agents.setConfig(name, current.slug, option.id, select.value));
        } catch (err) { deps.onTrouble(String(err)); }
        select.disabled = false;
        renderOptions();
      };

      label.append(select);
      box.append(label);
    }
  }

  /// Ask the machine which of these agents it actually has. Their state is what
  /// the panel is for, and a guess would be worse than the silence it replaced.
  async function refresh() {
    await agents.probe(agents.definitions().map((d) => d.command));
    render();
  }

  /// Fetch one agent, on an explicit press. One npm command into a prefix this
  /// application owns — nothing else on the machine is touched, and a failure
  /// says what npm said rather than that something went wrong.
  async function install(name: string) {
    const profile = profileFor(name);
    const prefix = deps.prefix();
    const command = profile && prefix ? installCommand(profile, prefix) : null;
    if (!command) return;

    busy.set(name, "installing…");
    render();
    try {
      const out = await agents.install(command);
      if (!out.ok) {
        deps.onTrouble(`${profile!.label} was not installed.\n\n${command}\n\n`
          + `${out.stderrTail || out.stdoutTail || `npm exited ${out.code}`}`);
      }
    } finally {
      busy.delete(name);
      // Whether it worked is the machine's to say, not the exit code's.
      await refresh();
    }
  }

  async function toggle(name: string) {
    pick(name);
    if (agents.isRunning(name)) {
      await agents.stop(name);
      render();
      return;
    }
    try {
      await start(name);
    } catch (err) {
      deps.onTrouble(`Could not start ${name}.\n\n${String(err)}`);
    }
  }

  /// Start one agent and open its session in the room that is on screen. Shared
  /// with the notice an agent leaves when its process ends (#93) — the person
  /// asks for the restart there, the same way they would here.
  async function start(name: string) {
    pick(name);
    busy.set(name, "starting…");
    render();
    try {
      await agents.start(name);
      busy.delete(name);
      render();
      await deps.openSession(name);
      renderOptions();
    } catch (err) {
      busy.delete(name);
      render();
      throw err;
    }
  }

  return {
    render, renderOptions, refresh, cards, agentCard, install, toggle, start, pick,
    picked: () => picked,
    chosen,
    busy,
  };
}
