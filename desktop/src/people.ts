// The people surfaces: the workspace rail and what its actions open — joining
// with a code, making a room, inviting somebody — and the offer to add a
// colleague the message named. Moved out of main.ts whole (#283): markup ids,
// event order and every catch's wording are the window's own. State stayed
// behind — the rooms this client can reach and the channel on screen cross as
// accessors, and entering another workspace hands back through leaveChannel
// and loadChannels rather than touching main's state itself.

import type { Channel } from "./api";
import { enterRoom, missingFrom, reachableRooms, tokenForRoom, type Rooms } from "./rules";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface PeopleDeps {
  invitations(): Promise<Array<{ code: string; email: string | null; role: string }>>;
  invite(email?: string, role?: string): Promise<{ code: string }>;
  acceptInvitation(code: string): Promise<{ workspace: { slug: string; name: string };
                                            token: string }>;
  createWorkspace(slug: string, name: string): Promise<{ slug: string; name: string;
                                                         token: string }>;
  members(slug: string): Promise<Array<{ handle: string }>>;
  workspaceMembers(): Promise<Array<{ handle: string; name: string }>>;
  addMember(slug: string, handle: string): Promise<unknown>;
  /// Mentions are resolved against who can be addressed, and an agent's name
  /// is an address, not an invitation.
  agentDefinitions(): Array<{ name: string }>;
  /// The rooms this client holds tokens for. Read per draw and written back
  /// through the settings, the state itself staying in main.
  rooms(): Rooms;
  saveRooms(next: Rooms): Rooms;
  useToken(token: string): void;
  /// Sessions belong to the agent and the channel of the room that opened them.
  stopAgents(): Promise<void>;
  /// Everything on screen belongs to one room: entering another lets go of the
  /// open channel — a channel-less workspace must not inherit the old room's —
  /// then reloads the channels.
  leaveChannel(): void;
  loadChannels(): Promise<void>;
  currentChannel(): Channel | null;
  /// The shared name-and-address dialog — New channel asks the same two
  /// questions, so the dialog stays in main and is lent here.
  askForOne(title: string, note: string): Promise<{ slug: string; name: string } | null>;
  say(text: string, action?: string, run?: () => Promise<void>): () => void;
}

export interface People {
  renderWorkspaces(): void;
  offerToAdd(text: string): Promise<void>;
}

export function createPeople(deps: PeopleDeps): People {
  function renderWorkspaces() {
    const slugs = reachableRooms(deps.rooms());
    // The rail appears when there is a choice to make; one room is no choice.
    $("rail").hidden = slugs.length < 2;
    const box = $("rail-workspaces");
    box.innerHTML = "";
    for (const slug of slugs) {
      const b = document.createElement("button");
      b.className = `rail-workspace${slug === deps.rooms().current ? " active" : ""}`;
      b.textContent = (slug[0] ?? "?").toUpperCase();
      b.title = slug;
      b.onclick = () => enterWorkspace(slug);
      box.append(b);
    }
  }

  /// Everything on screen belongs to one room, so changing rooms reloads it all.
  async function enterWorkspace(slug: string) {
    const token = tokenForRoom(deps.rooms(), slug);
    if (!token) {
      deps.say(`This client has no way into ${slug}. Sign in again to reach it.`);
      return;
    }
    deps.saveRooms(enterRoom(deps.rooms(), slug));
    deps.useToken(token);
    // Sessions belong to the agent and the channel of the room that opened them.
    await deps.stopAgents().catch(() => {});
    deps.leaveChannel();
    renderWorkspaces();
    await deps.loadChannels();
  }

  async function renderInvitations() {
    const open = await deps.invitations().catch(() => []);
    const box = $("invite-open");
    box.textContent = open.length ? "" : "None.";
    for (const one of open) {
      const row = document.createElement("div");
      row.textContent = `${one.email ?? "anybody"} · ${one.role} · ${one.code}`;
      box.append(row);
    }
  }

  $("workspace-join").addEventListener("click", async () => {
    const dialog = $<HTMLDialogElement>("join");
    const field = $<HTMLInputElement>("join-code");
    field.value = "";
    dialog.showModal();
    await new Promise<void>((r) => dialog.addEventListener("close", () => r(), { once: true }));
    const code = field.value.trim();
    if (dialog.returnValue !== "go" || !code) return;

    // Cleared on the way out — the optimistic path every send here takes — and
    // put back if the server says no: the code arrived out of band and was typed
    // once, so losing it to a failed redemption costs the invitation, not the
    // attempt.
    field.value = "";
    try {
      const joined = await deps.acceptInvitation(code);
      // Redeeming is the third and last place a token for another room arrives.
      deps.saveRooms(enterRoom(deps.rooms(), joined.workspace.slug, joined.token));
      await enterWorkspace(joined.workspace.slug);
      deps.say(`You are in ${joined.workspace.name}.`);
    } catch (err) {
      field.value = code;
      deps.say(`That code did not get you in. ${String(err)}`);
    }
  });

  $("workspace-invite").addEventListener("click", async () => {
    const dialog = $<HTMLDialogElement>("invite");
    $("invite-result").textContent = "";
    await renderInvitations();
    dialog.showModal();
  });

  $("invite-go").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $<HTMLInputElement>("invite-email").value.trim();
    const role = $<HTMLSelectElement>("invite-role").value;
    try {
      const made = await deps.invite(email || undefined, role);
      // The code is the invitation. Shown rather than sent: this client has no
      // way to send mail, and pretending otherwise would lose somebody's invite.
      $("invite-result").textContent = `Send them this code: ${made.code}`;
      await renderInvitations();
    } catch (err) {
      $("invite-result").textContent = String(err);
    }
  });

  $("workspace-new").addEventListener("click", async () => {
    const asked = await deps.askForOne("New workspace",
      "A room of its own: its own channels, its own memory, and nothing of this one's.");
    if (!asked) return;

    try {
      const made = await deps.createWorkspace(asked.slug, asked.name);
      // The only place a token for another room legitimately arrives.
      deps.saveRooms(enterRoom(deps.rooms(), made.slug, made.token));
      await enterWorkspace(made.slug);
      deps.say(`${made.name} is yours. It opened with general, random and meetings.`);
    } catch (err) {
      deps.say(`The workspace was not made. ${String(err)}`);
    }
  });

  /// Somebody was named who is not in this room. Offered, never done: adding a
  /// colleague to a channel is a thing a person decides, and this is the one
  /// moment they are thinking about it.
  async function offerToAdd(text: string) {
    const current = deps.currentChannel();
    if (!current) return;

    const [ present, workspace ] = await Promise.all([
      deps.members(current.slug).catch(() => []),
      deps.workspaceMembers().catch(() => []),
    ]);

    for (const person of missingFrom(text, present, workspace, deps.agentDefinitions())) {
      const slug = current.slug;
      const dismiss = deps.say(`${person.name} is not in #${slug}.`, `Add @${person.handle}`,
        async () => {
          await deps.addMember(slug, person.handle);
          dismiss();
          deps.say(`${person.name} is in #${slug}.`);
        });
    }
  }

  return { renderWorkspaces, offerToAdd };
}
