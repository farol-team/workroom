import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { StepLedger, WorkingSignal, closingInstruction, contentTypeFor, dayLabel, defaultAgent, formatHistory, normalizeAgents, parseAddress, selectable, sessionKey, transcriptName, translateAcp, unreadCount, withClosing, worthOffering } from "../src/rules";

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
