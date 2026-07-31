import { describe, expect, test } from "vitest";
import { StepLedger, formatHistory, parseAddress, presenceState, transcriptName, translateAcp } from "../src/rules";

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

describe("presence", () => {
  test("a running run means somebody is working", () => {
    expect(presenceState([{ id: 1, status: "running", user: "Bob" }]).get(1)).toBe("Bob");
  });

  test("a finished run clears it", () => {
    const state = presenceState([
      { id: 1, status: "running", user: "Bob" },
      { id: 1, status: "succeeded", user: "Bob" },
    ]);
    expect(state.has(1)).toBe(false);
  });

  test("two people working are both shown", () => {
    const state = presenceState([
      { id: 1, status: "running", user: "Bob" },
      { id: 2, status: "running", user: "Dana" },
    ]);
    expect([...state.values()].sort()).toEqual(["Bob", "Dana"]);
  });

  test("a failed run stops being presence", () => {
    expect(presenceState([
      { id: 1, status: "running", user: "Bob" },
      { id: 1, status: "failed", user: "Bob" },
    ]).size).toBe(0);
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
