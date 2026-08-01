import { beforeEach, describe, expect, test } from "vitest";
import { createTimeline, type TimelineDeps } from "../src/timeline";
import type { Author, Channel, Message } from "../src/api";

// The room's half of index.html — the ids the timeline draws into. Kept in step
// with the real markup by hand, the way the onboarding spec keeps its own.
const MARKUP = `
  <section id="messages"></section>
  <aside id="thread" hidden>
    <div id="thread-messages"></div>
  </aside>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// The on-screen cap, mirrored from the timeline: a room with ten thousand
/// messages is not ten thousand elements.
const ON_SCREEN = 200;

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

/// What the timeline cannot own. `showSteps` is a view preference of the room,
/// not a property of the run.
function deps(over: Partial<TimelineDeps> = {}): TimelineDeps {
  return { showSteps: () => true, ...over };
}

beforeEach(() => { document.body.innerHTML = MARKUP; nextId = 0; });

describe("the room's timeline", () => {
  test("a message that arrives twice is drawn once and held once", () => {
    const timeline = createTimeline(deps());
    const hello = said("morning");
    timeline.open(room([ hello ]));

    // The same message reaches the room stream and the owner's, and posting it
    // hands it back to the sender as well.
    timeline.add(hello);
    timeline.add({ ...hello });

    expect(document.querySelectorAll("#messages .msg")).toHaveLength(1);
    expect(timeline.held().filter((m) => m.id === hello.id)).toHaveLength(1);
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
});

describe("what the agent is told the room said", () => {
  test("the history is the record, not what is on screen", () => {
    const timeline = createTimeline(deps());
    const oldest = said("the oldest thing said here");
    const rest = Array.from({ length: ON_SCREEN }, (_, i) => said(`later, number ${i}`));
    timeline.open(room([ oldest, ...rest ]));

    // The room keeps the recent end on screen and says so.
    expect(document.querySelectorAll("#messages .msg")).toHaveLength(ON_SCREEN);
    expect($("messages").textContent).toContain("earlier messages are not shown");
    expect($("messages").textContent).not.toContain("the oldest thing said here");

    // The turn reads the record, so a message scrolled out of the page is
    // still part of the conversation the agent is answering.
    const history = timeline.recentHistory(ON_SCREEN + 20)!;
    expect(history).toContain("Alice: the oldest thing said here");
    expect(history).toContain("Alice: later, number 199");
  });

  test("an agent's answer is attributed to the agent", () => {
    const timeline = createTimeline(deps());
    timeline.open(room([
      said("@agent what did we decide"),
      said("we decided to wait", { author: theirAgent("Alice") }),
    ]));

    const history = timeline.recentHistory()!;
    expect(history).toContain("Alice: @agent what did we decide");
    expect(history).toContain("Alice's agent: we decided to wait");
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

  test("steps the person asked not to see are drawn hidden", () => {
    const timeline = createTimeline(deps({ showSteps: () => false }));
    timeline.open(room([]));

    timeline.addStep(7, "read the minutes", 41);

    expect(document.querySelector<HTMLElement>('#messages .steps[data-run="7"]')!.hidden).toBe(true);
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
