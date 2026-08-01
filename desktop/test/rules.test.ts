import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { StepLedger, WorkingSignal, boundFolder, closingInstruction, driftNotice, forget, keysOf, recall, remember, mcpServersFor, orAfter, permissionAsked, updateNotice, identity, inTimeline, offerable, onScreen, contentTypeFor, dayLabel, defaultAgent, formatHistory, normalizeAgents, parseAddress, selectable, sessionKey, threadOf, threadSummary, transcriptName, translateAcp, unreadCount, withClosing, worthOffering } from "../src/rules";

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

describe("agent definitions", () => {
  test("an entry with no name or no command is not an agent", () => {
    expect(normalizeAgents([
      { name: "", command: "x", args: [] },
      { name: "y", command: "  ", args: [] },
      { name: "opencode", command: "opencode", args: ["acp"] },
    ])).toEqual([{ name: "opencode", command: "opencode", args: ["acp"], default: true }]);
  });

  test("a name that cannot be typed as an address is not an agent", () => {
    // The name is the summons. One that @ cannot reach configures an agent
    // nobody can call, and makes the session key ambiguous besides.
    expect(normalizeAgents([
      { name: "my agent", command: "x", args: [] },
      { name: "-lead", command: "x", args: [] },
      { name: "gpt-5.1_local", command: "x", args: [] },
    ])).toEqual([{ name: "gpt-5.1_local", command: "x", args: [], default: true }]);
  });

  test("one name, one agent — the first definition wins", () => {
    const out = normalizeAgents([
      { name: "claude", command: "first", args: [] },
      { name: "Claude", command: "second", args: [] },
    ]);
    expect(out).toHaveLength(1);
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

  test("nothing configured is not an error — it is opencode", () => {
    expect(normalizeAgents([])).toEqual([
      { name: "opencode", command: "opencode", args: ["acp"], default: true },
    ]);
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
    const [ server ] = mcpServersFor({ url: "http://127.0.0.1:3000/api/rail/meetings", token: "tok" }) as any[];

    expect(server.type).toBe("http");
    expect(server.url).toBe("http://127.0.0.1:3000/api/rail/meetings");
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
