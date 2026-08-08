import { beforeEach, describe, expect, test, vi } from "vitest";

// `Agents` talks to the bridge through invoke/listen, so both are stubbed at
// the boundary — which is why this is its own file rather than more of
// rules.test.ts, whose subjects are pure.
const handlers = new Map<string, (ev: unknown) => void>();
const invoked: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let answering: (cmd: string, args: Record<string, unknown>) => unknown = () => null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    invoked.push({ cmd, args });
    return answering(cmd, args);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (ev: unknown) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

import { Agents } from "../src/agent";

/// What the bridge would emit for one line of an agent's answer.
const said = (sessionId: string, text: string) =>
  handlers.get("acp://event")?.({ payload: { kind: "text", session: sessionId, text } });

beforeEach(() => {
  handlers.clear();
  invoked.length = 0;
  answering = () => null;
  localStorage.clear();
});

describe("collecting a session", () => {
  test("a collector keeps its session's updates, in arrival order", async () => {
    const agents = new Agents();
    const collector = await agents.collect("ses_1");

    said("ses_1", "first");
    said("ses_2", "somebody else's turn");
    said("ses_1", "second");

    expect(collector.stop()).toEqual([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
  });

  test("a stopped collector hears nothing more", async () => {
    const agents = new Agents();
    const collector = await agents.collect("ses_1");
    said("ses_1", "heard");
    collector.stop();

    said("ses_1", "unheard");

    // Not silently dropped either — a message for a session nobody runs is a
    // stray, which is the dispatcher's existing rule.
    expect(agents.strays).toHaveLength(1);
  });
});

describe("keeping the transcript when a session ends", () => {
  const anAgent = { name: "opencode", command: "opencode", args: [] as string[] };

  async function withOneSession(agents: Agents) {
    answering = (cmd) => (cmd === "agent_new_session" ? { sessionId: "ses_9" } : null);
    agents.use([ anAgent ]);
    agents.markRunning("opencode");
    await agents.sessionFor("opencode", "meetings", "/work/meetings");
    agents.noteRun("ses_9", 42);
  }

  test("stopping the agent attaches one transcript per session, by export where it exists", async () => {
    const agents = new Agents();
    await withOneSession(agents);
    const kept: Array<{ runId: number; name: string; body: string }> = [];
    agents.attachTranscript = async (runId, name, body) => { kept.push({ runId, name, body }); };
    answering = (cmd) => (cmd === "agent_export_session" ? "{\"info\":{}}" : null);

    await agents.stop("opencode");

    expect(kept).toHaveLength(1);
    expect(kept[0].runId).toBe(42);
    expect(kept[0].name).toMatch(/^session ses_9 transcript /);
    expect(kept[0].body).toBe("{\"info\":{}}");
    expect(invoked.map((i) => i.cmd)).not.toContain("agent_load_session");
  });

  test("an agent with no exporter is asked to replay, and the replay stays out of the room", async () => {
    const agents = new Agents();
    await withOneSession(agents);
    const kept: string[] = [];
    agents.attachTranscript = async (_runId, _name, body) => { kept.push(body); };
    answering = (cmd, args) => {
      if (cmd === "agent_export_session") throw new Error("no export command");
      if (cmd === "agent_load_session") {
        said(args.sessionId as string, "replayed line");
        return {};
      }
      return null;
    };

    await agents.stop("opencode");

    expect(kept).toHaveLength(1);
    const body = JSON.parse(kept[0]);
    expect(body.session).toBe("ses_9");
    expect(body.entries).toEqual([ { kind: "text", text: "replayed line" } ]);
    // Collected, not strayed into the room.
    expect(agents.strays).toHaveLength(0);
  });

  test("a failing export and a failing replay still stop the agent, with nothing attached", async () => {
    const agents = new Agents();
    await withOneSession(agents);
    const kept: string[] = [];
    agents.attachTranscript = async (_runId, _name, body) => { kept.push(body); };
    answering = (cmd) => {
      if (cmd === "agent_export_session" || cmd === "agent_load_session") {
        throw new Error("broken");
      }
      return null;
    };

    await agents.stop("opencode");

    expect(kept).toHaveLength(0);
    expect(agents.isRunning("opencode")).toBe(false);
    expect(invoked.map((i) => i.cmd)).toContain("agent_stop");
  });

  test("a session that never answered a run attaches nothing", async () => {
    const agents = new Agents();
    answering = (cmd) => (cmd === "agent_new_session" ? { sessionId: "ses_9" } : null);
    agents.use([ anAgent ]);
    agents.markRunning("opencode");
    await agents.sessionFor("opencode", "meetings", "/work/meetings");
    const kept: string[] = [];
    agents.attachTranscript = async (_runId, _name, body) => { kept.push(body); };

    await agents.stop("opencode");

    expect(kept).toHaveLength(0);
  });
});

describe("a definition's model is a session's starting point", () => {
  const crm = { name: "crm", command: "opencode", args: [] as string[],
                model: "anthropic/claude-sonnet-5" };

  test("a new session is set onto the definition's model, once", async () => {
    const agents = new Agents();
    agents.use([ crm ]);
    agents.markRunning("crm");
    answering = (cmd) => (cmd === "agent_new_session" ? { sessionId: "ses_m" } : {});

    await agents.sessionFor("crm", "meetings", "/work/meetings");

    const set = invoked.filter((i) => i.cmd === "agent_set_config");
    expect(set).toHaveLength(1);
    expect(set[0].args).toMatchObject({ configId: "model", value: "anthropic/claude-sonnet-5" });
  });

  test("a resumed session keeps what its person chose — the model is never re-applied", async () => {
    localStorage.setItem("workroom.sessions", JSON.stringify({ "crm/meetings": "ses_old" }));
    const agents = new Agents();
    agents.use([ crm ]);
    agents.markRunning("crm");
    answering = (cmd) => (cmd === "agent_load_session" ? {} : {});

    await agents.sessionFor("crm", "meetings", "/work/meetings");

    expect(invoked.map((i) => i.cmd)).toContain("agent_load_session");
    expect(invoked.map((i) => i.cmd)).not.toContain("agent_set_config");
  });

  test("an agent whose model option the vendor refuses still opens its session", async () => {
    const agents = new Agents();
    agents.use([ crm ]);
    agents.markRunning("crm");
    answering = (cmd) => {
      if (cmd === "agent_new_session") return { sessionId: "ses_m" };
      if (cmd === "agent_set_config") throw new Error("no such option");
      return {};
    };

    await expect(agents.sessionFor("crm", "meetings", "/work/meetings")).resolves.toBe("ses_m");
  });
});
