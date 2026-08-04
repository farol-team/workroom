/// <reference types="vite/client" />
import { vi } from "vitest";
import indexHtml from "../index.html?raw";
import type { Api } from "../src/api";

// What drives main.ts itself — the real composer, the real boot chain, the
// real notice strip — with the two edges standing in: the server it talks to
// over HTTP, and the local bridge it talks to over Tauri.

/// Every public member of Api, spelled out. `aServer` returns this, so a
/// method added to api.ts and forgotten here is a missing property under
/// `tsc --noEmit` — not a stub that answers nothing and a spec that spends
/// twenty seconds finding that out (artifacts, remember and agentDefinitions
/// each rotted that way once).
export type ApiSurface = { [K in keyof Api]: Api[K] };

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

const room = indexHtml
  .replace(/[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*/, "")
  .replace(/<script[\s\S]*?<\/script>/g, "");

export const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

export function aServer(over: Partial<ApiSurface> = {}): ApiSurface {
  const said = { id: 5, channel_id: 1, parent_id: null, body: "hello",
                 author: { kind: "user", id: 1, name: "Alice", email: "alice@farol.run" },
                 created_at: "2026-07-31T09:00:00Z" };
  const channel = { id: 1, slug: "meetings", name: "Meetings", purpose: "What we decided",
                    visibility: "workspace", memory_uri: "mem://meetings", message_count: 1 };
  // The one cast in this file. It buys untyped stub *values* — vi.fn's answer
  // never has to match the endpoint's declared shape — while the ApiSurface
  // annotation below still makes a *missing* member a compile error.
  const ok = (value: unknown) => vi.fn(async () => value) as any;
  const server: ApiSurface = {
    base: "http://server",
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
    invitations: ok([]), channelTemplates: ok([]), artifacts: ok([]),
    agentDefinitions: ok([]), shareAgentDefinition: ok(undefined),
    remember: ok({ uri: "mem://meetings/1", title: "t", trust: "human" }),
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
    updateChannel: ok(channel),
    caughtUp: ok([]),
    records: ok([]),
    recordBytes: ok(""),
    ...over,
  };
  return server;
}

export function aBridge(over: Record<string, unknown> = {}) {
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
    turnStart: vi.fn(async () => {}),
    read: vi.fn(async () => ""),
    sessionFor: vi.fn(async () => "s1"),
    noteRun: vi.fn(),
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

export function aShell(over: Record<string, unknown> = {}) {
  return {
    invoke: vi.fn(async () => ""),
    appDataDir: vi.fn(async () => "/data"),
    ...over,
  };
}

/// Every native dialog the client puts up, counted. It should be none: a modal
/// that stops the window is not how an application somebody keeps open all day
/// reports that one request failed.
export const blockingDialog = vi.fn();

export interface Edges { server?: any; bridge?: any; shell?: any }

/// One window, opened as a person opens it: the document index.html ships,
/// the sign-in dialog answered, the room loaded. `atSignIn` runs while that
/// dialog is still up, which is the only moment some of its buttons exist.
export async function openTheClient(
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
export const notices = () =>
  [ ...document.querySelectorAll<HTMLElement>("#notices .notice") ]
    .map((notice) => notice.textContent ?? "").join("\n");
export const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const submit = (id: string) =>
  el(id).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
