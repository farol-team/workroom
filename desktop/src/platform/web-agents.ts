// An agent runtime for a place that cannot have one.
//
// Article D2: the client spawns and owns the agent process, and a browser cannot
// spawn anything. So the web build has no agent — and rather than making `agents`
// nullable and putting the same check at forty call sites in `main.ts`, it gets a
// runtime that answers what a machine with no agent installed would answer.
//
// The window already draws that state correctly: nothing running, nothing offered,
// and an agent that is gone stops being addressable (#93). Reusing it is why this
// build needed no changes to the panels.

import type { AgentState } from "../agents/catalog";
import type { AgentRuntime } from "../agent-runtime";
import type { AgentDef, Asked, ConfigOption, TurnOutcome, TurnProduced, Update } from "../rules";
import type { InstallResult } from "../agent";

const REASON = "there is no agent in a browser: it would have to be a process this page owns";

const refuse = <T>(): Promise<T> => Promise.reject(new Error(REASON));

export class NoAgents implements AgentRuntime {
  attachTranscript?: (runId: number, name: string, body: string) => Promise<void>;

  definitions(): AgentDef[] { return []; }
  use(_defs: AgentDef[]) { /* nothing to hold them for */ }

  isRunning(_name: string) { return false; }
  get running(): string[] { return []; }
  markRunning(_name: string) { /* nothing runs */ }
  listRunning() { return Promise.resolve([] as string[]); }

  start(_name: string) { return refuse<void>(); }
  probe(_commands: string[]) { return refuse<void>(); }
  install(_command: string) { return refuse<InstallResult>(); }
  stateOf(_name: string): AgentState { return "missing"; }

  // Asked on the way out of a room and on the way out of the app. Refusing here
  // would turn leaving into an error, and there is nothing to leave.
  stop(_name?: string) { return Promise.resolve(); }
  releaseChannel(_slug: string) { return Promise.resolve(); }

  workspace(_room: string, _channel: string) { return refuse<string>(); }
  turnStart(_workspace: string) { return refuse<void>(); }
  produced(_workspace: string) { return refuse<TurnProduced>(); }
  read(_workspace: string, _path: string) { return refuse<string>(); }

  sessionFor(..._args: unknown[]) { return refuse<string>(); }
  closeSession(_name: string, _sessionId: string) { return Promise.resolve(false); }
  noteRun(_sessionId: string, _runId: number) { /* no run to note */ }

  configFor(_name: string, _slug: string): ConfigOption[] { return []; }
  setConfig(..._args: unknown[]) { return Promise.resolve([] as ConfigOption[]); }
  rememberConfig(..._args: unknown[]) { /* no session to remember for */ }
  modelFor(_name: string, _slug: string) { return undefined; }

  prompt(..._args: unknown[]) { return refuse<TurnOutcome>(); }
  cancel(_name: string, _sessionId: string) { return refuse<unknown>(); }
  permit(..._args: unknown[]) { return refuse<unknown>(); }

  // A listener nothing will ever call, which still has to be removable — the
  // window unsubscribes on the way out and does not ask first.
  onUpdate(_sessionId: string, _handler: (u: Update) => void) { return Promise.resolve(() => {}); }
  onAsk(_sessionId: string, _handler: (a: Asked) => void) { return Promise.resolve(() => {}); }
  onClosed(_handler: (e: { name?: string; diagnostics: string[] }) => void) {
    return Promise.resolve(() => {});
  }
  collect(_sessionId: string) { return Promise.resolve({ stop: () => [] as Update[] }); }

  readonly strays: Array<{ kind: string; session?: string; payload: unknown; at: string }> = [];
}
