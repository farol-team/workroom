import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StepLedger, WorkingSignal, channelToCreate, enterRoom, mentionsIn, pickable, templateNote, missingFrom, loadRooms, reachableRooms, tokenForRoom, activeAgent, anyReady, boundFolder, closingInstruction, driftNotice, forget, keysOf, recall, remember, mcpServersFor, onboardingCards, orAfter, permissionAsked, timeLabel, updateNotice, identity, inTimeline, offerable, onScreen, contentTypeFor, dayLabel, defaultAgent, formatHistory, normalizeAgents, parseAddress, selectable, sessionKey, sessionOf, threadOf, threadSummary, transcriptName, translateAcp, unreadCount, withClosing, worthOffering } from "../src/rules";

describe("mentioning somebody who is not here", () => {
  const here = [ { handle: "alice", name: "Alice" } ];
  const workspace = [ { handle: "alice", name: "Alice" }, { handle: "bob", name: "Bob" },
                      { handle: "carol", name: "Carol" } ];

  test("a mention anywhere in the line counts, because it still names somebody", () => {
    expect(mentionsIn("could @bob look at this")).toEqual([ "bob" ]);
    expect(mentionsIn("@bob and @carol")).toEqual([ "bob", "carol" ]);
    expect(mentionsIn("said it twice @bob @bob")).toEqual([ "bob" ]);
  });

  test("an address is not a mention", () => {
    expect(mentionsIn("write to bob@example.test")).toEqual([]);
  });

  test("somebody in the room is not an offer to add them" , () => {
    expect(missingFrom("@alice @bob", here, workspace)).toEqual([ { handle: "bob", name: "Bob" } ]);
  });

  test("the agent is addressed, not invited", () => {
    // `@agent` and an agent's own name reach an agent. Offering to add one to a
    // channel would be offering to add a person who does not exist.
    expect(missingFrom("@agent do this", here, workspace)).toEqual([]);
    expect(missingFrom("@claude do this", here, workspace, [ { name: "claude" } ])).toEqual([]);
  });

  test("a name nobody in this workspace answers to is not offered", () => {
    // The boundary: a handle from another workspace resolves to nobody here,
    // and the client does not ask the server about a stranger.
    expect(missingFrom("@mallory", here, workspace)).toEqual([]);
  });
});

describe("the rooms this client can reach", () => {
  test("a room is reachable because this client was given a way in, never because it asked", () => {
    // An endpoint that hands over a token for another room would hand it to an
    // agent too — an agent holds the same token the client does. So the store
    // is what arrived at sign-in or at creation, and nothing else.
    let rooms = loadRooms(null);
    expect(reachableRooms(rooms)).toEqual([]);

    rooms = enterRoom(rooms, "acme", "tok-acme");
    expect(rooms.current).toBe("acme");
    expect(tokenForRoom(rooms, "acme")).toBe("tok-acme");
  });

  test("switching to a room with no token does not switch", () => {
    const rooms = enterRoom(enterRoom(loadRooms(null), "acme", "tok"), "globex");

    expect(rooms.current).toBe("acme");
    expect(tokenForRoom(rooms, "globex")).toBeUndefined();
  });

  test("what was stored is where this person was", () => {
    const saved = JSON.stringify(enterRoom(enterRoom(loadRooms(null), "a", "1"), "b", "2"));

    const rooms = loadRooms(saved);
    expect(rooms.current).toBe("b");
    expect(reachableRooms(rooms)).toEqual([ "a", "b" ]);
  });

  test("a corrupt file costs the person their place, not their account", () => {
    expect(loadRooms("{not json")).toEqual({ tokens: {} });
    // A current room with no token is not a room this client can open.
    expect(loadRooms(JSON.stringify({ current: "gone", tokens: {} })).current).toBeUndefined();
  });
});

describe("routing by session", () => {
  test("both inbound shapes say which session they belong to", () => {
    // session/update carries it in params; a permission request carries it in
    // the request it wraps. Neither was read, so what an agent said was routed
    // by whoever happened to be listening (#91).
    expect(sessionOf({ method: "session/update", params: { sessionId: "s1", update: {} } })).toBe("s1");
    expect(sessionOf({ id: 3, request: { method: "session/request_permission",
                                         params: { sessionId: "s2" } } })).toBe("s2");
    expect(sessionOf({ sessionId: "s3" })).toBe("s3");
  });

  test("a message that names no session belongs to no turn", () => {
    expect(sessionOf({ method: "session/update", params: { update: {} } })).toBeUndefined();
    expect(sessionOf({ params: { sessionId: "" } })).toBeUndefined();
    expect(sessionOf(null)).toBeUndefined();
  });
});

describe("addressing", () => {
  test("a plain message is for the room", () => {
    expect(parseAddress("what did we agree?")).toEqual({
      addressed: false, body: "what did we agree?",
    });
  });

  test("an addressed message reaches the agent and loses the marker", () => {
    const { addressed, body } = parseAddress("@agent summarise the call");
    expect(addressed).toBe(true);
    expect(body).toBe("summarise the call");
  });

  test.each(["@Agent go", "@AGENT go", "@agent: go", "@agent, go", "  @agent go"])(
    "%s is recognised", (input) => {
      expect(parseAddress(input).addressed).toBe(true);
      expect(parseAddress(input).body).toBe("go");
    });

  test("a mention elsewhere in the line is not an address", () => {
    expect(parseAddress("ask @agent about it").addressed).toBe(false);
  });

  test("a longer word starting with agent is not an address", () => {
    expect(parseAddress("@agentsmith hello").addressed).toBe(false);
  });
});

describe("history", () => {
  test("is nothing when the room has said nothing", () => {
    expect(formatHistory([])).toBeNull();
    expect(formatHistory([{ who: "Alice", what: "   " }])).toBeNull();
  });

  test("carries who said what, in order", () => {
    const out = formatHistory([
      { who: "Alice", what: "first" },
      { who: "Bob", what: "second" },
    ]);
    expect(out).toContain("Alice: first");
    expect(out).toContain("Bob: second");
    expect(out!.indexOf("Alice")).toBeLessThan(out!.indexOf("Bob"));
  });

  test("keeps the most recent turns, not the oldest", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ who: "A", what: `m${i}` }));
    const out = formatHistory(rows, 3)!;
    expect(out).toContain("m29");
    expect(out).not.toContain("m0:");
  });
});

describe("step ledger", () => {
  test("a step seen twice is displayed once", () => {
    const ledger = new StepLedger();
    expect(ledger.admit(1)).toBe(true);
    expect(ledger.admit(1)).toBe(false);
    expect(ledger.size).toBe(1);
  });

  test("distinct steps all pass", () => {
    const ledger = new StepLedger();
    expect([1, 2, 3].map((id) => ledger.admit(id))).toEqual([true, true, true]);
  });

  test("a step without an id is always admitted", () => {
    const ledger = new StepLedger();
    expect(ledger.admit()).toBe(true);
    expect(ledger.admit()).toBe(true);
  });
});

describe("acp translation", () => {
  const update = (u: Record<string, unknown>) => ({ method: "session/update", params: { update: u } });

  test("agent text becomes text", () => {
    expect(translateAcp(update({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } })))
      .toEqual({ kind: "text", text: "hi" });
  });

  test("an empty chunk is not an update", () => {
    expect(translateAcp(update({ sessionUpdate: "agent_message_chunk", content: { text: "" } })))
      .toBeNull();
  });

  test("a tool call becomes a step label", () => {
    expect(translateAcp(update({ sessionUpdate: "tool_call", title: "search memory" })))
      .toEqual({ kind: "tool", label: "search memory" });
  });

  test("a plan becomes a plan, with its entries", () => {
    const out = translateAcp(update({
      sessionUpdate: "plan",
      entries: [ { content: "Read the deck", priority: "high", status: "in_progress" } ],
    }));
    expect(out).toEqual({
      kind: "plan",
      entries: [ { content: "Read the deck", priority: "high", status: "in_progress" } ],
    });
  });

  test("a plan with no entries is not an update", () => {
    expect(translateAcp(update({ sessionUpdate: "plan", entries: [] }))).toBeNull();
  });

  test("usage becomes usage", () => {
    expect(translateAcp(update({ sessionUpdate: "usage_update", used: 84000, size: 200000, cost: 0.42 })))
      .toEqual({ kind: "usage", used: 84000, size: 200000, cost: 0.42 });
  });

  test("cost is optional", () => {
    expect(translateAcp(update({ sessionUpdate: "usage_update", used: 10, size: 100 })))
      .toEqual({ kind: "usage", used: 10, size: 100, cost: undefined });
  });

  test("a config update carries the whole option list", () => {
    const options = [ { id: "model", name: "Model", type: "select",
                        currentValue: "a", options: [ { value: "a", name: "A" } ] } ];
    expect(translateAcp(update({ sessionUpdate: "config_option_update", configOptions: options })))
      .toEqual({ kind: "config", options });
  });

  test("a config update with no options is not an update", () => {
    expect(translateAcp(update({ sessionUpdate: "config_option_update", configOptions: [] })))
      .toBeNull();
  });

  test("an unknown update surfaces rather than vanishing", () => {
    expect(translateAcp(update({ sessionUpdate: "plan_changed" })))
      .toEqual({ kind: "other", label: "plan_changed" });
  });

  test("anything that is not a session update is ignored", () => {
    expect(translateAcp({ method: "something/else" })).toBeNull();
    expect(translateAcp(null)).toBeNull();
  });
});

describe("transcript naming", () => {
  test("names the artifact after the run a colleague was watching", () => {
    const name = transcriptName(42, new Date("2026-07-31T09:05:00Z"));
    expect(name).toMatch(/^run-42 transcript /);
    expect(name.endsWith(".json")).toBe(true);
  });

  test("two runs never collide", () => {
    const at = new Date("2026-07-31T09:05:00Z");
    expect(transcriptName(1, at)).not.toEqual(transcriptName(2, at));
  });
});

describe("selectable options", () => {
  test("only selects are offered, because a control for an unknown shape is a guess", () => {
    const options = [
      { id: "model", name: "Model", type: "select", currentValue: "a",
        options: [ { value: "a", name: "A" } ] },
      { id: "temperature", name: "Temperature", type: "number", currentValue: "0.7" },
      { id: "mode", name: "Mode", type: "select", currentValue: "build",
        options: [ { value: "build", name: "build" } ] },
    ];
    expect(selectable(options as never).map((o) => o.id)).toEqual([ "model", "mode" ]);
  });

  test("a select with no choices is not offered", () => {
    expect(selectable([ { id: "x", name: "X", type: "select", currentValue: "", options: [] } ] as never))
      .toEqual([]);
  });
});

describe("several agents", () => {
  const agents = [
    { name: "opencode", command: "opencode", args: ["acp"], default: true },
    { name: "claude", command: "claude-code-acp", args: [] },
  ];

  test("@agent means whichever one is default", () => {
    expect(parseAddress("@agent go", agents).agent).toBe("opencode");
  });

  test("a name addresses that agent and loses the marker", () => {
    const { addressed, agent, body } = parseAddress("@claude review this", agents);
    expect(addressed).toBe(true);
    expect(agent).toBe("claude");
    expect(body).toBe("review this");
  });

  test.each(["@Claude go", "@CLAUDE: go", "@claude, go"])("%s reaches claude", (input) => {
    expect(parseAddress(input, agents).agent).toBe("claude");
  });

  test("a colleague is not an agent", () => {
    // The room is full of people. Only configured names are summons.
    expect(parseAddress("@bob can you look?", agents)).toEqual({
      addressed: false, body: "@bob can you look?",
    });
  });

  test("with nothing configured, @agent still means the one that is running", () => {
    const { addressed, agent } = parseAddress("@agent go", []);
    expect(addressed).toBe(true);
    expect(agent).toBeUndefined();
  });

  test("the default is the marked one, or the first, or nothing", () => {
    expect(defaultAgent(agents)).toBe("opencode");
    expect(defaultAgent([{ name: "kimi", command: "k", args: [] }, ...agents])).toBe("opencode");
    expect(defaultAgent([{ name: "kimi", command: "k", args: [] }])).toBe("kimi");
    expect(defaultAgent([])).toBeUndefined();
  });
});

describe("which agent the controls act on", () => {
  const three = normalizeAgents([]);

  test("with no choice made it is the default", () => {
    expect(activeAgent(three)).toBe("claude");
    expect(activeAgent([])).toBeUndefined();
  });

  test("a chosen agent is the one, default or not", () => {
    // Three agents are seeded for everybody now, so two running at once is
    // ordinary. The session options and the @agent prefill act on one of them,
    // and reaching the other must not mean stopping the first.
    expect(activeAgent(three, "opencode")).toBe("opencode");
    expect(activeAgent(three, "codex")).toBe("codex");
  });

  test("a choice that outlived its definition is not a choice", () => {
    expect(activeAgent(three, "kimi")).toBe("claude");
    expect(activeAgent([], "claude")).toBeUndefined();
  });
});

describe("agent definitions", () => {
  test("an entry with no name or no command is not an agent", () => {
    expect(normalizeAgents([
      { name: "", command: "x", args: [] },
      { name: "y", command: "  ", args: [] },
      { name: "opencode", command: "opencode", args: ["acp"] },
    ]).map((d) => d.name)).toEqual([ "opencode", "claude", "codex" ]);
  });

  test("a name that cannot be typed as an address is not an agent", () => {
    // The name is the summons. One that @ cannot reach configures an agent
    // nobody can call, and makes the session key ambiguous besides.
    const out = normalizeAgents([
      { name: "my agent", command: "x", args: [] },
      { name: "-lead", command: "x", args: [] },
      { name: "gpt-5.1_local", command: "x", args: [] },
    ]);
    expect(out[0]).toEqual({ name: "gpt-5.1_local", command: "x", args: [], default: true });
    expect(out.map((d) => d.name)).not.toContain("my agent");
    expect(out.map((d) => d.name)).not.toContain("-lead");
  });

  test("one name, one agent — the first definition wins", () => {
    const out = normalizeAgents([
      { name: "claude", command: "first", args: [] },
      { name: "Claude", command: "second", args: [] },
    ]);
    expect(out.filter((d) => d.name.toLowerCase() === "claude")).toHaveLength(1);
    expect(out[0].command).toBe("first");
  });

  test("there is always exactly one default", () => {
    // Two defaults is a coin toss over which agent answers; none is a dead @agent.
    const two = normalizeAgents([
      { name: "a", command: "a", args: [], default: true },
      { name: "b", command: "b", args: [], default: true },
    ]);
    expect(two.filter((d) => d.default)).toHaveLength(1);
    expect(two[0].default).toBe(true);

    const none = normalizeAgents([{ name: "a", command: "a", args: [] }]);
    expect(none[0].default).toBe(true);
  });

  test("nothing configured is the agent that ships, and the two it can offer", () => {
    // The shipped one is default and certainly there (#120). The other two are
    // named so somebody can see they exist and what state they are in — naming
    // one installs nothing.
    expect(normalizeAgents([])).toEqual([
      { name: "claude", command: "claude-agent-acp", args: [], default: true },
      { name: "codex", command: "codex-acp", args: [] },
      { name: "opencode", command: "opencode", args: [ "acp" ] },
    ]);
  });

  test("a person's own definition of a seeded name is theirs, not ours", () => {
    // Somebody running opencode from a checkout must not have it replaced by
    // the catalog's idea of where opencode is.
    const out = normalizeAgents([{ name: "opencode", command: "/opt/opencode", args: [] }]);

    expect(out.filter((d) => d.name === "opencode")).toEqual([
      { name: "opencode", command: "/opt/opencode", args: [], default: true },
    ]);
  });

  test("an agent nobody pinned is kept, and answers @agent when it is first", () => {
    const out = normalizeAgents([{ name: "kimi", command: "kimi-acp", args: [] }]);

    expect(out.map((d) => d.name)).toEqual([ "kimi", "claude", "codex", "opencode" ]);
    expect(defaultAgent(out)).toBe("kimi");
  });

  test("seeding does not hand out a second default", () => {
    expect(normalizeAgents([]).filter((d) => d.default)).toHaveLength(1);
    expect(normalizeAgents([{ name: "kimi", command: "k", args: [] }])
      .filter((d) => d.default)).toHaveLength(1);
  });
});

describe("sessions are per agent and per channel", () => {
  test("two agents in one room do not share a session", () => {
    // Memory belongs to the channel, but a session belongs to the agent that
    // opened it. Sharing one would hand claude's session id to opencode.
    expect(sessionKey("opencode", "meetings")).not.toBe(sessionKey("claude", "meetings"));
    expect(sessionKey("opencode", "meetings")).not.toBe(sessionKey("opencode", "marketing"));
    expect(sessionKey("opencode", "meetings")).toBe(sessionKey("opencode", "meetings"));
  });
});

describe("work product", () => {
  test("a file is offered under the type it is, not the type it was sent as", () => {
    // Attached as application/json a chart downloads unopenable, and nothing
    // anywhere reports an error.
    expect(contentTypeFor("out/q3.png")).toBe("image/png");
    expect(contentTypeFor("report.md")).toBe("text/markdown");
    expect(contentTypeFor("data.csv")).toBe("text/csv");
    expect(contentTypeFor("deck.pdf")).toBe("application/pdf");
    expect(contentTypeFor("chart.SVG")).toBe("image/svg+xml");
  });

  test("an unknown extension is bytes, not a guess", () => {
    expect(contentTypeFor("model.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("Makefile")).toBe("application/octet-stream");
  });

  test("what a run produced is worth offering only if there is any", () => {
    expect(worthOffering([])).toBe(false);
    expect(worthOffering([{ path: "a.md", bytes: 0 }])).toBe(false);
    expect(worthOffering([{ path: "a.md", bytes: 12 }])).toBe(true);
  });
});

describe("distillation", () => {
  test("a turn ends by asking what the room should keep", () => {
    const closing = closingInstruction();

    expect(closing).toContain("workroom://memory/remember");
    expect(closing.length).toBeGreaterThan(80);
  });

  test("the question is appended to the turn, not sent as a second one", () => {
    // A second prompt is a second model call the person pays for, on every
    // turn, whether or not there was anything worth keeping.
    const body = withClosing("Summarise the Acme call.");

    expect(body.startsWith("Summarise the Acme call.")).toBe(true);
    expect(body).toContain(closingInstruction());
  });

  test("it does not tell the agent to keep something regardless", () => {
    // An entry the agent did not choose is an entry nobody will correct.
    const closing = closingInstruction().toLowerCase();

    expect(closing).toMatch(/if|when|only/);
    expect(closing).not.toMatch(/always (record|remember|write)/);
  });

  test("an empty turn is left alone", () => {
    expect(withClosing("   ")).toBe("   ");
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("the turn carries the question", () => {
  test("send() wraps the body before prompting", async () => {
    // A source-level guard, and it is one on purpose: `send()` needs a window,
    // so nothing else here can catch the question being quietly dropped. Losing
    // it would be invisible — turns keep working, and the room stops learning.
    const source = await readFile(resolve(__dirname, "../src/main.ts"), "utf8");

    expect(source).toMatch(/agents\.prompt\(\s*name,\s*sessionId,\s*withClosing\(body\)/);
  });
});

describe("what is happening in the room", () => {
  test("a colleague's agent working is one signal, whatever produced it", () => {
    // The pain this product exists for is not knowing what is going on. A
    // signal computed per surface disagrees with itself.
    const w = new WorkingSignal();
    w.observed({ runId: 1, channel: "meetings", who: "Bob", at: 1000 });

    expect(w.inChannel("meetings")).toEqual([{ who: "Bob", since: 1000 }]);
    expect(w.inChannel("marketing")).toEqual([]);
    expect(w.anywhere()).toEqual([{ who: "Bob", since: 1000, channel: "meetings" }]);
  });

  test("a run that ended stops the signal", () => {
    const w = new WorkingSignal();
    w.observed({ runId: 1, channel: "meetings", who: "Bob", at: 1000 });
    w.ended(1);

    expect(w.inChannel("meetings")).toEqual([]);
  });

  test("the same person working twice in a room is one line, not two", () => {
    const w = new WorkingSignal();
    w.observed({ runId: 1, channel: "meetings", who: "Bob", at: 1000 });
    w.observed({ runId: 2, channel: "meetings", who: "Bob", at: 2000 });

    expect(w.inChannel("meetings")).toEqual([{ who: "Bob", since: 1000 }],
      "since the earliest, so the elapsed time does not reset mid-work");
  });

  test("one ending run does not silence the other", () => {
    const w = new WorkingSignal();
    w.observed({ runId: 1, channel: "meetings", who: "Bob", at: 1000 });
    w.observed({ runId: 2, channel: "meetings", who: "Bob", at: 2000 });
    w.ended(1);

    expect(w.inChannel("meetings")).toEqual([{ who: "Bob", since: 2000 }]);
  });

  test("what it says, for a room and for the sidebar", () => {
    const w = new WorkingSignal();
    expect(w.label("meetings")).toBeNull();

    w.observed({ runId: 1, channel: "meetings", who: "Bob", at: 1000 });
    expect(w.label("meetings")).toBe("Bob's agent is working");

    w.observed({ runId: 2, channel: "meetings", who: "Dana", at: 1100 });
    expect(w.label("meetings")).toBe("2 agents are working");
  });
});

describe("a day at a time", () => {
  test("a divider is dated, and the recent days are named", () => {
    const today = new Date("2026-07-31T12:00:00Z");

    expect(dayLabel("2026-07-31T09:00:00Z", today)).toBe("Today");
    expect(dayLabel("2026-07-30T09:00:00Z", today)).toBe("Yesterday");
    expect(dayLabel("2026-07-24T09:00:00Z", today)).toMatch(/24/);
  });

  test("a row carries the time of day, in the timezone the record carries", () => {
    expect(timeLabel("2026-07-31T09:05:00Z")).toBe("09:05");
    expect(timeLabel("2026-07-31T23:59:59.573+03:00")).toBe("23:59");
    expect(timeLabel("not a timestamp")).toBe("");
  });
});

describe("the first-run setup", () => {
  const agents = [
    { name: "claude", label: "Claude", state: "ready" as const, running: false },
    { name: "codex", label: "Codex", state: "missing" as const, running: false },
  ];

  test("the one thing a card does follows from its state, not from the drawing", () => {
    const cards = onboardingCards(agents);
    expect(cards.map((c) => c.action)).toEqual([ "start", "install" ]);
    expect(onboardingCards([ { ...agents[0], running: true } ])[0].action).toBe("stop");
  });

  test("worth finishing once one agent can be addressed", () => {
    expect(anyReady(onboardingCards(agents))).toBe(true);
    expect(anyReady(onboardingCards([ agents[1] ]))).toBe(false);
    expect(anyReady([])).toBe(false);
  });
});

describe("unread", () => {
  test("what arrived since you last looked", () => {
    expect(unreadCount(7, 5)).toBe(2);
    expect(unreadCount(6, 6)).toBe(0);
    expect(unreadCount(5, undefined)).toBe(0,
      "a channel you have never opened is not a channel full of unread");
    expect(unreadCount(3, 5)).toBe(0, "a room cannot owe you a negative number of messages");
  });
});

describe("threads", () => {
  const room = { id: 1, parent_id: null, author: { kind: "user", name: "Alice" } };
  const asked = { id: 2, parent_id: null, author: { kind: "user", name: "Alice" } };
  const answered = { id: 3, parent_id: 2, author: { kind: "agent", name: "Alice" } };
  const replied = { id: 4, parent_id: 2, author: { kind: "user", name: "Bob" } };
  const alsoReplied = { id: 5, parent_id: 2, author: { kind: "user", name: "Dana" } };

  test("an agent's answer belongs to the room, even though it is a reply", () => {
    // The answer is the work, not a side conversation. Hiding it in a panel
    // leaves the room full of questions and no answers.
    expect(inTimeline(answered)).toBe(true);
  });

  test("a person replying is starting a side conversation", () => {
    expect(inTimeline(replied)).toBe(false);
    expect(inTimeline(room)).toBe(true);
  });

  test("a thread is its root and everything hanging off it, in order", () => {
    const all = [ room, asked, answered, replied, alsoReplied ];

    expect(threadOf(all, 2).map((m) => m.id)).toEqual([ 2, 3, 4, 5 ]);
    expect(threadOf(all, 1).map((m) => m.id)).toEqual([ 1 ], "a message nobody answered is a thread of one");
  });

  test("the summary says how many replied, and who", () => {
    expect(threadSummary([])).toBeNull();
    expect(threadSummary([ replied ])).toBe("1 reply · Bob");
    expect(threadSummary([ replied, alsoReplied ])).toBe("2 replies · Bob, Dana");
  });

  test("the summary counts a person twice as one voice", () => {
    const again = { id: 6, parent_id: 2, author: { kind: "user", name: "Bob" } };

    expect(threadSummary([ replied, again ])).toBe("2 replies · Bob");
  });

  test("an agent's answer is not counted as somebody replying", () => {
    // It is already in the room. Counting it would advertise a conversation
    // that never happened.
    expect(threadSummary([ answered ])).toBeNull();
    expect(threadSummary([ answered, replied ])).toBe("1 reply · Bob");
  });
});

describe("who said it", () => {
  test("a person is recognisable before you read the name", () => {
    const alice = identity({ kind: "user", name: "Alice Ruiz" });

    expect(alice.initials).toBe("AR");
    expect(alice.hue).toBe(identity({ kind: "user", name: "Alice Ruiz" }).hue,
      "the same person is the same colour every time");
    expect(alice.isAgent).toBe(false);
  });

  test("one name is one letter, and an empty one does not crash the room", () => {
    expect(identity({ kind: "user", name: "Alice" }).initials).toBe("A");
    expect(identity({ kind: "user", name: "  " }).initials).toBe("?");
  });

  test("two people are not the same colour by accident of length", () => {
    expect(identity({ kind: "user", name: "Alice" }).hue)
      .not.toBe(identity({ kind: "user", name: "Bob" }).hue);
  });

  test("an agent is marked as one, and carries its owner's colour", () => {
    // It is Alice's agent, not a second Alice and not a stranger.
    const alice = identity({ kind: "user", name: "Alice" });
    const hers = identity({ kind: "agent", name: "Alice" });

    expect(hers.isAgent).toBe(true);
    expect(hers.hue).toBe(alice.hue);
    expect(hers.initials).toBe("A");
  });
});

describe("a long history", () => {
  test("only the recent part is on screen", () => {
    const messages = Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }));

    const shown = onScreen(messages, 200);
    expect(shown.messages).toHaveLength(200);
    expect(shown.messages[0].id).toBe(301, "the recent end, not the start");
    expect(shown.hidden).toBe(300);
  });

  test("a short history is all of it, with nothing hidden", () => {
    const messages = [ { id: 1 }, { id: 2 } ];

    expect(onScreen(messages, 200)).toEqual({ messages, hidden: 0 });
  });
});

describe("where a channel works", () => {
  test("a channel with no binding uses the directory derived for it", () => {
    expect(boundFolder("meetings", {})).toBeNull();
  });

  test("a channel bound to a folder works there", () => {
    expect(boundFolder("billing", { billing: "/home/alice/src/billing" }))
      .toBe("/home/alice/src/billing");
  });

  test("a binding belongs to one channel, not to all of them", () => {
    const bindings = { billing: "/home/alice/src/billing" };

    expect(boundFolder("meetings", bindings)).toBeNull();
  });

  test("a binding that is only whitespace is not a binding", () => {
    expect(boundFolder("billing", { billing: "   " })).toBeNull();
  });
});

describe("what a run produced in somebody's own folder", () => {
  test("more than a handful is the sign of a build, not of work", () => {
    // One `npm install` in a bound folder turns the offer into thousands of
    // files. An offer nobody can read is worse than no offer.
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `out/${i}.js`, bytes: 10 }));

    const offer = offerable(many, 12);
    expect(offer.files).toHaveLength(12);
    expect(offer.omitted).toBe(28);
  });

  test("a handful is offered whole, with nothing omitted", () => {
    const few = [ { path: "report.md", bytes: 10 }, { path: "chart.png", bytes: 20 } ];

    expect(offerable(few, 12)).toEqual({ files: few, omitted: 0 });
  });

  test("an empty file is not work product, whatever the count", () => {
    const files = [ { path: "report.md", bytes: 12 }, { path: "empty.log", bytes: 0 } ];

    expect(offerable(files, 12).files).toEqual([ { path: "report.md", bytes: 12 } ]);
  });
});

describe("a bridge that does not answer", () => {
  test("a call that never settles does not hold the room shut", async () => {
    // The room is the product; whatever the agent registry has to say can be
    // said after it is on screen. An await with no timeout assumes the other
    // side always answers, and "usually" is what leaves somebody staring at a
    // blank window with nothing to report.
    const never = new Promise<string[]>(() => {});

    expect(await orAfter(never, 30, [])).toEqual([]);
  });

  test("an answer that arrives is the answer", async () => {
    expect(await orAfter(Promise.resolve([ "opencode" ]), 500, [])).toEqual([ "opencode" ]);
  });

  test("a call that fails is not a reason to stop either", async () => {
    expect(await orAfter(Promise.reject(new Error("bridge is gone")), 500, [])).toEqual([]);
  });
});

describe("the rail, as the protocol describes it", () => {
  test("a header is a name and a value, not a key on an object", () => {
    // Sent as an object the agent reaches the rail unauthenticated, every call
    // comes back 401, and it answers from nothing.
    const [ server ] = mcpServersFor({ url: "http://127.0.0.1:3000/api/v1/rail/meetings", token: "tok" }) as any[];

    expect(server.type).toBe("http");
    expect(server.url).toBe("http://127.0.0.1:3000/api/v1/rail/meetings");
    expect(server.headers).toEqual([ { name: "Authorization", value: "Bearer tok" } ]);
    expect(Array.isArray(server.headers)).toBe(true);
  });

  test("no rail is no server, not a server with no address", () => {
    expect(mcpServersFor(undefined)).toEqual([]);
  });
});

describe("the agent asking to do something", () => {
  const ask = {
    id: 7,
    request: {
      method: "session/request_permission",
      params: {
        sessionId: "ses_1",
        toolCall: { toolCallId: "call_1", title: "Run the migration" },
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    },
  };

  test("the question reaches the person with what was asked and the choices given", () => {
    const asked = permissionAsked(ask)!;

    expect(asked.id).toBe(7);
    expect(asked.title).toBe("Run the migration");
    expect(asked.options.map((o) => o.id)).toEqual([ "yes", "always", "no" ]);
    expect(asked.options[0].name).toBe("Allow once");
  });

  test("the options are the agent's, not ours", () => {
    // An agent that offers one way to say yes must not be given two, and one
    // that offers none must not have one invented for it.
    const spare = { id: 1, request: { method: "session/request_permission",
      params: { options: [ { optionId: "only", name: "Fine", kind: "allow_once" } ] } } };

    expect(permissionAsked(spare)!.options).toHaveLength(1);
  });

  test("a question with no title still says something", () => {
    const bare = { id: 1, request: { method: "session/request_permission", params: { options: [] } } };

    expect(permissionAsked(bare)!.title).toBe("The agent is asking to do something");
  });

  test("anything that is not a permission request is not one", () => {
    expect(permissionAsked({ id: 1, request: { method: "fs/read_text_file", params: {} } })).toBeNull();
    expect(permissionAsked({ id: 1, request: {} })).toBeNull();
  });

  test("a question says which turn is asking", () => {
    // Without it, a dialog for one channel's agent is shown as though this
    // channel's agent had asked — and `agent_permit` answers by request id, so
    // the person authorises a call they were never shown (#91).
    const asked = permissionAsked({
      id: 7,
      request: { method: "session/request_permission",
                 params: { sessionId: "s-meetings", options: [] } },
    })!;

    expect(asked.sessionId).toBe("s-meetings");
  });

  test("forgetting one agent does not forget the one whose name starts the same", () => {
    // An agent's process ended, so its sessions are gone with it. `claude` and
    // `claude-next` are two agents, and matching on the bare name takes both.
    const keys = [ sessionKey("claude", "general"), sessionKey("claude", "acme"),
                   sessionKey("claude-next", "general"), sessionKey("opencode", "general") ];

    expect(keysOf("claude", keys)).toEqual([ "claude/general", "claude/acme" ]);
    expect(keysOf("claude-next", keys)).toEqual([ "claude-next/general" ]);
    expect(keysOf("nobody", keys)).toEqual([]);
  });

  test("a string id survives, because Number(\"perm-1\") answers nobody", () => {
    // JSON-RPC allows a string id. Coerced to a number it becomes NaN, the
    // answer quotes null, and the agent waits for the rest of the session (#96).
    const stringy = { id: "perm-1", request: { method: "session/request_permission",
      params: { options: [ { optionId: "yes", name: "Allow once" } ] } } };

    expect(permissionAsked(stringy)!.id).toBe("perm-1");
  });

  test("the id goes back exactly as it came, whatever it was", () => {
    expect(permissionAsked({ ...ask, id: 0 })!.id).toBe(0);
    expect(permissionAsked({ ...ask, id: "0" })!.id).toBe("0");
  });
});

describe("a step somebody will read", () => {
  test("a tool call is named by what it is", () => {
    expect(translateAcp({ method: "session/update", params: { update: {
      sessionUpdate: "tool_call", toolCallId: "call_00_hWMqa5NQ", title: "Search the room" } } }))
      .toEqual({ kind: "tool", label: "Search the room" });
  });

  test("an update with nothing to say is not a step", () => {
    // `tool_call_update` refines a call already recorded. Falling back to its id
    // puts `call_00_hWMqa5NQZWoHwgQfxDg70485` in front of a colleague, which
    // tells them nothing and crowds out what does.
    expect(translateAcp({ method: "session/update", params: { update: {
      sessionUpdate: "tool_call_update", toolCallId: "call_00_hWMqa5NQ", status: "completed" } } }))
      .toBeNull();
  });

  test("an update that does have something to say is kept", () => {
    expect(translateAcp({ method: "session/update", params: { update: {
      sessionUpdate: "tool_call_update", toolCallId: "call_1", title: "Read the entry" } } }))
      .toEqual({ kind: "tool", label: "Read the entry" });
  });
});

describe("staying current", () => {
  test("a newer release is worth telling somebody about", () => {
    expect(updateNotice({ current: "0.1.0", available: "0.2.0" }))
      .toBe("WorkRoom 0.2.0 is available. You have 0.1.0.");
  });

  test("the same version is not news", () => {
    expect(updateNotice({ current: "0.2.0", available: "0.2.0" })).toBeNull();
  });

  test("an older release is not an update", () => {
    // A rollback is a decision somebody makes deliberately, not one an endpoint
    // makes for them by serving an old manifest.
    expect(updateNotice({ current: "0.3.0", available: "0.2.0" })).toBeNull();
  });

  test("versions are compared as numbers, not as text", () => {
    expect(updateNotice({ current: "0.9.0", available: "0.10.0" }))
      .toBe("WorkRoom 0.10.0 is available. You have 0.9.0.");
    expect(updateNotice({ current: "0.10.0", available: "0.9.0" })).toBeNull();
  });

  test("a version nobody can parse is not an update", () => {
    expect(updateNotice({ current: "0.1.0", available: "nightly" })).toBeNull();
  });
});

describe("a client and a workspace that have drifted apart", () => {
  test("a client older than its workspace is worth saying out loud", () => {
    // The failure is not an error. It is a feature that quietly does nothing,
    // which is the most expensive kind.
    expect(driftNotice("0.1.0", "0.3.0"))
      .toBe("This workspace is running 0.3.0 and this app is 0.1.0. Some things here may not work.");
  });

  test("a client newer than its workspace is the same problem the other way", () => {
    expect(driftNotice("0.3.0", "0.1.0"))
      .toBe("This app is 0.3.0 and the workspace is running 0.1.0. Some things here may not work.");
  });

  test("agreement is silence", () => {
    expect(driftNotice("0.2.0", "0.2.0")).toBeNull();
    expect(driftNotice("0.2.0", undefined)).toBeNull();
  });

  test("a patch apart is not drift", () => {
    // Client and server ship together and will always be a few commits apart.
    // Saying so on every launch teaches people to ignore the one that matters.
    expect(driftNotice("0.2.1", "0.2.4")).toBeNull();
  });
});

describe("a session that survives a restart", () => {
  test("what the agent was thinking is process, and it is kept", () => {
    // The one update kind that lets somebody reconstruct why a turn went the way
    // it did. Recorded against the run, never pushed at the room.
    expect(translateAcp({ method: "session/update", params: { update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking the rail first" } } } }))
      .toEqual({ kind: "thought", text: "checking the rail first" });
  });

  test("a thought with nothing in it is nothing", () => {
    expect(translateAcp({ method: "session/update", params: { update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } } } })).toBeNull();
  });

  test("a session is remembered per agent and channel, and survives the app", () => {
    const store: Record<string, string> = {};
    remember(store, "opencode", "meetings", "ses_1");
    remember(store, "claude", "meetings", "ses_2");

    expect(recall(store, "opencode", "meetings")).toBe("ses_1");
    expect(recall(store, "claude", "meetings")).toBe("ses_2");
    expect(recall(store, "opencode", "marketing")).toBeUndefined();
  });

  test("forgetting one agent's session leaves the others", () => {
    const store: Record<string, string> = {};
    remember(store, "opencode", "meetings", "ses_1");
    remember(store, "claude", "meetings", "ses_2");
    forget(store, "opencode", "meetings");

    expect(recall(store, "opencode", "meetings")).toBeUndefined();
    expect(recall(store, "claude", "meetings")).toBe("ses_2");
  });
});

describe("the shape a room can be added with", () => {
  const strategy = { key: "strategy", name: "Strategy", purpose: "Where the company is going, and why",
                     skills: [ "Writing an objective" ], taken: false };
  const legal = { key: "legal", name: "Legal", purpose: "Contracts, and what we agreed",
                  skills: [], taken: true };
  const hiring = { key: "hiring", name: "Hiring", purpose: "Roles, and what we decided",
                   skills: [], taken: false };

  test("a room this workspace already has is listed and cannot be picked", () => {
    // Both halves matter: dropping it would leave somebody hunting for a shape
    // they remember, and offering it would ask the server for a duplicate slug.
    expect(pickable(strategy)).toBe(true);
    expect(pickable(legal)).toBe(false);
    expect(templateNote(legal)).toContain("already has one");
  });

  test("what a template opens the room knowing is said, and never promised emptily", () => {
    expect(templateNote(strategy)).toBe(
      "Where the company is going, and why · opens knowing writing an objective");
    expect(templateNote(hiring)).toBe("Roles, and what we decided");
  });

  test("a chosen template travels as its key alone", () => {
    // Not its name: that is the server's, and a copy sent from here would drift
    // the first time channel_templates.yml is edited.
    expect(channelToCreate({ slug: "strategy", name: "Strategy", template: "strategy" }))
      .toEqual({ template: "strategy" });
  });

  test("a room somebody named themselves is those fields, and no template", () => {
    expect(channelToCreate({ slug: "pricing", name: "Pricing" }))
      .toEqual({ slug: "pricing", name: "Pricing" });
  });

  test("an address with no name is still a room", () => {
    expect(channelToCreate({ slug: "pricing" })).toEqual({ slug: "pricing", name: "pricing" });
  });

  test("a cancelled dialog asks for nothing", () => {
    expect(channelToCreate(null)).toBeNull();
    expect(channelToCreate({ name: "Pricing" })).toBeNull();
  });
});

// ---------- the client, driven ----------
//
// What follows drives main.ts itself — the real composer, the real boot chain,
// the real notice strip — with the two edges standing in: the server it talks
// to over HTTP, and the local bridge it talks to over Tauri. A notice is a
// thing on screen and a blocking dialog is a thing that is not, so this is the
// only place the difference between them can be measured; and no source-level
// guard can see whether the text somebody typed survived a failed send.

const edge = vi.hoisted(() => ({
  server: null as any,
  bridge: null as any,
  /// The native side. Held here rather than in the mock factory because
  /// `vi.resetModules()` re-runs the factory between clients, and a bridge that
  /// does not answer has to be arranged per test.
  shell: null as any,
}));

vi.mock("../src/api", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  Api: class { constructor() { return edge.server; } },
}));

vi.mock("../src/agent", () => ({ Agents: class { constructor() { return edge.bridge; } } }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => edge.shell.invoke(...a) }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: () => edge.shell.appDataDir(),
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

const room = (await readFile(resolve(__dirname, "../index.html"), "utf8"))
  .replace(/[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*/, "")
  .replace(/<script[\s\S]*?<\/script>/g, "");

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

function aServer(over: Record<string, unknown> = {}) {
  const said = { id: 5, channel_id: 1, parent_id: null, body: "hello",
                 author: { kind: "user", id: 1, name: "Alice", email: "alice@farol.run" },
                 created_at: "2026-07-31T09:00:00Z" };
  const channel = { id: 1, slug: "meetings", name: "Meetings", purpose: "What we decided",
                    visibility: "workspace", memory_uri: "mem://meetings", message_count: 1 };
  const ok = (value: unknown) => vi.fn(async () => value);
  return {
    token: "tok",
    useToken: vi.fn(),
    rail: vi.fn(() => ({ url: "http://server/api/v1/rail/meetings", token: "tok" })),
    methods: ok({ development: true, provider: false, version: "0.1.0" }),
    signIn: ok({ token: "tok", user: { id: 1, email: "alice@farol.run", name: "Alice" } }),
    whoAmI: ok({ user: { id: 1, email: "alice@farol.run", name: "Alice" } }),
    workspaces: ok([]),
    channels: ok([ channel ]),
    channel: ok({ ...channel, messages: [ said ] }),
    live: vi.fn(() => ({ close: vi.fn() })),
    members: ok([]), workspaceMembers: ok([]), memory: ok([]), skills: ok([]),
    invitations: ok([]), channelTemplates: ok([]),
    post: ok(said),
    context: ok({ context: null, memory_uri: "mem://meetings", boundary: "Stay here.", store: null }),
    startRun: ok({ id: 7, agent_session_id: 1 }),
    agentSay: ok({ ...said, id: 9 }),
    finishRun: ok(undefined), step: ok(undefined), plan: ok(undefined), reportUsage: ok(undefined),
    attachArtifact: ok(undefined), attachBytes: ok(undefined), writeSkill: ok(undefined),
    createChannel: ok(channel), createWorkspace: ok({ slug: "globex", name: "Globex", role: "owner", token: "t2" }),
    acceptInvitation: ok({ workspace: { slug: "globex", name: "Globex" }, role: "member", token: "t2" }),
    addMember: ok({ id: 2, name: "Bob", handle: "bob" }),
    invite: ok({ code: "abc", email: null, role: "member", expires_at: "" }),
    ...over,
  };
}

function aBridge(over: Record<string, unknown> = {}) {
  let heard: ((u: unknown) => void) | null = null;
  return {
    definitions: () => [ { name: "claude", command: "claude", args: [] } ],
    use: vi.fn(), markRunning: vi.fn(), rememberConfig: vi.fn(),
    isRunning: () => true, stateOf: () => "ready", modelFor: () => undefined, configFor: () => [],
    probe: vi.fn(async () => {}),
    listRunning: vi.fn(async () => [ "claude" ]),
    onClosed: vi.fn(async () => {}),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    workspace: vi.fn(async () => "/tmp/work"),
    sessionFor: vi.fn(async () => "s1"),
    setConfig: vi.fn(async () => []),
    onAsk: vi.fn(async () => () => {}),
    onUpdate: vi.fn(async (_id: string, cb: (u: unknown) => void) => { heard = cb; return () => {}; }),
    prompt: vi.fn(async () => { heard?.({ kind: "text", text: "here you go" }); }),
    cancel: vi.fn(async () => {}), produced: vi.fn(async () => []),
    exportSession: vi.fn(async () => null), permit: vi.fn(async () => {}),
    releaseChannel: vi.fn(async () => {}),
    install: vi.fn(async () => ({ ok: true, code: 0, stdoutTail: "", stderrTail: "" })),
    ...over,
  };
}

function aShell(over: Record<string, unknown> = {}) {
  return {
    invoke: vi.fn(async () => ""),
    appDataDir: vi.fn(async () => "/data"),
    ...over,
  };
}

/// Every native dialog the client puts up, counted. It should be none: a modal
/// that stops the window is not how an application somebody keeps open all day
/// reports that one request failed.
const blockingDialog = vi.fn();

interface Edges { server?: any; bridge?: any; shell?: any }

/// One window, opened as a person opens it: the document index.html ships,
/// the sign-in dialog answered, the room loaded. `atSignIn` runs while that
/// dialog is still up, which is the only moment some of its buttons exist.
async function openTheClient(
  { server = aServer(), bridge = aBridge(), shell = aShell() }: Edges = {},
  atSignIn?: () => Promise<void>,
) {
  document.body.innerHTML = room;
  localStorage.clear();
  localStorage.setItem("workroom.onboarded", "done");   // setup has had its say already
  vi.stubGlobal("alert", blockingDialog);
  edge.server = server;
  edge.bridge = bridge;
  edge.shell = shell;
  vi.resetModules();
  await import("../src/main");
  await settle();
  if (atSignIn) await atSignIn();
  document.querySelector<HTMLDialogElement>("#signin")!.close("ok");
  await settle();
  return { server, bridge, shell };
}

/// What the room is saying, read as the notices `say()` puts up rather than as
/// the strip's text. The difference is the whole point of the card: a failure
/// has to arrive on the surface the room already uses for everything it tells
/// somebody, and text written into that dock any other way is not that.
const notices = () =>
  [ ...document.querySelectorAll<HTMLElement>("#notices .notice") ]
    .map((notice) => notice.textContent ?? "").join("\n");
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const submit = (id: string) =>
  el(id).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

/// A request this test holds open, so what the window does *while* one is in
/// flight can be measured at all. `settle()` drains everything pending, and
/// what it drains is exactly where an optimistic clear hides: a composer that
/// empties only once the server has answered looks identical afterwards.
function heldOpen<T = unknown>() {
  let answer!: (value: T) => void;
  let refuse!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; });
  return { promise, answer, refuse };
}

afterEach(() => { blockingDialog.mockClear(); vi.unstubAllGlobals(); });

describe("a client whose edges all answer", () => {
  test("says nothing, so a notice below means something failed", async () => {
    // The control the rest of this section rests on. Without it, an
    // unconditional notice at boot would satisfy every expectation below.
    await openTheClient();

    expect(el("channel-name").textContent).toBe("# meetings");
    expect(notices()).toBe("");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("clears the composer while the message is still in flight", async () => {
    // The optimistic clear stays, and it is only observable before the server
    // answers — so the answer is withheld until it has been looked at. Keeping
    // the text on failure must not be bought by emptying the composer once the
    // post comes back: that trades a lost sentence for a composer that lags
    // the room on every message anybody sends.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({ post: vi.fn(() => inFlight.promise) }) });
    el<HTMLInputElement>("input").value = "what did we agree about pricing?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalled();
    expect(el<HTMLInputElement>("input").value).toBe("");

    inFlight.answer({ id: 5 });
    await settle();

    expect(el<HTMLInputElement>("input").value).toBe("");
    expect(notices()).toBe("");
  });
});

describe("what the room says when something goes wrong", () => {
  test("a send that does not go through keeps what the person typed", async () => {
    // The composer clears optimistically, which is right — and until now the
    // failure took the sentence with it. Somebody who learns that lesson starts
    // copying every message before pressing Send.
    //
    // Both halves in one example, because the cheapest way to keep the text is
    // to stop clearing until the server answers, and that would read as green
    // in an example that only looks at the end.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({ post: vi.fn(() => inFlight.promise) }) });
    el<HTMLInputElement>("input").value = "what did we agree about pricing?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalled();
    expect(el<HTMLInputElement>("input").value).toBe("");

    inFlight.refuse(new Error("500 the server said no"));
    await settle();

    expect(el<HTMLInputElement>("input").value).toBe("what did we agree about pricing?");
    expect(notices()).toContain("the server said no");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a turn that fails after the message landed leaves the composer empty", async () => {
    // The other side of the line, and the reason the restore belongs to the
    // post rather than to the whole turn: everything after `api.post` happens
    // with the sentence already in the room. Putting it back would invite the
    // person to press Send on a message the channel already has, and they
    // would — the composer refilling itself reads as "that did not go".
    const { server } = await openTheClient({
      server: aServer({ startRun: vi.fn(async () => { throw new Error("500 the run never started"); }) }),
    });
    el<HTMLInputElement>("input").value = "@claude what did we agree?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalledWith("meetings", "what did we agree?");
    expect(server.startRun).toHaveBeenCalled();
    expect(el<HTMLInputElement>("input").value).toBe("");
    expect(notices()).toContain("the run never started");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a reply that does not go through keeps it too", async () => {
    // A reply is a send. The panel clears its box the same way the room does,
    // so it loses the same sentence, and fixing one of the two is fixing half
    // a defect — including the half that says the box empties on the press.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({ post: vi.fn(() => inFlight.promise) }) });
    document.querySelector<HTMLButtonElement>("#messages .reply-action")!.click();
    el<HTMLInputElement>("thread-input").value = "agreed, and I will write it up";

    submit("thread-composer");
    await settle();

    expect(server.post).toHaveBeenCalled();
    expect(el<HTMLInputElement>("thread-input").value).toBe("");

    inFlight.refuse(new Error("500 the thread is gone"));
    await settle();

    expect(el<HTMLInputElement>("thread-input").value).toBe("agreed, and I will write it up");
    expect(notices()).toContain("the thread is gone");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  /// Every other surface that can fail: the edge that refuses, the press a
  /// person makes, and what has to be readable in the room afterwards. Table
  /// rather than a test each, because the expectation is the same sentence
  /// sixteen times — and `attempted` is what keeps a green honest, since a
  /// drive that never reached the failing call would also leave the strip
  /// empty and no dialog behind.
  const operational: Array<{
    what: string;
    edges: () => Edges;
    drive: (edges: Edges) => Promise<void>;
    attempted: (edges: any) => unknown;
    said: string;
  }> = [
    {
      what: "an agent that will not start",
      edges: () => ({ bridge: aBridge({
        isRunning: () => false,
        start: vi.fn(async () => { throw new Error("claude exited 1"); }),
      }) }),
      // The row's second button is its one action, which for a ready agent
      // that is not running says Start.
      drive: async () => {
        document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button")[1].click();
        await settle();
      },
      attempted: (edges) => edges.bridge.start,
      said: "claude exited 1",
    },
    {
      what: "an agent that will not stop",
      // The same row, the other press. Starting fails inside `toggleAgent` and
      // stopping fails out of it, so they are two catches and one of them has
      // never been looked at.
      edges: () => ({ bridge: aBridge({
        stop: vi.fn(async () => { throw new Error("the process would not stop"); }),
      }) }),
      drive: async () => {
        document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button")[1].click();
        await settle();
      },
      attempted: (edges) => edges.bridge.stop,
      said: "the process would not stop",
    },
    {
      what: "an install the bridge never ran",
      // The other way an install fails: not npm saying no, but nothing on this
      // machine answering at all. It arrives as a rejection rather than a
      // result, at a different call site, and reads the same to the person.
      edges: () => ({ bridge: aBridge({
        definitions: () => [ { name: "codex", command: "codex-acp", args: [] } ],
        isRunning: () => false,
        stateOf: () => "missing",
        install: vi.fn(async () => { throw new Error("no answer from this machine"); }),
      }) }),
      drive: async () => {
        document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button")[1].click();
        await settle();
      },
      attempted: (edges) => edges.bridge.install,
      said: "no answer from this machine",
    },
    {
      what: "a skill the room did not accept",
      edges: () => ({ server: aServer({
        writeSkill: vi.fn(async () => { throw new Error("422 the title is taken"); }),
      }) }),
      drive: async () => {
        el("memory-toggle").click();
        await settle();
        el<HTMLInputElement>("skill-title").value = "Running a client call";
        el<HTMLTextAreaElement>("skill-body").value = "Agenda out the day before.";
        submit("skill-form");
        await settle();
      },
      attempted: (edges) => edges.server.writeSkill,
      said: "the title is taken",
    },
    {
      what: "a workspace that was not made",
      edges: () => ({ server: aServer({
        createWorkspace: vi.fn(async () => { throw new Error("409 that name is taken"); }),
      }) }),
      drive: async () => {
        el("workspace-new").click();
        await settle();
        el<HTMLInputElement>("make-name").value = "Globex";
        el<HTMLInputElement>("make-slug").value = "globex";
        el<HTMLDialogElement>("make").close("go");
        await settle();
      },
      attempted: (edges) => edges.server.createWorkspace,
      said: "that name is taken",
    },
    {
      what: "a channel that was not made",
      edges: () => ({ server: aServer({
        createChannel: vi.fn(async () => { throw new Error("422 that address is in use"); }),
      }) }),
      drive: async () => {
        el("channel-new").click();
        await settle();
        el<HTMLInputElement>("make-name").value = "Pricing";
        el<HTMLInputElement>("make-slug").value = "pricing";
        el<HTMLDialogElement>("make").close("go");
        await settle();
      },
      attempted: (edges) => edges.server.createChannel,
      said: "that address is in use",
    },
    {
      what: "an answer the agent would not take",
      edges: () => ({ bridge: aBridge({
        permit: vi.fn(async () => { throw new Error("the session is gone"); }),
      }) }),
      drive: async (edges: any) => {
        el<HTMLInputElement>("input").value = "@claude run the tests";
        submit("composer");
        await settle();
        // The ask, as the agent raises it mid-turn, through the callback the
        // client registered for exactly that.
        edges.bridge.onAsk.mock.calls[0][1]({
          id: 1, title: "Run the tests?", options: [ { id: "yes", name: "Yes" } ],
        });
        document.querySelector<HTMLButtonElement>("#messages .offer.ask button")!.click();
        await settle();
      },
      attempted: (edges) => edges.bridge.permit,
      said: "the session is gone",
    },
    {
      what: "a session option that would not change",
      edges: () => ({ bridge: aBridge({
        configFor: () => [ { id: "model", name: "Model", type: "select", currentValue: "haiku",
                             options: [ { value: "haiku", name: "Haiku" },
                                        { value: "opus", name: "Opus" } ] } ],
        setConfig: vi.fn(async () => { throw new Error("that option is gone"); }),
      }) }),
      drive: async () => {
        const select = document.querySelector<HTMLSelectElement>("#session-options select")!;
        select.value = "opus";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      },
      attempted: (edges) => edges.bridge.setConfig,
      said: "that option is gone",
    },
    {
      what: "an offer whose action fails",
      edges: () => ({ server: aServer({
        workspaceMembers: vi.fn(async () => [ { id: 2, name: "Bob", handle: "bob", role: "member" } ]),
        addMember: vi.fn(async () => { throw new Error("403 not yours to add"); }),
      }) }),
      // Every offer and every notice shares one button (`ghostButton`), so this
      // is all of them.
      drive: async () => {
        el<HTMLInputElement>("input").value = "@bob can you look at this";
        submit("composer");
        await settle();
        document.querySelector<HTMLButtonElement>("#notices button")!.click();
        await settle();
      },
      attempted: (edges) => edges.server.addMember,
      said: "not yours to add",
    },
  ];

  test.each(operational)("$what is said in the room, not in a dialog", async (one) => {
    const edges = await openTheClient(one.edges());

    await one.drive(edges);

    expect(one.attempted(edges)).toHaveBeenCalled();
    expect(notices()).toContain(one.said);
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a browser sign-in that fails is a notice, and the door is still open", async () => {
    // The one failure that happens with a modal already on screen — and the
    // notice strip is behind it, in a room this person cannot see yet. It goes
    // there anyway: a native dialog on top of a dialog is the worst of both,
    // and the strip is what they read the moment the sign-in closes.
    //
    // Two things, and neither of them is a sentence: it arrives as a notice
    // rather than as something that stops the window, and it carries what
    // failed. The way back is the button they already pressed, so what makes
    // the failure survivable is that pressing it again asks again.
    const shell = aShell({ invoke: vi.fn(async () => { throw new Error("the browser said no"); }) });
    await openTheClient(
      { server: aServer({ methods: vi.fn(async () => ({ development: true, provider: true, version: "0.1.0" })) }),
        shell },
      async () => {
        el("signin-provider").click();
        await settle();

        expect(shell.invoke).toHaveBeenCalledTimes(1);
        expect(notices()).toContain("the browser said no");
        expect(blockingDialog).not.toHaveBeenCalled();

        expect(el<HTMLButtonElement>("signin-provider").disabled).toBe(false);
        el("signin-provider").click();
        await settle();

        expect(shell.invoke).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("an agent nobody started is a notice that starts it", async () => {
    // The one failure here that is neither the server's nor the machine's: the
    // person addressed an agent that is not running. Their message went to the
    // room before the agent was ever asked, so the notice is about the agent
    // alone — it names which one, because "your agent" is three rows in a
    // panel, and it carries the way out rather than describing it. What the
    // remedy is worded as is the room's business; that pressing it starts the
    // agent that was addressed is not.
    const { server, bridge } = await openTheClient({ bridge: aBridge({ isRunning: () => false }) });
    el<HTMLInputElement>("input").value = "@claude what did we agree?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalledWith("meetings", "what did we agree?");
    expect(server.startRun).not.toHaveBeenCalled();
    expect(bridge.sessionFor).not.toHaveBeenCalled();
    expect(notices()).toMatch(/claude/i);
    // Nothing to restore: this send is the one that worked.
    expect(el<HTMLInputElement>("input").value).toBe("");
    expect(blockingDialog).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>("#notices .notice button")!.click();
    await settle();

    expect(bridge.start).toHaveBeenCalledWith("claude");
  });

  test("an install npm refused says what npm said, and can be pressed again", async () => {
    // The answer to "what did that do to my machine" is npm's own, so it is
    // carried rather than summarised. And the offer survives the refusal: a row
    // that has gone quiet after a failed install is one somebody has to restart
    // the application to use, so the way to know it survived is to use it.
    const { bridge } = await openTheClient({ bridge: aBridge({
      definitions: () => [ { name: "codex", command: "codex-acp", args: [] } ],
      isRunning: () => false,
      stateOf: () => "missing",
      install: vi.fn(async () => ({ ok: false, code: 1, stdoutTail: "",
                                    stderrTail: "npm ERR! 404 not found" })),
    }) });
    const offer = () => document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button")[1];

    offer().click();
    await settle();

    expect(bridge.install).toHaveBeenCalledTimes(1);
    expect(notices()).toContain("npm ERR! 404 not found");
    expect(blockingDialog).not.toHaveBeenCalled();

    expect(offer().disabled).toBe(false);
    offer().click();
    await settle();

    expect(bridge.install).toHaveBeenCalledTimes(2);
  });

  test("a code the server would not take is a notice, and the code survives it", async () => {
    // A code arrives out of band — from a message, a call, a piece of paper —
    // and is typed once. Losing it to a failed redemption costs the person the
    // invitation rather than the attempt, so what survives is the way back in:
    // the code is still in the field, and sending it again is one press.
    const { server } = await openTheClient({ server: aServer({
      acceptInvitation: vi.fn(async () => { throw new Error("410 that code is spent"); }),
    }) });
    el("workspace-join").click();
    await settle();
    el<HTMLInputElement>("join-code").value = "abc-123";

    el<HTMLDialogElement>("join").close("go");
    await settle();

    expect(server.acceptInvitation).toHaveBeenCalledWith("abc-123");
    expect(notices()).toContain("that code is spent");
    expect(el<HTMLInputElement>("join-code").value).toBe("abc-123");
    expect(blockingDialog).not.toHaveBeenCalled();
  });
});

describe("the start-up says which part of it failed", () => {
  /// Three stages, three messages, and each must name its own and only its
  /// own. One message listing all three would be true, useless, and exactly
  /// what `boot().catch(…)` says today: sign-in refused, a room that will not
  /// load and a bridge that is not answering are three different mornings, and
  /// only the person can act on the difference.
  ///
  /// Each pattern names a stage as the thing that failed, rather than a word
  /// that stage tends to use. That is what makes the exclusions safe: "your
  /// agents could not load" is a bridge message and matches nothing here but
  /// the bridge; "agents are unavailable in this channel" is one too, and the
  /// channels pattern does not read on it. What is forbidden of each message
  /// is only the other two stages claiming to be the one that failed.
  const STAGE = {
    signIn: /signing in/i,
    channels: /channels (did not|could not|would not|failed)|(load|loading) (the )?channels/i,
    bridge: /bridge/i,
  };

  test("a sign-in that is refused names signing in, and nothing else", async () => {
    const { server } = await openTheClient({
      server: aServer({ signIn: vi.fn(async () => { throw new Error("401 no account here"); }) }),
    });

    // The other two stages pin how far the boot got by what is on screen;
    // this one is the first thing that happens, so it says so directly.
    expect(server.signIn).toHaveBeenCalled();
    expect(notices()).toMatch(STAGE.signIn);
    expect(notices()).not.toMatch(STAGE.channels);
    expect(notices()).not.toMatch(STAGE.bridge);
    expect(notices()).toContain("401 no account here");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("channels that do not load name the channels, and nothing else", async () => {
    await openTheClient({
      server: aServer({ channels: vi.fn(async () => { throw new Error("503 nothing came back"); }) }),
    });

    // Signed in, and the window says so: the stage that failed is the next one.
    expect(el("who").textContent).toBe("Alice");
    expect(notices()).toMatch(STAGE.channels);
    expect(notices()).not.toMatch(STAGE.signIn);
    expect(notices()).not.toMatch(STAGE.bridge);
    expect(notices()).toContain("503 nothing came back");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a bridge that does not answer names the bridge, and costs the toolbar only", async () => {
    // The agents panel is a detail of the toolbar; the room is the product. A
    // silent native side used to take the whole window down with it and blame
    // the server for it.
    await openTheClient({
      shell: aShell({ appDataDir: vi.fn(async () => { throw new Error("no answer from this machine"); }) }),
    });

    expect(el("channel-name").textContent).toBe("# meetings");
    expect(document.querySelectorAll("#messages .msg").length).toBe(1);
    expect(notices()).toMatch(STAGE.bridge);
    expect(notices()).not.toMatch(STAGE.signIn);
    expect(notices()).not.toMatch(STAGE.channels);
    expect(notices()).toContain("no answer from this machine");
    expect(blockingDialog).not.toHaveBeenCalled();
  });
});

describe("a turn that fails at the end", () => {
  const ask = async () => {
    el<HTMLInputElement>("input").value = "@claude what did we agree?";
    submit("composer");
    await settle();
  };
  const saidByTheAgent = (server: { agentSay: { mock: { calls: unknown[][] } } }) =>
    server.agentSay.mock.calls.map((call) => String(call[1]));

  test("an agent that failed is the agent's failure, and the run failed", async () => {
    // The half that already reads true, kept as the control for the half that
    // does not: the distinction is only worth anything if this stays as it is.
    const { server } = await openTheClient({
      bridge: aBridge({ prompt: vi.fn(async () => { throw new Error("the model refused"); }) }),
    });

    await ask();

    expect(saidByTheAgent(server).join()).toContain("the model refused");
    expect(server.finishRun).toHaveBeenCalledWith(7, "failed");
  });

  test("a reply that could not be posted is ours, not the agent's error", async () => {
    // The agent answered. What failed was this client putting the answer into
    // the room — and writing that into the room as "Agent error" attributes our
    // failure to somebody else's run, which is the one thing the record must
    // not do (Article D3). The run finishes as what it was, and the person is
    // told, in the room, that the answer they are waiting for did not land.
    const { server } = await openTheClient({
      server: aServer({ agentSay: vi.fn(async () => { throw new Error("500 not written"); }) }),
    });

    await ask();

    expect(saidByTheAgent(server)).toContain("here you go");
    expect(saidByTheAgent(server).some((body) => /agent error/i.test(body))).toBe(false);
    expect(server.finishRun).toHaveBeenCalledWith(7, "succeeded");
    // What the room says about it is the room's wording; that it says anything
    // at all, and says what failed, is not.
    expect(notices()).toContain("500 not written");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a status this client could not record is not the agent's error either", async () => {
    // `agentSay` is not the only call in that try. Closing the run is in there
    // too, and a fix that special-cases the reply alone leaves the same
    // mis-attribution one step further down: the agent answered, the room has
    // the answer, and the record would still say the agent errored because
    // this client could not mark the run finished.
    const { server } = await openTheClient({
      server: aServer({ finishRun: vi.fn(async () => { throw new Error("500 status not recorded"); }) }),
    });

    await ask();

    expect(saidByTheAgent(server)).toContain("here you go");
    expect(saidByTheAgent(server).some((body) => /agent error/i.test(body))).toBe(false);
    // Not the agent's error, and not nobody's either: swallowing it leaves a
    // run that reads as still going to everybody looking at the room.
    expect(notices()).toContain("500 status not recorded");
    expect(blockingDialog).not.toHaveBeenCalled();
  });
});

