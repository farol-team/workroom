// Tier 2 of the agent bench: a real turn, driven by a person who is logged in.
//
// Deliberately not in CI and deliberately not automatic. It costs a model call,
// it needs a credential this project keeps on the person's own machine
// (Article P2), and it asks a permission question that only a person may answer
// — a client that answers on somebody's behalf has quietly moved the decision.
//
// What it exercises, which tier 1 cannot: a prompt that provokes a permission
// request, the rail actually being called, a usage_update, and a transcript.
//
//   pnpm bench:turn --rail http://127.0.0.1:3000/api/v1/rail/general --token dev-alice
//
// Paste what it prints into the card. That is the point of it.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const rail = arg("rail");
const token = arg("token");
const command = arg("agent", resolve(here, "../node_modules/.bin/claude-agent-acp"));
const ask = arg("prompt",
  "Search this channel's memory for what we agreed about reporting, then write a " +
  "one-line file called bench.txt saying what you found.");

if (!rail || !token) {
  console.error("pnpm bench:turn --rail <url> --token <token> [--agent <command>] [--prompt <text>]");
  process.exit(2);
}

const child = spawn(command, [], { stdio: ["pipe", "pipe", "inherit"] });
const say = (id, method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
const answer = (id, result) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

const seen = { rail: false, permission: false, usage: false, text: "" };
let sessionId;
let buf = "";

const rl = createInterface({ input: process.stdin, output: process.stdout });

child.stdout.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id === 1 && msg.result) {
      console.log(`agent: ${msg.result.agentInfo?.name} ${msg.result.agentInfo?.version}`);
      say(2, "session/new", {
        cwd: process.cwd(),
        mcpServers: [ { name: "workroom", type: "http", url: rail,
                        headers: [ { name: "Authorization", value: `Bearer ${token}` } ] } ],
      });
    }

    if (msg.id === 2) {
      if (!msg.result) { console.error(`session/new refused: ${JSON.stringify(msg.error)}`); process.exit(1); }
      sessionId = msg.result.sessionId;
      console.log(`session: ${sessionId}`);
      say(3, "session/prompt", { sessionId, prompt: [ { type: "text", text: ask } ] });
    }

    // The agent asking to run something, and waiting. Answered by the person.
    if (msg.method === "session/request_permission") {
      seen.permission = true;
      const options = msg.params?.options ?? [];
      console.log(`\nthe agent asks: ${msg.params?.toolCall?.title ?? "?"}`);
      options.forEach((o, n) => console.log(`  ${n}) ${o.name ?? o.optionId}`));
      const choice = await rl.question("which? (number, or blank to cancel) ");
      const picked = options[Number(choice)];
      answer(msg.id, { outcome: picked
        ? { outcome: "selected", optionId: picked.optionId }
        : { outcome: "cancelled" } });
    }

    if (msg.method === "session/update") {
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === "agent_message_chunk") seen.text += u.content?.text ?? "";
      if (u.sessionUpdate === "usage_update") seen.usage = true;
      if (u.sessionUpdate === "tool_call") {
        const title = String(u.title ?? "");
        console.log(`  · ${title}`);
        // The rail is two tools; either of them being called is the rail working.
        if (/capabilit/i.test(title)) seen.rail = true;
      }
    }

    if (msg.id === 3) {
      console.log(`\nstopReason: ${msg.result?.stopReason ?? JSON.stringify(msg.error)}`);
      console.log(`\n${"—".repeat(60)}`);
      console.log(`rail called          ${seen.rail ? "yes" : "NO"}`);
      console.log(`permission asked     ${seen.permission ? "yes" : "NO"}`);
      console.log(`usage reported       ${seen.usage ? "yes" : "NO"}`);
      console.log(`answered             ${seen.text.trim() ? "yes" : "NO"}`);
      console.log(`${"—".repeat(60)}\n${seen.text.trim()}`);
      rl.close();
      child.kill("SIGKILL");
      process.exit(seen.rail && seen.text.trim() ? 0 : 1);
    }
  }
});

setTimeout(() => say(1, "initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
}), 1500);
