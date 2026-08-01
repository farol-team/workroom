// Drives one headless Chrome over CDP to photograph the client's states.
//
// This exists because the CLI flags cannot say "when the page is ready":
// `--dump-dom` fires at load, before the boot chain's fetches land, and
// `--virtual-time-budget` does not pause for fetch() on branded Chrome — the
// old script raced both and flaked (#75's pictures came out empty half the
// time on macOS). Over CDP "ready" is what it actually is: the DOM contains
// what the state is meant to show, polled for, with real seconds.
//
// Usage: node shoot.mjs <debug-port> <base-url> <out-dir> <states-json>
//   states: [{ "name": "room", "query": "", "want": "class=\"msg" }, …]
// Exit 1 after printing what arrived when a state never renders its `want`.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [ port, base, out, statesJson ] = process.argv.slice(2);
const states = JSON.parse(statesJson);

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("cannot reach the browser over CDP"));
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function evaluate(sessionId, expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return res?.result?.value;
}

// Real seconds, and the question asked of the page itself — the two things
// the flags could not give.
async function waitFor(sessionId, want, seconds = 30) {
  const needle = JSON.stringify(want);
  for (let waited = 0; waited < seconds * 2; waited++) {
    const found = await evaluate(sessionId, `document.documentElement.outerHTML.includes(${needle})`);
    if (found) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let failed = false;
for (const state of states) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  await send("Page.navigate", { url: `${base}?v=${Date.now()}${state.query}` }, sessionId);

  if (await waitFor(sessionId, state.want)) {
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(out, `${state.name}.png`), Buffer.from(shot.data, "base64"));
    console.log(`   ${state.name.padEnd(11)} ${join(out, state.name + ".png")}`);
  } else {
    // "It did not load" is not a diagnosis; say what did arrive.
    const html = await evaluate(sessionId, "document.documentElement.outerHTML") ?? "";
    console.error(`${state.name} never rendered ${state.want}`);
    console.error("   what arrived instead:");
    console.error(html.slice(0, 400).split("\n").map((l) => `   ${l}`).join("\n"));
    failed = true;
  }
  await send("Target.closeTarget", { targetId });
  if (failed) break;
}

ws.close();
process.exit(failed ? 1 : 0);
