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
  /// Which repository the room's work lives in (#203). Null is most rooms:
  /// a meetings channel is not a codebase.
  repository_url?: string | null;
  message_count: number;
  /// How much the room knows, counted by the store when the room was opened.
  /// Only `channels#show` carries it, and not when the store was away — an
  /// absent number is the store being unreachable, not a zero (#161, #146).
  memory_count?: number;
  /// Which of the two an absent count means: "ok" or "unavailable".
  memory?: string;
}

import type { RoomTemplate } from "./rules";

/// The whole of what this client uses a WebSocket for. Naming it is what lets a
/// test hand `live()` a socket of its own without impersonating a browser.
export interface CableSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
}

/// A subscription, which outlives any one socket under it. Closing it is the
/// caller saying it is done — not the network saying so.
export interface Live {
  close(): void;
}

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
                             invited_by: string }>>("/invitations");
  }

  invite(email?: string, role = "member") {
    return this.call<{ code: string; email: string | null; role: string }>(
      "/invitations", { method: "POST", body: JSON.stringify({ email, role }) });
  }

  /// Redeeming is how somebody reaches a room they did not make. It answers
  /// with that room's token, and nothing else does.
  acceptInvitation(code: string) {
    return this.call<{ workspace: { slug: string; name: string }; role: string; token: string }>(
      `/invitations/${encodeURIComponent(code)}/accept`, { method: "POST" });
  }

  /// The shapes a room can be added with. `skills` is what the room would open
  /// knowing, which is the whole of what a template is over an empty channel —
  /// so it is carried here rather than dropped. `taken` is this workspace
  /// already having that room.
  channelTemplates() {
    return this.call<RoomTemplate[]>("/channel-templates");
  }

  /// The channel's capability rail, as the agent should mount it.
  rail(slug: string) {
    return { url: `${this.base}/api/v1/rail/${slug}`, token: this.token };
  }

  channel(slug: string) {
    return this.call<Channel & { messages: Message[] }>(`/channels/${slug}`);
  }

  /// The room's one setting (#203). Blank clears it — the server writes NULL,
  /// and a change is journaled and told to the room from there. Members only:
  /// a setting is not a read.
  updateChannel(slug: string, repositoryUrl: string | null) {
    return this.call<Channel>(`/channels/${slug}`, {
      method: "PATCH", body: JSON.stringify({ repository_url: repositoryUrl }),
    });
  }

  /// What a room said while nobody was listening (#180). The cable replays
  /// nothing, so the only way back is to ask the channel again and keep what is
  /// past the newest message already on hand.
  ///
  /// The mark is read here, before the request, and that ordering is the whole
  /// point of the method existing. Read after, a message arriving on the live
  /// socket during the round trip becomes the mark, everything the outage ate is
  /// filtered out as already seen, and the room stays short with nothing to say
  /// it did. Passing `held` in rather than a number is what makes the ordering
  /// impossible to get wrong from the outside.
  async caughtUp(slug: string, held: { id: number }[]): Promise<Message[]> {
    const newest = held.reduce((max, m) => Math.max(max, m.id), 0);
    const { messages } = await this.channel(slug);
    return messages.filter((m) => m.id > newest);
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

  /// Work product belongs to the channel, so reopening the room must not lose
  /// what was attached while nobody watched (#160). Newest first, as served.
  artifacts(slug: string) {
    return this.call<Array<{ id: number; name: string; kind: string | null;
                             sha256: string | null; created_at: string }>>(
      `/channels/${slug}/artifacts`);
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
  ///
  /// A socket dies for reasons nobody chose — the server restarts, a proxy times
  /// the connection out, a laptop closes — and the room it fed then looks exactly
  /// like a room nobody is writing in (#180). So a close is answered with another
  /// attempt, and `onResync` lets the caller ask for what arrived while nobody was
  /// listening; only the caller knows what being caught up means, and a promise it
  /// rejects is a room still behind, so it is asked again. `Socket` is the seam a
  /// test stands a fake in, and the only one.
  live(slug: string, onEvent: (e: any) => void,
       onResync: () => void | Promise<void> = () => {},
       Socket: new (url: string) => CableSocket = WebSocket): Live {
    const url = this.base.replace(/^http/, "ws") + `/cable?token=${encodeURIComponent(this.token)}`;
    const subscriptions = [
      JSON.stringify({ channel: "RoomChannel", slug }),
      JSON.stringify({ channel: "UserChannel" }),
    ];

    let deliberate = false;

    // Doubling from a second and capped at half a minute, so a server that
    // stays down is not hammered; jittered down from there, so a server
    // coming back does not take every client's attempt in the same tick.
    //
    // Two things wait here, and they wait apart. On a real outage both are
    // waiting at once — the machine that refuses the catch-up is the machine
    // whose socket just dropped — so one shared handle makes them one wait,
    // and whichever is scheduled second cancels the first. When that is the
    // catch-up, the room is left with no socket and nobody waiting to open
    // one: the outage again, with nothing left to notice it (#180).
    const ladder = () => {
      let attempt = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;
      return {
        later(again: () => void) {
          clearTimeout(retry);
          const wait = Math.min(1000 * 2 ** attempt++, 30_000);
          retry = setTimeout(again, wait * (0.5 + Math.random() / 2));
        },
        arrived() { attempt = 0; },   // what got through earns a fresh first wait
        stop() { clearTimeout(retry); },
      };
    };

    const reconnecting = ladder();
    const catchingUp = ladder();

    // The socket is answered before the rest of the server necessarily is: a
    // machine that has only just come back can accept the connection and still
    // refuse the request the catch-up makes. Dropping that refusal would leave
    // the room as far behind as the outage left it, with nothing left to notice
    // — so a refused catch-up waits and asks again, exactly as a dropped socket
    // does. A caller that has since left the room is not owed an answer.
    const catchUp = () => {
      Promise.resolve(onResync()).then(
        () => catchingUp.arrived(),
        () => { if (!deliberate) catchingUp.later(catchUp); },
      );
    };

    const connect = (missed: boolean): CableSocket => {
      const ws = new Socket(url);
      ws.onopen = () => {
        reconnecting.arrived();
        subscriptions.forEach((identifier) =>
          ws.send(JSON.stringify({ command: "subscribe", identifier })));
        if (missed) catchUp();
      };
      ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.type) return;              // welcome / ping / confirm_subscription
        if (data.message) onEvent(data.message);
      };
      ws.onclose = () => {
        if (deliberate) return;             // leaving a room is not an outage
        reconnecting.later(() => { socket = connect(true); });
      };
      return ws;
    };

    let socket = connect(false);
    return {
      close() {
        deliberate = true;
        reconnecting.stop();
        catchingUp.stop();
        socket.close();
      },
    };
  }
}
