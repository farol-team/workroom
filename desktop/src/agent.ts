// The local agent, over ACP. Runs on this machine, under this person's
// credentials — the server never sees them.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Update =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "other"; label: string };

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
      const msg = ev.payload;
      if (msg?.method !== "session/update") return;
      const u = msg.params?.update ?? {};
      const t = u.sessionUpdate;

      if (t === "agent_message_chunk") {
        const text = u.content?.text ?? "";
        if (text) handler({ kind: "text", text });
      } else if (t === "tool_call" || t === "tool_call_update") {
        handler({ kind: "tool", label: u.title ?? u.kind ?? u.toolCallId ?? "tool" });
      } else if (t) {
        handler({ kind: "other", label: String(t) });
      }
    });
  }
}
