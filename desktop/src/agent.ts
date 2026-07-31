// The local agent, over ACP. Runs on this machine, under this person's
// credentials — the server never sees them.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { translateAcp, type Update } from "./rules";
export type { Update };

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

  /// One session per channel — the memory scope and the session scope are the same thing.
  async sessionFor(slug: string, cwd: string): Promise<string> {
    const existing = this.sessions.get(slug);
    if (existing) return existing;
    const res = await invoke<{ sessionId: string }>("agent_new_session", { cwd, mcpServers: [] });
    this.sessions.set(slug, res.sessionId);
    return res.sessionId;
  }

  /// `context` is what the room knows; `history` is what was just said in it,
  /// including by other people. Both are the channel's, not the agent's.
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
