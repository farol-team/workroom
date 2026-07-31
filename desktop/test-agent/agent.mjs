#!/usr/bin/env node
// A minimal agent that speaks ACP v1 over stdio, and nothing else.
//
// It exists so the bridge can be exercised against a second implementation of
// the protocol rather than against fixtures we wrote ourselves. Both defects in
// #68 were found this way and neither was visible from the inside.
//
// It needs no credentials and calls no model: it answers with what it was given,
// which is exactly what a test needs and exactly what a person does not.

import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

let nextId = 1;
const pending = new Map();

function ask(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const sessions = new Map();

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // A reply to something we asked the client.
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }

  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } },
      agentInfo: { name: "test-agent", version: "0" },
    });
  }

  if (method === "session/new") {
    const sessionId = `ses_${sessions.size + 1}`;
    // What the client sent us, kept verbatim so a test can assert on the wire
    // format rather than on our reading of it.
    sessions.set(sessionId, { mcpServers: params.mcpServers ?? [], cwd: params.cwd });
    return reply(id, { sessionId, configOptions: [] });
  }

  if (method === "session/prompt") {
    const session = sessions.get(params.sessionId) ?? {};
    const said = params.prompt.map((b) => b.text ?? "").join("");

    // Report what the rail actually arrived as, so a header sent in the wrong
    // shape is a visible failure rather than a silent 401 later.
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `rail:${JSON.stringify(session.mcpServers)}` } } } });

    if (said.includes("[ask]")) {
      const outcome = await ask("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call_1", title: "Do the thing" },
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `permission:${JSON.stringify(outcome)}` } } } });
    }

    return reply(id, { stopReason: "end_turn" });
  }

  if (id !== undefined) reply(id, {});
});
