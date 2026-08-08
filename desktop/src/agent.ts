// The local agents, over ACP. They run on this machine, under this person's
// credentials — the server never sees them.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { forget, keysOf, mcpServersFor, type ContextStore, permissionAsked, recall, remember, sessionKey, sessionOf, transcriptName, transcriptOf, updateOf, type AgentDef, type Asked, type ConfigOption, type TurnOutcome, type TurnProduced, type Update } from "./rules";
import { stateOf as stateOfCommand, type AgentState } from "./agents/catalog";
export type { Update };

export interface RailConfig { url: string; token: string }

/// What an install did. `ok` is the whole answer when it worked; the rest is
/// there for when it did not.
export interface InstallResult {
  ok: boolean;
  code: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export class Agents {
  private sessions = new Map<string, string>();        // agent+channel -> ACP session id
  private configs = new Map<string, ConfigOption[]>(); // agent+channel -> its options
  private dirs = new Map<string, string>();            // agent+channel -> where it works
  private lastRun = new Map<string, number>();         // ACP session id -> newest run
  private live = new Set<string>();

  /// How a taken transcript leaves this machine — set by the shell, because the
  /// server client lives there. Unset means transcripts are not kept, which is
  /// what headless uses of this class get.
  attachTranscript?: (runId: number, name: string, body: string) => Promise<void>;

  /// The run this session most recently answered. The artifact endpoint is
  /// run-scoped, and the last run of a session is the truthful anchor for its
  /// record (#124).
  noteRun(sessionId: string, runId: number) {
    this.lastRun.set(sessionId, runId);
  }
  private remembered: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem("workroom.sessions") ?? "{}"); } catch { return {}; }
  })();

  constructor(private defs: AgentDef[] = []) {}

  definitions() { return this.defs; }
  use(defs: AgentDef[]) { this.defs = defs; }
  isRunning(name: string) { return this.live.has(name); }
  get running(): string[] { return [...this.live]; }

  /// Start one agent by name. Its command comes from the person's own
  /// definitions — the client never invents one.
  async start(name: string) {
    const def = this.defs.find((d) => d.name === name);
    if (!def) throw new Error(`no agent named ${name}`);
    await invoke("agent_start", { name, command: def.command, args: def.args });
    this.live.add(name);
  }

  /// Where each of these commands is on this machine, as the bridge looks for
  /// one: our own prefix, and then the person's PATH. Kept, because the panel
  /// asks on every render and a machine does not change under it — what changes
  /// it is an install, and that re-probes.
  private located = new Map<string, string | null>();

  async probe(commands: string[]) {
    const where = await invoke<Array<string | null>>("agent_probe", { commands });
    commands.forEach((command, i) => this.located.set(command, where[i] ?? null));
  }

  /// Fetch one agent. The command is the catalog's, and the caller has already
  /// put it in front of somebody — this only runs it.
  install(command: string) {
    return invoke<InstallResult>("agent_install", { command });
  }

  /// Whether an agent can be addressed. An agent nobody pinned is judged the
  /// same way as one this project named: by whether the machine has its command.
  stateOf(name: string): AgentState {
    const command = this.defs.find((d) => d.name === name)?.command;
    return stateOfCommand((command && this.located.get(command)) || null);
  }

  /// Where this session works: `~/WorkRoom/<workspace>/<channel>`, derived
  /// from the room — the agent never names its own directory.
  workspace(room: string, channel: string) {
    return invoke<string>("agent_workspace", { workspace: room, channel });
  }

  /// Mark where a turn begins, so the offer can tell the run's work from
  /// what was already dirty when it started (#202).
  turnStart(workspace: string) {
    return invoke<void>("agent_turn_start", { workspace });
  }

  /// What the run wrote or changed since the turn began — and how many
  /// changed paths were held back as pre-existing.
  produced(workspace: string) {
    return invoke<TurnProduced>("agent_produced", { workspace });
  }

  /// One produced file, base64 — a work product is not always text.
  read(workspace: string, path: string) {
    return invoke<string>("agent_read", { workspace, path });
  }

  /// What the Rust side says is running — the registry outlives this view.
  async listRunning(): Promise<string[]> {
    return invoke<string[]>("agent_list");
  }

  markRunning(name: string) { this.live.add(name); }

  /// Close a session the agent still holds. Killing the process is not the same
  /// act — an open session keeps its rail registered as an MCP server and leaves
  /// a row in the agent's own storage (#95). Answers false where the agent never
  /// said it could close one, which is not a failure.
  closeSession(name: string, sessionId: string) {
    return invoke<boolean>("agent_close_session", { name, sessionId });
  }

  /// Sessions this agent is holding right now, with the channels they belong to.
  private held(name: string): Array<[string, string]> {
    return keysOf(name, this.sessions.keys())
      .map((key) => [ key, this.sessions.get(key) ] as [string, string])
      .filter(([ , id ]) => Boolean(id));
  }

  async stop(name?: string) {
    // Closed before the process is killed, or they are not closed at all. A
    // failure here is not a reason to keep an agent somebody asked to stop.
    const closing = name ? this.held(name) : [];
    // The session's record is final here (#95), so it is taken first — and a
    // transcript that could not be taken is a console line, never a reason to
    // keep an agent running that somebody asked to stop (#124).
    await Promise.allSettled(closing.map(([ key, id ]) => this.keepTranscript(name!, key, id)));
    await Promise.allSettled(closing.map(([ , id ]) => this.closeSession(name!, id)));

    await invoke("agent_stop", { name });
    if (name) {
      this.dropped(name);
    } else {
      this.live.clear();
      this.sessions.clear();
      this.configs.clear();
      this.dirs.clear();
      this.lastRun.clear();
    }
  }

  /// The channel this session was opened for now works somewhere else, so the
  /// session belongs to nothing. Closing on a channel *switch* would be wrong —
  /// a session is meant to outlive the window, which is the whole of #81.
  async releaseChannel(slug: string) {
    for (const name of [ ...this.live ]) {
      const key = sessionKey(name, slug);
      const id = this.sessions.get(key);
      if (!id) continue;

      // The other moment a session's record is final (#95, #124).
      await this.keepTranscript(name, key, id);
      await this.closeSession(name, id).catch(() => {});
      this.sessions.delete(key);
      this.configs.delete(key);
      this.dirs.delete(key);
      this.lastRun.delete(id);
      forget(this.remembered, name, slug);
    }
    this.persist();
  }

  /// The session's transcript, attached to its newest run. Two ways to obtain
  /// one behind one function: the vendor's own `export` where the command
  /// publishes it, and otherwise a replay through `session/load`, collected
  /// rather than shown (#124). Never throws — the record is worth taking and
  /// not worth blocking a stop over.
  private async keepTranscript(name: string, key: string, sessionId: string): Promise<void> {
    try {
      const runId = this.lastRun.get(sessionId);
      const attach = this.attachTranscript;
      if (!runId || !attach) return;
      const body = await this.record(name, key, sessionId);
      if (!body) return;
      await attach(runId, transcriptName(sessionId, new Date()), body);
    } catch (err) {
      console.error(`transcript for ${sessionId} was not kept: ${String(err)}`);
    }
  }

  private async record(name: string, key: string, sessionId: string): Promise<string | null> {
    const exported = await this.exportSession(name, sessionId).catch(() => null);
    if (exported) return exported;

    // The protocol's own door: `session/load` replays the history as ordinary
    // updates. The collector owns the session id while the replay runs (#91),
    // which is what keeps a record of the room out of the room.
    const cwd = this.dirs.get(key);
    if (!cwd) return null;
    const collector = await this.collect(sessionId);
    try {
      await invoke("agent_load_session", { name, sessionId, cwd, mcpServers: [], replay: true });
      const heard = collector.stop();
      return heard.length ? transcriptOf(sessionId, new Date().toISOString(), heard) : null;
    } catch {
      collector.stop();
      return null;
    }
  }

  /// Everything a session says, kept in arrival order instead of shown. It
  /// registers in the same dispatcher a live turn uses, so a session being
  /// collected is not a session anybody is prompting.
  async collect(sessionId: string): Promise<{ stop(): Update[] }> {
    await this.dispatch();
    const heard: Update[] = [];
    this.updating.set(sessionId, (u) => { heard.push(u); });
    return {
      stop: () => {
        this.updating.delete(sessionId);
        return heard;
      },
    };
  }

  /// One session per agent per channel — the memory scope and the session scope
  /// are the same thing, and two agents in one room must not share a session id.
  /// The rail is mounted per channel too, so an agent cannot reach another room
  /// even if it tries.
  async sessionFor(name: string, slug: string, cwd: string, rail?: RailConfig,
                   store?: ContextStore | null): Promise<string> {
    const key = sessionKey(name, slug);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const mcpServers = mcpServersFor(rail, store);

    // A session this person had before the app was closed. Picking it up is
    // attempted, never required: an agent that has forgotten it, or one that
    // cannot load a session at all, means a new session — which is what
    // happened before any of this existed.
    const known = recall(this.remembered, name, slug);
    if (known) {
      try {
        const res = await invoke<{ configOptions?: ConfigOption[] }>(
          "agent_load_session", { name, sessionId: known, cwd, mcpServers });
        this.sessions.set(key, known);
        this.configs.set(key, res?.configOptions ?? []);
        this.dirs.set(key, cwd);
        return known;
      } catch {
        forget(this.remembered, name, slug);
        this.persist();
      }
    }

    const res = await invoke<{ sessionId: string; configOptions?: ConfigOption[] }>(
      "agent_new_session", { name, cwd, mcpServers });
    this.sessions.set(key, res.sessionId);
    this.configs.set(key, res.configOptions ?? []);
    this.dirs.set(key, cwd);
    remember(this.remembered, name, slug, res.sessionId);
    this.persist();
    // The definition's model is the session's starting point (#232): applied
    // once at birth — never on a resumed session — so the per-channel override
    // the session options offer survives every later turn. An agent with no
    // model option simply keeps its own default; that is not a failure.
    const wanted = this.defs.find((d) => d.name === name)?.model;
    if (wanted) await this.setConfig(name, slug, "model", wanted).catch(() => {});
    return res.sessionId;
  }

  private persist() {
    try { localStorage.setItem("workroom.sessions", JSON.stringify(this.remembered)); } catch { /* a preference, not the record */ }
  }

  /// Options are per session and therefore per agent and channel: a cheap model
  /// in one room and an expensive one in another, without reconfiguring anything.
  configFor(name: string, slug: string): ConfigOption[] {
    return this.configs.get(sessionKey(name, slug)) ?? [];
  }

  async setConfig(name: string, slug: string, configId: string, value: string): Promise<ConfigOption[]> {
    const sessionId = this.sessions.get(sessionKey(name, slug));
    if (!sessionId) return [];
    const res = await invoke<{ configOptions?: ConfigOption[] }>("agent_set_config",
      { name, sessionId, configId, value });
    const options = res.configOptions ?? [];
    this.configs.set(sessionKey(name, slug), options);
    return options;
  }

  rememberConfig(name: string, slug: string, options: ConfigOption[]) {
    this.configs.set(sessionKey(name, slug), options);
  }

  modelFor(name: string, slug: string): string | undefined {
    return this.configFor(name, slug).find((o) => o.id === "model")?.currentValue;
  }

  /// The agent's own record, when it keeps one. Null means this agent has no
  /// exporter — not an error.
  private exportSession(name: string, sessionId: string) {
    const command = this.defs.find((d) => d.name === name)?.command;
    return invoke<string | null>("agent_export_session", { sessionId, command });
  }

  /// The reply is the run's own summary — stop reason, token usage, vendor
  /// extras — and it is the caller's to record, not this class's to drop (#97).
  prompt(name: string, sessionId: string, text: string,
         context: string | null, history: string | null = null) {
    return invoke<TurnOutcome>("agent_prompt",
      { name, sessionId, text, context, history });
  }

  /// Ask the agent to give up the turn it is on. The turn ends as a failure with
  /// its steps intact and the session stays open — the difference between this
  /// and stopping the agent, which takes every other channel's turn with it.
  cancel(name: string, sessionId: string) {
    return invoke("agent_cancel", { name, sessionId });
  }

  /// One dispatcher owns both inbound events and hands each message to the turn
  /// that owns its session id. Registering a listener per turn meant every turn
  /// heard every session: two channels working at once spliced each other's
  /// answers together, and a permission dialog for one agent was shown as
  /// though the other had asked (#91).
  private updating = new Map<string, (u: Update) => void>();
  private asking = new Map<string, (a: Asked) => void>();
  private dispatching?: Promise<void>;

  private async dispatch() {
    this.dispatching ??= (async () => {
      // One stream, three destinations. The bridge tags every event with its
      // session and its agent, so the routing that used to need two listeners
      // and a parser is a switch (#312).
      await listen<any>("acp://event", (ev) => {
        const payload = ev.payload;

        if (payload?.kind === "closed") {
          const name = typeof payload.agent === "string" ? payload.agent : undefined;
          if (name) this.dropped(name);
          for (const handler of this.closing) {
            handler({ name, diagnostics: payload.diagnostics ?? [] });
          }
          return;
        }

        if (payload?.kind === "permission") {
          const asked = permissionAsked(payload);
          if (!asked) return;
          const to = asked.sessionId ? this.asking.get(asked.sessionId) : undefined;
          if (to) to(asked);
          // Not dropped. The agent is blocked on this and always will be, and
          // a question nobody can see is the hang #92 exists to make visible.
          else this.unclaimed("permission request", asked.sessionId, payload);
          return;
        }

        const update = updateOf(payload);
        if (!update) return;
        const session = sessionOf(payload);
        const to = session ? this.updating.get(session) : undefined;
        if (to) to(update);
        else this.unclaimed("update", session, payload);
      });
    })();
    return this.dispatching;
  }

  /// A message for a session nobody is running. Worth recording rather than
  /// dropping silently — it means a turn ended while its agent was still
  /// talking, or a session outlived the code that opened it.
  private unclaimed(kind: string, session: string | undefined, payload: unknown) {
    this.strays.push({ kind, session, payload, at: new Date().toISOString() });
    if (this.strays.length > 50) this.strays.shift();
  }

  readonly strays: Array<{ kind: string; session?: string; payload: unknown; at: string }> = [];

  /// The agent asking to do something. It is blocked until somebody answers,
  /// so this is the one event that must not be dropped.
  async onAsk(sessionId: string, handler: (asked: Asked) => void) {
    await this.dispatch();
    this.asking.set(sessionId, handler);
    return () => { this.asking.delete(sessionId); };
  }

  /// The person's answer. No option id means they declined to choose, which the
  /// protocol calls cancelled.
  permit(name: string, requestId: unknown, optionId: string | null) {
    return invoke("agent_permit", { name, requestId, optionId });
  }

  /// Translate ACP notifications into something the room can display, for the
  /// one turn they belong to.
  async onUpdate(sessionId: string, handler: (u: Update) => void) {
    await this.dispatch();
    this.updating.set(sessionId, handler);
    return () => { this.updating.delete(sessionId); };
  }

  /// The agent's process ended. Nothing listened for this, so the sidebar went
  /// on offering an agent that was gone and the next `@agent` failed with "no
  /// agent is running" in a room that had shown it as available (#93).
  ///
  /// Restarting is the person's to ask for. An agent that respawns itself under
  /// somebody's credentials without being asked is what #69 was careful not to
  /// do with updates.
  async onClosed(handler: (e: { name?: string; diagnostics: string[] }) => void) {
    await this.dispatch();
    this.closing.push(handler);
    return () => {
      const at = this.closing.indexOf(handler);
      if (at >= 0) this.closing.splice(at, 1);
    };
  }

  /// Who wants to hear that an agent stopped. A list rather than a listener of
  /// its own: everything the agent says now arrives on one stream.
  private closing: Array<(e: { name?: string; diagnostics: string[] }) => void> = [];

  /// Forget an agent that is no longer running: its name, its sessions and the
  /// options that belonged to them. A session id outliving its process is a
  /// resumption that cannot happen.
  private dropped(name: string) {
    this.live.delete(name);
    for (const key of keysOf(name, this.sessions.keys())) {
      const id = this.sessions.get(key);
      if (id) this.lastRun.delete(id);
      this.sessions.delete(key);
    }
    for (const key of keysOf(name, this.configs.keys())) this.configs.delete(key);
    for (const key of keysOf(name, this.dirs.keys())) this.dirs.delete(key);
  }
}
