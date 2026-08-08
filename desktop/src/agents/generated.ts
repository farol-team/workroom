// Generated from acp-agents::HARNESSES. Do not edit.
//
// The table lives in farol-team/acp-agents, with the other products that
// run a local agent over ACP. Change it there, then regenerate with
// `UPDATE_CATALOG=1 cargo test` in desktop/src-tauri.
//
// Only agents this application can fetch appear here: the panel's whole
// job is a button, and an agent with no package has nothing behind one.

import type { AgentProfile } from "./catalog";

export const BASELINE: AgentProfile[] = [
  {
    name: "claude", label: "Claude Code", command: "claude-agent-acp", args: [],
    package: "@agentclientprotocol/claude-agent-acp",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/overview",
  },
  {
    name: "codex", label: "Codex", command: "codex-acp", args: [],
    package: "@agentclientprotocol/codex-acp",
    docsUrl: "https://developers.openai.com/codex/cli/",
  },
  {
    name: "opencode", label: "OpenCode", command: "opencode", args: [ "acp" ],
    package: "opencode-ai",
    docsUrl: "https://opencode.ai/docs/acp/",
  },
];
