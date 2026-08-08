// The agents panel: what this person has, the state each one is really in, and
// the single thing to do about it. The first-run setup is another door into the
// same room, so the drawing of one agent lives here and is lent to the overlay
// — an install running behind one door must not be offered again behind the other.

import type { Channel } from "./api";
import { installCommand, profileFor } from "./agents/catalog";
import type { AgentRuntime } from "./agent-runtime";
import { activeAgent, onboardingCards, removeDefinition, selectable, splitArgs, upsertDefinition, type AgentDef, type OnboardingCard } from "./rules";
import * as settings from "./settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AgentsPanelDeps {
  agents: AgentRuntime;
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
  /// Hand a definition to the workspace (#233). The server refuses anybody who
  /// is not an admin, and the refusal arrives through onTrouble like any other.
  shareDefinition?: (def: AgentDef) => Promise<void>;
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
  /// fetch — an agent already on this machine, or one this project never
  /// pinned and therefore cannot name a package for.
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
  ///
  /// Nobody awaits a press, so this is the last place a refusal from the bridge
  /// can be caught. Without it a stop the machine would not do is a button that
  /// did nothing and said nothing.
  function press(card: OnboardingCard, command: string | null, refresh: () => void) {
    const done = command ? install(card.name) : toggle(card.name);
    refresh();
    done.catch((err) => deps.onTrouble(String(err))).finally(refresh);
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

      // The definition behind the row, editable at last (#231) — before this,
      // the only way to name your own agent was the developer console.
      const edit = document.createElement("button");
      edit.className = "ghost";
      edit.textContent = "Edit";
      edit.title = "The definition behind this row: name, command, arguments, default";
      edit.onclick = () => openEditor(def);

      // Before the action, which stays the row's last button — "the one thing
      // to do about an agent" is a contract the setup overlay reads too.
      row.append(name, said, edit, action);
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

  /// The editor over a definition's four fields. It never validates on its
  /// own: what survives a save is normalizeAgents' answer, the same rule the
  /// definitions file has always been read through.
  function openEditor(original?: AgentDef) {
    const dialog = $<HTMLDialogElement>("agent-editor");
    $("agent-editor-title").textContent = original ? `@${original.name}` : "An agent of your own";
    $<HTMLInputElement>("agent-editor-name").value = original?.name ?? "";
    $<HTMLInputElement>("agent-editor-command").value = original?.command ?? "";
    $<HTMLInputElement>("agent-editor-args").value = (original?.args ?? []).join(" ");
    $<HTMLTextAreaElement>("agent-editor-instruction").value = original?.instruction ?? "";
    $<HTMLInputElement>("agent-editor-model").value = original?.model ?? "";
    $<HTMLInputElement>("agent-editor-default").checked = Boolean(original?.default);

    // Said out loud because it is already true and invisible: the baseline
    // three come back whatever is saved, so removing one is a reset.
    const baseline = original && profileFor(original.name);
    $("agent-editor-note").textContent = baseline
      ? `${baseline.label} is one of the agents this project always lists — ` +
        "Remove returns the project's own definition."
      : "";

    const remove = $<HTMLButtonElement>("agent-editor-delete");
    remove.hidden = !original;
    remove.textContent = baseline ? "Reset" : "Remove";
    remove.onclick = () => {
      apply(settings.saveAgents(removeDefinition(settings.loadDefined(), original!.name)));
      dialog.close("removed");
    };

    /// The fields as they stand, or null while they do not make a definition.
    const drafted = (): AgentDef | null => {
      const name = $<HTMLInputElement>("agent-editor-name").value.trim();
      const command = $<HTMLInputElement>("agent-editor-command").value.trim();
      if (!name || !command) return null;
      return {
        name, command,
        args: splitArgs($<HTMLInputElement>("agent-editor-args").value),
        ...((v => v ? { instruction: v } : {})($<HTMLTextAreaElement>("agent-editor-instruction").value.trim())),
        ...((v => v ? { model: v } : {})($<HTMLInputElement>("agent-editor-model").value.trim())),
        ...($<HTMLInputElement>("agent-editor-default").checked ? { default: true } : {}),
      };
    };

    const share = $<HTMLButtonElement>("agent-editor-share");
    share.hidden = !deps.shareDefinition;
    share.onclick = async () => {
      const def = drafted();
      if (!def || !deps.shareDefinition) return;
      share.disabled = true;
      try {
        // Saved locally too — sharing something other than what you run would
        // hand colleagues a persona nobody has exercised.
        apply(settings.saveAgents(upsertDefinition(settings.loadDefined(), def)));
        await deps.shareDefinition(def);
        dialog.close("shared");
      } catch (err) {
        deps.onTrouble(`The workspace did not take @${def.name}. ${String(err)}`);
      } finally {
        share.disabled = false;
      }
    };

    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "save") return;
      const def = drafted();
      if (!def) return;
      const { name } = def;
      // A rename is a removal and an addition — the old name would otherwise
      // stay behind as a second agent nobody meant to keep.
      let defs = settings.loadDefined();
      if (original && original.name.toLowerCase() !== name.toLowerCase()) {
        defs = removeDefinition(defs, original.name);
      }
      apply(settings.saveAgents(upsertDefinition(defs, def)));
    }, { once: true });

    dialog.showModal();
  }

  /// What the application runs from now on: the normalized list, probed so the
  /// new row says the state its command is really in.
  function apply(normalized: AgentDef[]) {
    agents.use(normalized);
    void refresh();
  }

  // Absent in surfaces that mount only part of the page — the overlay's specs
  // draw the panel without the dialog chrome.
  const adder = document.getElementById("agent-add");
  if (adder) adder.onclick = () => openEditor();

  return {
    render, renderOptions, refresh, cards, agentCard, install, toggle, start, pick,
    picked: () => picked,
    chosen,
    busy,
  };
}
