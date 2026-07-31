// The local agent, over ACP. Runs on this machine, under this person's
// credentials — the server never sees them.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { translateAcp, type Update } from "./rules";
export type { Update };

export interface RailConfig { url: string; token: string }

export class Agent {
  private sessions = new Map<string, string>();   // channel slug -> ACP session id
  running = false;

  async start(command?: string) {
    await invoke("agent_start", { command: command ?? "opencode", args: ["acp"] });
    this.running = true;
  }

  async stop() {
    await invoke("agent_stop");
    this.running = false;
    this.sessions.clear();
  }

  /// One session per channel — the memory scope and the session scope are the
  /// same thing. The rail is mounted per channel too, so the agent cannot reach
  /// another room even if it tries.
  async sessionFor(slug: string, cwd: string, rail?: RailConfig): Promise<string> {
    const existing = this.sessions.get(slug);
    if (existing) return existing;

    const mcpServers = rail
      ? [ { name: "workroom", type: "http", url: rail.url,
            headers: { Authorization: `Bearer ${rail.token}` } } ]
      : [];

    const res = await invoke<{ sessionId: string }>("agent_new_session", { cwd, mcpServers });
    this.sessions.set(slug, res.sessionId);
    return res.sessionId;
  }

  /// `context` is what the room knows; `history` is what was just said in it,
  /// including by other people. Both are the channel's, not the agent's.
  /// The agent's own record, when it keeps one. Null means this agent has no
  /// exporter — not an error.
  exportSession(sessionId: string, command?: string) {
    return invoke<string | null>("agent_export_session", { sessionId, command });
  }

  /// The ACP session id for a channel, if one is open.
  sessionIdFor(slug: string) { return this.sessions.get(slug); }

  prompt(sessionId: string, text: string, context: string | null, history: string | null = null) {
    return invoke<{ stopReason?: string }>("agent_prompt", { sessionId, text, context, history });
  }

  /// Translate ACP notifications into something the room can display.
  onUpdate(handler: (u: Update) => void) {
    return listen<any>("acp://notify", (ev) => {
      const update = translateAcp(ev.payload);
      if (update) handler(update);
    });
  }
}
