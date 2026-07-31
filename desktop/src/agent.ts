// The local agents, over ACP. They run on this machine, under this person's
// credentials — the server never sees them.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { sessionKey, translateAcp, type AgentDef, type ConfigOption, type Update } from "./rules";
export type { Update };

export interface RailConfig { url: string; token: string }

export class Agents {
  private sessions = new Map<string, string>();        // agent+channel -> ACP session id
  private configs = new Map<string, ConfigOption[]>(); // agent+channel -> its options
  private live = new Set<string>();

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

  /// Where this session works. Derived from who is working, with which agent,
  /// in which channel — the agent never names its own directory.
  workspace(user: string, name: string, channel: string) {
    return invoke<string>("agent_workspace", { user, name, channel });
  }

  /// What the run wrote or changed there, since the directory was opened.
  produced(workspace: string) {
    return invoke<Array<{ path: string; bytes: number }>>("agent_produced", { workspace });
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

  async stop(name?: string) {
    await invoke("agent_stop", { name });
    if (name) {
      this.live.delete(name);
      for (const key of [...this.sessions.keys()]) {
        if (key.startsWith(sessionKey(name, ""))) this.sessions.delete(key);
      }
    } else {
      this.live.clear();
      this.sessions.clear();
    }
  }

  /// One session per agent per channel — the memory scope and the session scope
  /// are the same thing, and two agents in one room must not share a session id.
  /// The rail is mounted per channel too, so an agent cannot reach another room
  /// even if it tries.
  async sessionFor(name: string, slug: string, cwd: string, rail?: RailConfig): Promise<string> {
    const key = sessionKey(name, slug);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const mcpServers = rail
      ? [ { name: "workroom", type: "http", url: rail.url,
            headers: { Authorization: `Bearer ${rail.token}` } } ]
      : [];

    const res = await invoke<{ sessionId: string; configOptions?: ConfigOption[] }>(
      "agent_new_session", { name, cwd, mcpServers });
    this.sessions.set(key, res.sessionId);
    this.configs.set(key, res.configOptions ?? []);
    return res.sessionId;
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
  exportSession(name: string, sessionId: string) {
    const command = this.defs.find((d) => d.name === name)?.command;
    return invoke<string | null>("agent_export_session", { sessionId, command });
  }

  sessionIdFor(name: string, slug: string) { return this.sessions.get(sessionKey(name, slug)); }

  prompt(name: string, sessionId: string, text: string,
         context: string | null, history: string | null = null) {
    return invoke<{ stopReason?: string }>("agent_prompt",
      { name, sessionId, text, context, history });
  }

  /// Translate ACP notifications into something the room can display.
  onUpdate(handler: (u: Update) => void) {
    return listen<any>("acp://notify", (ev) => {
      const update = translateAcp(ev.payload);
      if (update) handler(update);
    });
  }
}
