// Client for the WorkRoom server. Holds the session token; never a model key.

export type Author =
  | { kind: "user"; id: number; name: string; email: string }
  | { kind: "agent"; id: number; name: string; agent_kind: string; run_id: number };

export interface Message {
  id: number; channel_id: number; parent_id: number | null;
  body: string; author: Author; created_at: string;
}

export interface Channel {
  id: number; slug: string; name: string; purpose: string | null;
  visibility: string; memory_uri: string;
  message_count: number; memory_count: number;
}

export { ADDRESS, parseAddress } from "./rules";

export class Api {
  constructor(public base = "http://127.0.0.1:3000", public token = "") {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.status === 204 ? (undefined as T) : res.json();
  }

  async signIn(email: string) {
    const r = await this.call<{ token: string; user: { name: string } }>("/auth", {
      method: "POST", body: JSON.stringify({ email }),
    });
    this.token = r.token;
    return r;
  }

  channels() { return this.call<Channel[]>("/channels"); }

  /// The channel's capability rail, as the agent should mount it.
  rail(slug: string) {
    return { url: `${this.base}/api/rail/${slug}`, token: this.token };
  }

  channel(slug: string) {
    return this.call<Channel & { messages: Message[] }>(`/channels/${slug}`);
  }

  /// What the room knows, ready to prepend to an agent turn.
  context(slug: string) {
    return this.call<{ context: string | null; memory_uri: string }>(`/channels/${slug}/context`);
  }

  memory(slug: string) {
    return this.call<Array<{ id: number; title: string; overview: string; trust: string }>>(
      `/channels/${slug}/memory`);
  }

  remember(slug: string, title: string, detail: string) {
    return this.call(`/channels/${slug}/memory`, {
      method: "POST", body: JSON.stringify({ title, detail, trust: "human" }),
    });
  }

  post(slug: string, body: string) {
    return this.call<Message>(`/channels/${slug}/messages`, {
      method: "POST", body: JSON.stringify({ body }),
    });
  }

  startRun(slug: string, triggerMessageId: number, externalId: string) {
    return this.call<{ id: number; agent_session_id: number }>(`/channels/${slug}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger_message_id: triggerMessageId, agent_kind: "opencode", external_id: externalId }),
    });
  }

  step(runId: number, kind: string, label: string) {
    return this.call(`/runs/${runId}/steps`, {
      method: "POST", body: JSON.stringify({ kind, label }),
    });
  }

  agentSay(runId: number, body: string) {
    return this.call<Message>(`/runs/${runId}/messages`, {
      method: "POST", body: JSON.stringify({ body }),
    });
  }

  finishRun(runId: number, status: string) {
    return this.call(`/runs/${runId}`, { method: "PATCH", body: JSON.stringify({ status }) });
  }

  /// Two streams. The room carries what the room shares; the user stream
  /// carries what only its owner needs — their own steps, whatever level they chose.
  live(slug: string, onEvent: (e: any) => void) {
    const url = this.base.replace(/^http/, "ws") + `/cable?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    const subscriptions = [
      JSON.stringify({ channel: "RoomChannel", slug }),
      JSON.stringify({ channel: "UserChannel" }),
    ];

    ws.onopen = () =>
      subscriptions.forEach((identifier) =>
        ws.send(JSON.stringify({ command: "subscribe", identifier })));
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type) return;              // welcome / ping / confirm_subscription
      if (data.message) onEvent(data.message);
    };
    return ws;
  }
}
