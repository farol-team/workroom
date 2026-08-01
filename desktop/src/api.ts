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
  message_count: number;
  /// Only when a room is opened. The listing cannot carry it without asking the
  /// context store once per channel, and nothing in the sidebar renders it.
  memory_count?: number;
}

export { ADDRESS, parseAddress } from "./rules";

export class Api {
  constructor(public base = "http://127.0.0.1:3000", public token = "") {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}/api/v1${path}`, {
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

  /// How this workspace lets people in. Asked before anything is offered, so a
  /// workspace with a provider never shows a box that takes any address.
  methods() {
    return this.call<{ development: boolean; provider: boolean; version?: string }>("/auth/methods");
  }

  /// A token obtained through the browser is the same token development
  /// sign-in issues, so nothing downstream changes.
  useToken(token: string) { this.token = token; }

  async signIn(email: string) {
    const r = await this.call<{ token: string; user: { id: number; email: string; name: string } }>("/auth", {
      method: "POST", body: JSON.stringify({ email }),
    });
    this.token = r.token;
    return r;
  }

  /// Who the token in hand belongs to.
  whoAmI() {
    return this.call<{ user: { id: number; email: string; name: string } }>("/me");
  }

  channels() { return this.call<Channel[]>("/channels"); }

  /// The rooms this person belongs to. Without tokens, deliberately — see
  /// `Rooms` in rules.ts for why one is never fetched.
  workspaces() {
    return this.call<Array<{ id: number; slug: string; name: string; role: string;
                             has_own_context_store: boolean }>>("/workspaces");
  }

  /// A room, and the token that reaches it — which comes back because the
  /// caller just made it, and from nowhere else.
  createWorkspace(slug: string, name: string) {
    return this.call<{ slug: string; name: string; role: string; token: string }>("/workspaces", {
      method: "POST", body: JSON.stringify({ slug, name }),
    });
  }

  /// A channel in the room this token names. `template` fills one in from the
  /// shapes the server offers; without it the three fields are the channel.
  createChannel(body: { slug?: string; name?: string; purpose?: string; template?: string }) {
    return this.call<Channel>("/channels", { method: "POST", body: JSON.stringify(body) });
  }

  /// Everybody in this workspace, which is what a mention is resolved against.
  workspaceMembers() {
    return this.call<Array<{ id: number; name: string; handle: string; role: string }>>(
      "/workspace/members");
  }

  addMember(slug: string, handle: string) {
    return this.call<{ id: number; name: string; handle: string }>(`/channels/${slug}/members`, {
      method: "POST", body: JSON.stringify({ handle }),
    });
  }

  invitations() {
    return this.call<Array<{ id: number; code: string; email: string | null; role: string;
                             expires_at: string; invited_by: string }>>("/invitations");
  }

  invite(email?: string, role = "member") {
    return this.call<{ code: string; email: string | null; role: string; expires_at: string }>(
      "/invitations", { method: "POST", body: JSON.stringify({ email, role }) });
  }

  /// Redeeming is how somebody reaches a room they did not make. It answers
  /// with that room's token, and nothing else does.
  acceptInvitation(code: string) {
    return this.call<{ workspace: { slug: string; name: string }; role: string; token: string }>(
      `/invitations/${encodeURIComponent(code)}/accept`, { method: "POST" });
  }

  channelTemplates() {
    return this.call<Array<{ key: string; name: string; purpose: string; taken: boolean }>>(
      "/channel-templates");
  }

  /// The channel's capability rail, as the agent should mount it.
  rail(slug: string) {
    return { url: `${this.base}/api/v1/rail/${slug}`, token: this.token };
  }

  channel(slug: string) {
    return this.call<Channel & { messages: Message[] }>(`/channels/${slug}`);
  }

  /// What the room knows, ready to prepend to an agent turn.
  context(slug: string) {
    return this.call<{
      context: string | null; memory_uri: string; boundary: string;
      /// Where this room's context store is, and the key for it. Null until the
      /// workspace has an account of its own — and then the agent reaches no
      /// store rather than somebody else's (#115).
      store: { url: string; key: string } | null;
    }>(`/channels/${slug}/context`);
  }

  /// How work is done in this channel — procedure, not what the room learned.
  skills(slug: string) {
    return this.call<Array<{ uri: string; title: string; overview: string }>>(
      `/channels/${slug}/skills`);
  }

  writeSkill(slug: string, title: string, body: string) {
    return this.call(`/channels/${slug}/skills`, {
      method: "POST", body: JSON.stringify({ title, body }),
    });
  }

  /// Who is in the room. A name and a role, nothing that identifies anyone
  /// elsewhere.
  members(slug: string) {
    return this.call<Array<{ id: number; name: string; handle: string; role: string }>>(
      `/channels/${slug}/members`);
  }

  memory(slug: string) {
    return this.call<Array<{ uri: string; title: string; overview: string; trust: string }>>(
      `/channels/${slug}/memory`);
  }

  remember(slug: string, title: string, detail: string) {
    return this.call(`/channels/${slug}/memory`, {
      method: "POST", body: JSON.stringify({ title, detail, trust: "human" }),
    });
  }

  /// `parentId` makes it a reply: the room shows a summary, the conversation
  /// happens in the panel.
  post(slug: string, body: string, parentId?: number) {
    return this.call<Message>(`/channels/${slug}/messages`, {
      method: "POST", body: JSON.stringify({ body, parent_id: parentId }),
    });
  }

  /// `agentKind` is the name this person addresses the agent by. The server
  /// keys the session on it, so two agents in one channel keep two sessions.
  startRun(slug: string, triggerMessageId: number, agentKind: string,
           externalId: string, model?: string) {
    return this.call<{ id: number; agent_session_id: number }>(`/channels/${slug}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger_message_id: triggerMessageId, agent_kind: agentKind,
                             external_id: externalId, model }),
    });
  }

  attachArtifact(runId: number, name: string, content: string, kind = "transcript") {
    return this.call(`/runs/${runId}/artifacts`, {
      method: "POST", body: JSON.stringify({ name, content, kind }),
    });
  }

  /// Bytes rather than text, for work product that is not a document.
  attachBytes(runId: number, name: string, base64: string, contentType: string) {
    return this.call(`/runs/${runId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ name, kind: "file", content_base64: base64,
                             content_type: contentType }),
    });
  }

  plan(runId: number, entries: unknown[]) {
    return this.call(`/runs/${runId}/plan`, {
      method: "POST", body: JSON.stringify({ entries }),
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

  /// Usage as the agent reports it. It is the only thing that knows.
  reportUsage(runId: number, used: number, size: number, cost?: number) {
    return this.call(`/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify({ context_used: used, context_size: size, cost }),
    });
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
