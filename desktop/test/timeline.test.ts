import { beforeEach, describe, expect, test, vi } from "vitest";
import { ON_SCREEN, createTimeline, type TimelineDeps } from "../src/timeline";
import type { Author, Channel, Message } from "../src/api";
import type { Asked } from "../src/rules";

// The room's half of index.html — the ids the timeline draws into. Kept in step
// with the real markup by hand, the way the onboarding spec keeps its own.
const MARKUP = `
  <section id="messages"></section>
  <aside id="thread" hidden>
    <div id="thread-messages"></div>
  </aside>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const person = (name: string): Author => ({ kind: "user", id: 1, name, email: `${name}@farol.run` });
const theirAgent = (name: string): Author =>
  ({ kind: "agent", id: 2, name, agent_kind: "claude", run_id: 1 });

let nextId = 0;

function said(body: string, over: Partial<Message> = {}): Message {
  nextId += 1;
  return {
    id: nextId, channel_id: 1, parent_id: null, body,
    author: person("Alice"), created_at: "2026-01-01T09:12:00Z",
    ...over,
  };
}

function room(messages: Message[], over: Partial<Channel> = {}): Channel & { messages: Message[] } {
  return {
    id: 1, slug: "meetings", name: "Meetings", purpose: null, visibility: "workspace",
    memory_uri: "memory://meetings", message_count: messages.length,
    ...over,
    messages,
  };
}

/// What the timeline cannot own: the room's unread bookkeeping, the agent that
/// answers a permission, and the machine the work product is read from.
function deps(over: Partial<TimelineDeps> = {}): TimelineDeps {
  return {
    onShown: vi.fn(),
    permit: vi.fn(async () => {}),
    produced: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    attach: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => { document.body.innerHTML = MARKUP; nextId = 0; });

describe("the room's timeline", () => {
  test("a message that arrives twice is drawn once and held once", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    // The same message reaches the room stream and the owner's, and posting it
    // hands it back to the sender as well.
    const hello = said("morning");
    timeline.add(hello);
    timeline.add({ ...hello });

    expect(document.querySelectorAll("#messages .msg")).toHaveLength(1);
    expect(timeline.held()).toHaveLength(1);
  });

  test("an empty room says what it is for, and stops once something is said", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([], { purpose: "Where we plan the week" }));

    expect($("messages").querySelector(".intro")?.textContent).toContain("Where we plan the week");

    timeline.add(said("morning"));
    expect($("messages").querySelector(".intro")).toBeNull();
    expect(document.querySelectorAll("#messages .msg")).toHaveLength(1);
  });

  test("opening another room leaves nothing of the last one", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([ said("morning") ]));
    timeline.open(room([], { slug: "random" }));

    expect(document.querySelectorAll("#messages .msg")).toHaveLength(0);
    expect(timeline.held()).toEqual([]);
    expect(timeline.recentHistory()).toBeNull();
  });

  // The unread pill is the room's, counted from what the timeline put on
  // screen. It is a seam rather than an import because the count belongs to the
  // channel list, which the timeline never touches.
  test("the room is told what has been shown to it", () => {
    const onShown = vi.fn();
    const timeline = createTimeline(deps({ onShown }));
    const root = said("shall we move the review");
    timeline.open(room([ root, said("morning") ]));
    expect(onShown).toHaveBeenCalledTimes(2);

    timeline.add(said("and one more"));
    expect(onShown).toHaveBeenCalledTimes(3);

    // A reply drawn in the thread panel is not something the room has shown.
    timeline.add(said("yes", { parent_id: root.id, author: person("Bob") }));
    expect(onShown).toHaveBeenCalledTimes(3);
  });
});

describe("what the agent is told the room said", () => {
  test("the turn's history is the record, not the page", () => {
    const timeline = createTimeline(deps());
    const many = Array.from({ length: ON_SCREEN + 5 }, (_, i) => said(`later, number ${i}`));
    timeline.open(room(many));

    // The room keeps the recent end on screen and says so.
    expect(document.querySelectorAll("#messages .msg")).toHaveLength(ON_SCREEN);
    expect($("messages").textContent).toContain("earlier messages are not shown");

    // Called the way the turn calls it — no argument. The record answers, so
    // what a message says is what was said, not the row that drew it.
    const recent = many.slice(-20).map((m) => `Alice: ${m.body}`);
    expect(timeline.recentHistory()).toBe(`Recently in this channel:\n\n${recent.join("\n")}`);
  });

  test("a room past the cap still hands over what scrolled off it", () => {
    const timeline = createTimeline(deps());
    const oldest = said("the oldest thing said here");
    const rest = Array.from({ length: ON_SCREEN }, (_, i) => said(`later, number ${i}`));
    timeline.open(room([ oldest, ...rest ]));

    expect($("messages").textContent).not.toContain("the oldest thing said here");
    expect(timeline.recentHistory(ON_SCREEN + 20)).toContain("Alice: the oldest thing said here");
  });

  test("an agent's answer is attributed to the agent", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([
      said("@agent what did we decide"),
      said("we decided to wait", { author: theirAgent("Alice") }),
    ]));

    expect(timeline.recentHistory()).toBe(
      "Recently in this channel:\n\n"
      + "Alice: @agent what did we decide\n"
      + "Alice's agent: we decided to wait");
  });

  // The record holds every reply; the room holds what the room said. Handing
  // the side conversations to the agent would change what a turn is answering,
  // and this card changes where history comes from, not what it is.
  test("a side conversation is not part of what the room said", () => {
    const timeline = createTimeline(deps());
    const root = said("shall we move the review");
    timeline.open(room([ root ]));
    timeline.add(said("only between us", { parent_id: root.id, author: person("Bob") }));
    timeline.add(said("agreed, moved it", { parent_id: root.id, author: theirAgent("Alice") }));

    const history = timeline.recentHistory()!;
    expect(history).not.toContain("only between us");
    // An agent answering in a thread answered the room, and the room read it.
    expect(history).toContain("Alice's agent: agreed, moved it");
  });

  test("a room where nothing was said has no history to give", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    expect(timeline.recentHistory()).toBeNull();
  });

  test("only the last few turns, however long the room is", () => {
    const timeline = createTimeline(deps());
    timeline.open(room(Array.from({ length: 30 }, (_, i) => said(`turn number ${i}`))));

    const history = timeline.recentHistory(20)!;
    expect(history).toContain("turn number 29");
    expect(history).not.toContain("turn number 9");
  });
});

describe("a conversation beside the room", () => {
  test("replies are summarised in the room, not shown in it", () => {
    const timeline = createTimeline(deps());
    const root = said("shall we move the review");
    timeline.open(room([ root ]));

    timeline.add(said("yes", { parent_id: root.id, author: person("Bob") }));
    timeline.add(said("fine by me", { parent_id: root.id, author: person("Carol") }));

    expect(document.querySelectorAll("#messages .msg")).toHaveLength(1);
    expect($("messages").querySelector(".thread-summary")?.textContent)
      .toBe("2 replies · Bob, Carol");
  });

  test("an agent answering in a thread answers the room", () => {
    const timeline = createTimeline(deps());
    const root = said("shall we move the review");
    timeline.open(room([ root ]));

    timeline.add(said("moved it", { parent_id: root.id, author: theirAgent("Alice") }));

    // In the room, because a room full of questions and no answers is worse.
    expect(document.querySelectorAll("#messages .msg")).toHaveLength(2);
    // And not counted as a conversation happening elsewhere.
    expect($("messages").querySelector(".thread-summary")).toBeNull();
  });

  test("the thread panel is the root and what hangs off it, and it closes", () => {
    const timeline = createTimeline(deps());
    const root = said("shall we move the review");
    const reply = said("yes", { parent_id: root.id, author: person("Bob") });
    const elsewhere = said("unrelated");
    timeline.open(room([ root, reply, elsewhere ]));

    $("messages").querySelector<HTMLButtonElement>(".msg .reply-action")!.click();

    expect($("thread").hidden).toBe(false);
    expect($("thread-messages").textContent).toContain("shall we move the review");
    expect($("thread-messages").textContent).toContain("yes");
    expect($("thread-messages").textContent).not.toContain("unrelated");

    // A reply arriving while it is open joins the conversation being read.
    timeline.add(said("me too", { parent_id: root.id, author: person("Carol") }));
    expect($("thread-messages").textContent).toContain("me too");

    timeline.closeThread();
    expect($("thread").hidden).toBe(true);
  });

  test("opening a room closes whatever thread was being read", () => {
    const timeline = createTimeline(deps());
    const root = said("shall we move the review");
    timeline.open(room([ root, said("yes", { parent_id: root.id, author: person("Bob") }) ]));
    $("messages").querySelector<HTMLButtonElement>(".msg .reply-action")!.click();

    timeline.open(room([], { slug: "random" }));
    expect($("thread").hidden).toBe(true);
  });
});

describe("what the run is doing", () => {
  test("a step that arrives on both streams is one line", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    timeline.addStep(7, "read the minutes", 41);
    timeline.addStep(7, "read the minutes", 41);
    timeline.addStep(7, "wrote the summary", 42);

    const holder = document.querySelector<HTMLElement>('#messages .steps[data-run="7"]')!;
    expect(holder.children).toHaveLength(2);
    expect(holder.hidden).toBe(false);
  });

  test("steps go away and come back with the preference, whenever they arrived", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));
    timeline.addStep(7, "read the minutes", 41);

    timeline.revealSteps(false);
    expect(document.querySelector<HTMLElement>('.steps[data-run="7"]')!.hidden).toBe(true);

    // A run that starts while they are off does not put them back on screen.
    timeline.addStep(8, "read the thread", 43);
    expect(document.querySelector<HTMLElement>('.steps[data-run="8"]')!.hidden).toBe(true);

    timeline.revealSteps(true);
    expect([ ...document.querySelectorAll<HTMLElement>(".steps") ].map((el) => el.hidden))
      .toEqual([ false, false ]);
  });

  test("the latest plan replaces the one on screen", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    timeline.showPlan(7, [ { content: "read the minutes", status: "in_progress" } ]);
    timeline.showPlan(7, [
      { content: "read the minutes", status: "completed" },
      { content: "write the summary", status: "pending" },
    ]);

    const plans = document.querySelectorAll("#messages .plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].querySelectorAll(".plan-entry")).toHaveLength(2);
    expect(plans[0].textContent).toContain("write the summary");
  });

  test("an artifact the run attached is shown by name", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    timeline.addArtifact({ id: 3, name: "minutes.md", kind: "transcript" });

    expect(document.querySelector("#messages .artifact")?.textContent).toContain("minutes.md");
  });
});

describe("the agent waiting on a person", () => {
  const asked: Asked = {
    id: "req-1", title: "Run the test suite?",
    options: [ { id: "allow", name: "Allow" }, { id: "deny", name: "Deny" } ],
  };

  test("the options are the agent's, and the answer goes back to it", async () => {
    const permit = vi.fn(async () => {});
    const timeline = createTimeline(deps({ permit }));
    timeline.open(room([]));

    timeline.askPermission("claude", asked);
    const ask = document.querySelector<HTMLElement>("#messages .offer.ask")!;
    expect(ask.textContent).toContain("Run the test suite?");
    expect([ ...ask.querySelectorAll("button") ].map((b) => b.textContent))
      .toEqual([ "Allow", "Deny" ]);

    ask.querySelectorAll<HTMLButtonElement>("button")[0].click();
    // Nothing is answered twice while the first answer is in flight.
    expect([ ...ask.querySelectorAll("button") ].every((b) => b.disabled)).toBe(true);

    await vi.waitFor(() => expect(permit).toHaveBeenCalledWith("claude", "req-1", "allow"));
    await vi.waitFor(() => expect(ask.textContent).toBe("Run the test suite? — allow"));
  });

  test("a git ask carries its consequence, muted, beside the question (#205)", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    timeline.askPermission("claude", asked, "Push to origin (main) — deploys on merge to main.");

    const ask = document.querySelector<HTMLElement>("#messages .offer.ask")!;
    const note = ask.querySelector<HTMLElement>(".ask-note")!;
    expect(note.textContent).toContain("deploys on merge to main");
    // The mechanics are untouched: the options are still the agent's own.
    expect([ ...ask.querySelectorAll("button") ].map((b) => b.textContent))
      .toEqual([ "Allow", "Deny" ]);
  });

  test("an ask without a consequence gets no annotation", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([]));

    timeline.askPermission("claude", asked);

    expect(document.querySelector("#messages .ask-note")).toBeNull();
  });
});

describe("what the run wrote, offered one file at a time", () => {
  test("a file is offered, and sharing it is what sends it", async () => {
    const attach = vi.fn(async () => {});
    const timeline = createTimeline(deps({
      produced: async () => ({ files: [ { path: "minutes.md", bytes: 2048 } ], pre_existing: 0 }),
      readFile: async () => "bWludXRlcw==",
      attach,
    }));
    timeline.open(room([]));

    await timeline.offerProduced(11, "/work/meetings");
    const offer = document.querySelector<HTMLElement>("#messages .offer")!;
    expect(offer.textContent).toContain("minutes.md");
    expect(offer.textContent).toContain("2 kB");

    offer.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() =>
      expect(attach).toHaveBeenCalledWith(11, "minutes.md", "bWludXRlcw==", "text/markdown"));
    // Shared once: the row that offered it is gone.
    await vi.waitFor(() => expect(document.querySelector("#messages .offer")).toBeNull());
  });

  test("an offer nobody could read says what it left out", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ path: `note-${i}.md`, bytes: 10 }));
    const timeline = createTimeline(deps({ produced: async () => ({ files: many, pre_existing: 0 }) }));
    timeline.open(room([]));

    await timeline.offerProduced(11, "/work/meetings");

    expect(document.querySelectorAll("#messages .offer:not(.muted)")).toHaveLength(12);
    expect(document.querySelector("#messages .offer.muted")?.textContent)
      .toBe("2 more files changed and are not offered.");
  });

  test("a turn that wrote nothing offers nothing", async () => {
    const timeline = createTimeline(deps({ produced: async () => ({ files: [ { path: "empty.md", bytes: 0 } ], pre_existing: 0 }) }));
    timeline.open(room([]));

    await timeline.offerProduced(11, "/work/meetings");

    expect(document.querySelector("#messages .offer")).toBeNull();
  });

  test("an empty offer with pre-existing changes says so, quietly", async () => {
    const timeline = createTimeline(deps({
      produced: async () => ({ files: [], pre_existing: 3 }),
    }));
    timeline.open(room([]));

    await timeline.offerProduced(11, "/work/meetings");

    expect(document.querySelector("#messages .offer.muted")?.textContent)
      .toBe("Nothing new this turn (3 pre-existing changes not offered)");
  });
});
