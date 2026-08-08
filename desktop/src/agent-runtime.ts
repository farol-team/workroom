// What the window asks of whatever runs its agents.
//
// `Agents` has had this shape since it existed; naming it is what lets a second
// implementation have it too. Nothing here is new behaviour — the members are the
// ones `main.ts` calls, and no more, so an implementation that satisfies this
// satisfies the window.

import type { AgentState } from "./agents/catalog";
import type { AgentDef, Asked, ConfigOption, ContextStore, Rail, TurnOutcome, TurnProduced, Update } from "./rules";
import type { InstallResult } from "./agent";

export interface AgentRuntime {
  /// Where a taken transcript goes. Set by the shell, because the server client
  /// lives there; unset means transcripts are not kept.
  attachTranscript?: (runId: number, name: string, body: string) => Promise<void>;

  definitions(): AgentDef[];
  use(defs: AgentDef[]): void;

  isRunning(name: string): boolean;
  readonly running: string[];
  markRunning(name: string): void;
  listRunning(): Promise<string[]>;

  start(name: string): Promise<void>;
  stop(name?: string): Promise<void>;
  probe(commands: string[]): Promise<void>;
  install(command: string): Promise<InstallResult>;
  stateOf(name: string): AgentState;

  workspace(room: string, channel: string): Promise<string>;
  turnStart(workspace: string): Promise<void>;
  produced(workspace: string): Promise<TurnProduced>;
  read(workspace: string, path: string): Promise<string>;

  sessionFor(name: string, slug: string, cwd: string, rail?: Rail,
             store?: ContextStore | null): Promise<string>;
  closeSession(name: string, sessionId: string): Promise<boolean>;
  releaseChannel(slug: string): Promise<void>;
  noteRun(sessionId: string, runId: number): void;

  configFor(name: string, slug: string): ConfigOption[];
  setConfig(name: string, slug: string, configId: string, value: string): Promise<ConfigOption[]>;
  rememberConfig(name: string, slug: string, options: ConfigOption[]): void;
  modelFor(name: string, slug: string): string | undefined;

  prompt(name: string, sessionId: string, text: string, context: string | null,
         history?: string | null): Promise<TurnOutcome>;
  cancel(name: string, sessionId: string): Promise<unknown>;
  permit(name: string, requestId: unknown, optionId: string | null): Promise<unknown>;

  onUpdate(sessionId: string, handler: (u: Update) => void): Promise<() => void>;
  onAsk(sessionId: string, handler: (asked: Asked) => void): Promise<() => void>;
  onClosed(handler: (e: { name?: string; diagnostics: string[] }) => void): Promise<() => void>;
  collect(sessionId: string): Promise<{ stop(): Update[] }>;

  readonly strays: Array<{ kind: string; session?: string; payload: unknown; at: string }>;
}
