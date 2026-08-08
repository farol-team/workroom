/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
// One test below reads main.ts as text rather than importing it, and asks vite
// for it (`?raw`) rather than node's fs: the specs are typechecked now (#222),
// and node's globals have no types here — nothing else in this window-shaped
// suite reaches the filesystem.
import mainSource from "../src/main.ts?raw";
import apiSource from "../src/api.ts?raw";
import acpTurnSource from "../../bin/acp-turn?raw";
import { StepLedger, WorkingSignal, channelToCreate, enterRoom, mentionsIn, pickable, templateNote, missingFrom, loadRooms, reachableRooms, tokenForRoom, activeAgent, anyReady, boundFolder, closingInstruction, driftNotice, forget, gitAskNote, gitBoundary, githubTreeUrl, keysOf, recall, remember, mcpServersFor, memoryToggleLabel, onboardingCards, orAfter, permissionAsked, preExistingNotice, timeLabel, updateNotice, identity, inTimeline, instructionOf, mirrorEntryOf, MIRROR_README, introductionAsk, offerable, onScreen, contentTypeFor, dayLabel, defaultAgent, formatHistory, normalizeAgents, parseAddress, selectable, sessionKey, sessionOf, threadOf, threadSummary, removeDefinition, splitArgs, transcriptName, transcriptOf, updateOf, unreadCount, upsertDefinition, visibilityNote, withClosing, worthOffering } from "../src/rules";

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
  test("every event says which session it belongs to", () => {
    // Read from neither shape once, so what an agent said was routed by
    // whoever happened to be listening (#91). The bridge tags it now (#312).
    expect(sessionOf({ kind: "text", session: "s1", text: "hi" })).toBe("s1");
    expect(sessionOf({ kind: "permission", session: "s2", request: {} })).toBe("s2");
  });

  test("an event that names no session belongs to no turn", () => {
    expect(sessionOf({ kind: "closed", diagnostics: [] })).toBeUndefined();
    expect(sessionOf({ kind: "text", session: "" })).toBeUndefined();
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

describe("what the room shows for one event", () => {
  // The frames are read by the shared client; what arrives here is already in
  // the room's vocabulary, and this is the view that renders it (#312).

  test("agent text becomes text", () => {
    expect(updateOf({ kind: "text", session: "s1", text: "hi" }))
      .toEqual({ kind: "text", text: "hi" });
  });

  test("an empty chunk is not an update", () => {
    expect(updateOf({ kind: "text", text: "" })).toBeNull();
  });

  test("reasoning is kept apart from the answer", () => {
    // Process is recorded and never pushed at the room; shown as an answer it
    // would be the agent thinking out loud at everybody.
    expect(updateOf({ kind: "thought", text: "let me look" }))
      .toEqual({ kind: "thought", text: "let me look" });
  });

  test("a tool call becomes a step label", () => {
    expect(updateOf({ kind: "tool", title: "search memory", toolKind: "other", update: false }))
      .toEqual({ kind: "tool", label: "search memory" });
  });

  test("a plan becomes a plan, with its entries", () => {
    const entries = [ { content: "Read the deck", priority: "high", status: "in_progress" } ];
    expect(updateOf({ kind: "plan", entries })).toEqual({ kind: "plan", entries });
  });

  test("a plan with no entries is not an update", () => {
    expect(updateOf({ kind: "plan", entries: [] })).toBeNull();
  });

  test("usage carries the cost as the protocol sends it", () => {
    // { amount, currency: ISO 4217 } — read as a bare number it was NaN, and
    // the column stayed empty for every agent that followed the schema (#97).
    expect(updateOf({ kind: "usage", used: 84000, size: 200000,
                      cost: { amount: 0.42, currency: "EUR" } }))
      .toEqual({ kind: "usage", used: 84000, size: 200000,
                 cost: { amount: 0.42, currency: "EUR" } });
  });

  test("cost is optional", () => {
    expect(updateOf({ kind: "usage", used: 10, size: 100 }))
      .toEqual({ kind: "usage", used: 10, size: 100, cost: undefined });
  });

  test("a config update carries the whole option list", () => {
    const options = [ { id: "model", name: "Model", type: "select",
                        currentValue: "a", options: [ { value: "a", name: "A" } ] } ];
    expect(updateOf({ kind: "config", options })).toEqual({ kind: "config", options });
  });

  test("a config update with no options is not an update", () => {
    expect(updateOf({ kind: "config", options: [] })).toBeNull();
  });

  test("an unknown kind surfaces rather than vanishing", () => {
    expect(updateOf({ kind: "other", label: "plan_changed" }))
      .toEqual({ kind: "other", label: "plan_changed" });
  });

  test("a question and a closed process are routed on their own, not shown", () => {
    expect(updateOf({ kind: "permission", request: {} })).toBeNull();
    expect(updateOf({ kind: "closed", diagnostics: [ "not logged in" ] })).toBeNull();
    expect(updateOf(null)).toBeNull();
  });
});

describe("transcript naming", () => {
  test("names the artifact after the session whose record it is", () => {
    const name = transcriptName("ses_42", new Date("2026-07-31T09:05:00Z"));
    expect(name).toMatch(/^session ses_42 transcript /);
    expect(name.endsWith(".json")).toBe(true);
  });

  test("stable for one session and instant, and two sessions never collide", () => {
    const at = new Date("2026-07-31T09:05:00Z");
    expect(transcriptName("ses_1", at)).toEqual(transcriptName("ses_1", at));
    expect(transcriptName("ses_1", at)).not.toEqual(transcriptName("ses_2", at));
  });
});

describe("the transcript this client renders", () => {
  test("carries the entries in arrival order, in the room's own vocabulary", () => {
    const body = JSON.parse(transcriptOf("ses_9", "2026-08-03T12:00:00Z", [
      { kind: "tool", label: "read a file" },
      { kind: "text", text: "done" },
    ]));

    expect(body.session).toBe("ses_9");
    expect(body.at).toBe("2026-08-03T12:00:00Z");
    expect(body.rendered_by).toBe("workroom-desktop");
    expect(body.entries).toEqual([
      { kind: "tool", label: "read a file" },
      { kind: "text", text: "done" },
    ]);
  });

  test("a session option changing is nobody's transcript", () => {
    const body = JSON.parse(transcriptOf("ses_9", "2026-08-03T12:00:00Z", [
      { kind: "config", options: [] },
      { kind: "text", text: "hello" },
    ]));

    expect(body.entries).toEqual([ { kind: "text", text: "hello" } ]);
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

describe("the journal as files in the mirror", () => {
  const row = { seq: 7, kind: "memory", prev_hash: "b".repeat(64), entry_hash: "a".repeat(64),
                created_at: "2026-08-03T12:00:00Z",
                payload: { title: "Cadence", detail: "Monthly, not weekly." } };

  test("an entry is a dated, chained markdown file whose name sorts as the room happened", () => {
    const file = mirrorEntryOf(row);
    expect(file.path).toBe("journal/00007-memory.md");
    expect(file.body).toContain("seq: 7");
    expect(file.body).toContain(`entry_hash: ${"a".repeat(64)}`);
    expect(file.body).toContain("# Cadence");
    expect(file.body).toContain("Monthly, not weekly.");
  });

  test("a payload with no title stays itself, as json — never invented prose", () => {
    const file = mirrorEntryOf({ ...row, payload: { action: "attached", sha256: "ff" } });
    expect(file.body).toContain("```json");
    expect(file.body).toContain('"sha256": "ff"');
  });

  test("the README carries the spike's sentence word for word", () => {
    expect(MIRROR_README).toContain("edits here do not survive — write to the channel instead");
  });
});

describe("bringing work that predates the channel into the room", () => {
  test("the introduction is an addressed turn that asks for conclusions, not files", () => {
    const ask = introductionAsk();
    // An ordinary turn: parseAddress must route it to an agent, the rail is
    // named as the way in, and the one failure mode the card warns about —
    // a directory dump — is forbidden in so many words (#235).
    expect(parseAddress(ask).addressed).toBe(true);
    expect(ask).toContain("workroom://memory/remember");
    expect(ask).toContain("never file listings");
  });
});

describe("a definition says how, not only what it is called", () => {
  test("the persona line opens with the address the room knows", () => {
    expect(instructionOf({ name: "crm", command: "opencode", args: [],
                           instruction: "Keep the CRM current." }))
      .toBe("You are @crm. Keep the CRM current.");
  });

  test("no instruction is no line — not an empty preamble", () => {
    expect(instructionOf({ name: "crm", command: "opencode", args: [] })).toBeNull();
    expect(instructionOf({ name: "crm", command: "opencode", args: [], instruction: "  " }))
      .toBeNull();
    expect(instructionOf(undefined)).toBeNull();
  });

  test("normalizeAgents carries instruction and model, and drops the empty ones", () => {
    const [ crm ] = normalizeAgents([
      { name: "crm", command: "opencode", args: [],
        instruction: " Keep it current. ", model: "anthropic/claude-sonnet-5" },
    ]);
    expect(crm.instruction).toBe("Keep it current.");
    expect(crm.model).toBe("anthropic/claude-sonnet-5");

    const [ bare ] = normalizeAgents([
      { name: "bare", command: "x", args: [], instruction: "  ", model: "" },
    ]);
    expect("instruction" in bare).toBe(false);
    expect("model" in bare).toBe(false);
  });
});

describe("editing a definition", () => {
  const crm = { name: "crm", command: "opencode", args: [ "acp" ] };

  test("saving under a taken name replaces, case-insensitively", () => {
    // @Crm and @crm must not become two agents — the address is the identity.
    const defs = upsertDefinition([ crm ], { name: "CRM", command: "codex-acp", args: [] });
    expect(defs).toEqual([ { name: "CRM", command: "codex-acp", args: [] } ]);
  });

  test("choosing a default un-chooses everybody else", () => {
    const defs = upsertDefinition(
      [ { ...crm, default: true } ],
      { name: "support", command: "opencode", args: [], default: true },
    );
    expect(defs.filter((d) => d.default).map((d) => d.name)).toEqual([ "support" ]);
  });

  test("removing a baseline name is a reset, not a removal", () => {
    // normalizeAgents appends the baseline three whatever was saved (#231), so
    // what comes back is the project's own definition.
    const kept = removeDefinition([ { name: "opencode", command: "/my/fork", args: [] } ], "opencode");
    expect(kept).toEqual([]);
    const opencode = normalizeAgents(kept).find((d) => d.name === "opencode");
    expect(opencode?.command).toBe("opencode");
  });

  test("arguments are one line, split on whitespace", () => {
    expect(splitArgs("  acp   --flag  ")).toEqual([ "acp", "--flag" ]);
    expect(splitArgs("   ")).toEqual([]);
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

  test("nothing configured is the three this project supports, claude first", () => {
    // Claude answers `@agent` because something must, not because it is present
    // (#120) — all three are installed the same way. They are named so somebody
    // can see they exist and what state they are in; naming one installs nothing.
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

  test("an empty offer with pre-existing changes says so, quietly", () => {
    expect(preExistingNotice(0)).toBeNull();
    expect(preExistingNotice(3)).toBe(
      "Nothing new this turn (3 pre-existing changes not offered)",
    );
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

describe("the turn carries the question", () => {
  test("send() wraps the body before prompting", () => {
    // A source-level guard, and it is one on purpose: `send()` needs a window,
    // so nothing else here can catch the question being quietly dropped. Losing
    // it would be invisible — turns keep working, and the room stops learning.
    expect(mainSource).toMatch(/agents\.prompt\(\s*name,\s*sessionId,\s*withClosing\(body\)/);
  });

  test("the turn's own summary reaches the record", () => {
    // Same guard, same reason (#97): the prompt response was discarded for a
    // year, and a turn that stopped at max_tokens read as one that finished.
    expect(mainSource).toMatch(/outcome = await agents\.prompt\(/);
    expect(mainSource).toMatch(/finishRun\(run\.id, "succeeded", outcome\)/);
  });
});

describe("a person can add to what the room knows", () => {
  test("the memory form writes through api.remember", () => {
    // A source-level guard, like the send() one above and for the same reason:
    // the form needs a window. A lost call site is exactly how this endpoint
    // spent months as the one route with no caller (#162).
    expect(mainSource).toMatch(/api\.remember\(\s*current\.slug/);
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

    expect(w.inChannel("meetings"), "since the earliest, so the elapsed time does not reset mid-work")
      .toEqual([{ who: "Bob", since: 1000 }]);
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

describe("what the room knows, counted", () => {
  test("the toggle answers its own question before it is pressed", () => {
    // The server pays one store call per open for this number (#161); a count
    // that reaches no pixel is that call wasted.
    expect(memoryToggleLabel(12)).toBe("What the room knows (12)");
  });

  test("a room that knows nothing says zero, a store that is away says nothing", () => {
    // An absent count is the store being unreachable (#146); rendering it as 0
    // would be the room claiming to know nothing — the lie that card closed.
    expect(memoryToggleLabel(0)).toBe("What the room knows (0)");
    expect(memoryToggleLabel(undefined)).toBe("What the room knows");
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
    expect(unreadCount(5, undefined), "a channel you have never opened is not a channel full of unread")
      .toBe(0);
    expect(unreadCount(3, 5), "a room cannot owe you a negative number of messages").toBe(0);
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
    expect(threadOf(all, 1).map((m) => m.id), "a message nobody answered is a thread of one").toEqual([ 1 ]);
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
    expect(alice.hue, "the same person is the same colour every time")
      .toBe(identity({ kind: "user", name: "Alice Ruiz" }).hue);
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
    expect(shown.messages[0].id, "the recent end, not the start").toBe(301);
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
    kind: "permission",
    session: "ses_1",
    request: {
      id: 7,
      session: "ses_1",
      title: "Run the migration",
      toolKind: "execute",
      options: [
        { optionId: "yes", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
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
    const spare = { kind: "permission", request: { id: 1,
      options: [ { optionId: "only", name: "Fine", kind: "allow_once" } ] } };

    expect(permissionAsked(spare)!.options).toHaveLength(1);
  });

  test("a question with no title still says something", () => {
    const bare = { kind: "permission", request: { id: 1, options: [] } };

    expect(permissionAsked(bare)!.title).toBe("The agent is asking to do something");
  });

  test("anything that is not a permission request is not one", () => {
    expect(permissionAsked({ kind: "text", text: "hi" })).toBeNull();
    expect(permissionAsked({ kind: "permission" })).toBeNull();
    expect(permissionAsked(null)).toBeNull();
  });

  test("a question says which turn is asking", () => {
    // Without it, a dialog for one channel's agent is shown as though this
    // channel's agent had asked — and `agent_permit` answers by request id, so
    // the person authorises a call they were never shown (#91).
    const asked = permissionAsked({ kind: "permission", session: "s-meetings",
                                    request: { id: 7, options: [] } })!;

    expect(asked.sessionId).toBe("s-meetings");
  });

  test("a string id survives, because Number(\"perm-1\") answers nobody", () => {
    // JSON-RPC allows a string id. Coerced to a number it becomes NaN, the
    // answer quotes null, and the agent waits for the rest of the session (#96).
    const stringy = { kind: "permission", request: { id: "perm-1",
      options: [ { optionId: "yes", name: "Allow once" } ] } };

    expect(permissionAsked(stringy)!.id).toBe("perm-1");
  });

  test("the id goes back exactly as it came, whatever it was", () => {
    expect(permissionAsked({ ...ask, request: { ...ask.request, id: 0 } })!.id).toBe(0);
    expect(permissionAsked({ ...ask, request: { ...ask.request, id: "0" } })!.id).toBe("0");
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

});

describe("a step somebody will read", () => {
  test("a tool call is named by what it is", () => {
    expect(updateOf({ kind: "tool", title: "Search the room", toolKind: "other", update: false }))
      .toEqual({ kind: "tool", label: "Search the room" });
  });

  test("an update with nothing to say is not a step", () => {
    // A change to a call already recorded arrives without a title, and the
    // client does not invent one: falling back to an id would put
    // `call_00_hWMqa5NQZWoHwgQfxDg70485` in front of a colleague, which tells
    // them nothing and crowds out what does.
    expect(updateOf({ kind: "tool", title: "", update: true })).toBeNull();
  });

  test("an update that does have something to say is kept", () => {
    expect(updateOf({ kind: "tool", title: "Read the entry", update: true }))
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
    expect(updateOf({ kind: "thought", text: "checking the rail first" }))
      .toEqual({ kind: "thought", text: "checking the rail first" });
  });

  test("a thought with nothing in it is nothing", () => {
    expect(updateOf({ kind: "thought", text: "" })).toBeNull();
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

  test("private travels on both paths, because a template is a shape, not a verdict", () => {
    // `# legal` picked with "private" must not open an open room (#255, #256).
    expect(channelToCreate({ template: "legal", visibility: "private" }))
      .toEqual({ template: "legal", visibility: "private" });
    expect(channelToCreate({ slug: "pricing", visibility: "private" }))
      .toEqual({ slug: "pricing", name: "pricing", visibility: "private" });
  });

  test("open does not travel — it is the server's default, not this client's copy of it", () => {
    expect(channelToCreate({ slug: "pricing", visibility: "open" }))
      .toEqual({ slug: "pricing", name: "pricing" });
  });

  test("the dialog says which room it is about to make", () => {
    expect(visibilityNote("private")).toContain("Only people added");
    expect(visibilityNote("open")).toContain("Everybody in this workspace");
    expect(visibilityNote("open")).not.toEqual(visibilityNote("private"));
  });

  test("a cancelled dialog asks for nothing", () => {
    expect(channelToCreate(null)).toBeNull();
    expect(channelToCreate({ name: "Pricing" })).toBeNull();
  });
});

describe("the standing rules of a git-backed session (#205)", () => {
  test("the boundary names the real default branch, not a placeholder", () => {
    const text = gitBoundary("main");

    expect(text).toContain("main");
    // The rules the card stands on: branches of one's own, never the
    // mainline, and authorship that stays the person's.
    expect(text).toContain("agent/");
    expect(text).toMatch(/never (commit|push)/i);
    expect(text).toContain("Co-Authored-By");
  });

  test("another repository's mainline is the one named", () => {
    expect(gitBoundary("trunk")).toContain("trunk");
    expect(gitBoundary("trunk")).not.toContain("main");
  });
});

describe("what a permission ask means in a repository (#205)", () => {
  test("a push to a feature branch says where it goes, calmly", () => {
    expect(gitAskNote("git push origin agent/readme-fixes", "main", false))
      .toBe("Push to origin (agent/readme-fixes)");
  });

  test("a push to the default branch of a repository that deploys is a warning", () => {
    const note = gitAskNote("git push origin main", "main", true);

    expect(note).toContain("main");
    expect(note).toContain("deploys on merge to main");
  });

  test("a push to the default branch without a deploy is still named", () => {
    const note = gitAskNote("git push origin main", "main", false);

    expect(note).toContain("main");
    expect(note).not.toContain("deploys");
  });

  test("a command that is not git is not annotated", () => {
    expect(gitAskNote("rm -rf node_modules", "main", true)).toBeNull();
    expect(gitAskNote("npm test", "main", false)).toBeNull();
  });

  test("a commit away from the default branch is local, and stays quiet", () => {
    expect(gitAskNote("git commit -m 'wip'", "main", true)).toBeNull();
  });

  test("a commit onto the default branch of a deploying repository is a warning", () => {
    const note = gitAskNote("git checkout main && git commit -m 'wip'", "main", true);

    expect(note).toContain("main");
    expect(note).toContain("deploys on merge to main");
  });

  test("a push with no named branch still says what it is", () => {
    expect(gitAskNote("git push", "main", true)).toBe("Push to origin");
  });
});

describe("naming a branch on GitHub (#206)", () => {
  test("an https remote becomes a tree url, .git suffix or not", () => {
    expect(githubTreeUrl("https://github.com/acme/widgets", "agent/notes"))
      .toBe("https://github.com/acme/widgets/tree/agent/notes");
    expect(githubTreeUrl("https://github.com/acme/widgets.git", "main"))
      .toBe("https://github.com/acme/widgets/tree/main");
  });

  test("an ssh remote becomes the same tree url", () => {
    expect(githubTreeUrl("git@github.com:acme/widgets.git", "agent/notes"))
      .toBe("https://github.com/acme/widgets/tree/agent/notes");
  });

  test("anything else is no link at all — a control without a target is hidden", () => {
    expect(githubTreeUrl(null, "main")).toBeNull();
    expect(githubTreeUrl("https://gitlab.example.test/acme/widgets", "main")).toBeNull();
    expect(githubTreeUrl("/home/alice/src/widgets", "main")).toBeNull();
  });
});

describe("two clients, one run record", () => {
  test("acp-turn and the client name the run's fields the same way", () => {
    // A source-level guard, like the send() one, across the repository seam:
    // bin/acp-turn and this client both write the run record, and nothing else
    // ties their vocabularies together — the last two drifts (#228, #97) were
    // found by archaeology. The client's half lives in api.ts (reportUsage,
    // finishRun); main.ts only reads back what presence broadcasts.
    for (const field of [ "context_used", "context_size", "cost", "cost_currency", "stop_reason" ]) {
      const asKey = new RegExp(`\\b${field}:`);
      expect(acpTurnSource, `bin/acp-turn stopped naming ${field}`).toMatch(asKey);
      expect(apiSource, `the client stopped naming ${field}`).toMatch(asKey);
    }
  });
});
