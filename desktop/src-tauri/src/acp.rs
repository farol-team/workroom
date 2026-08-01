//! ACP bridge: speaks Agent Client Protocol over stdio to a local agent.
//!
//! The agent runs on the user's machine under the user's own credentials, so
//! nothing here ever handles a model API key. What crosses this boundary is
//! control — prompts out, updates in.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// JSON-RPC 2.0 says an id is a String or a Number. We only ever send numbers,
/// but what comes back is whatever the agent chose to send, and an agent that
/// answers `3` with `"3"` is answering — so both spell the same key. What is
/// quoted back to the agent is never this: that is the value as it arrived.
fn id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// An id worth routing on. `null` is legal JSON-RPC and means "no id".
fn routable(id: &Value) -> bool {
    id.is_string() || id.is_number()
}

/// What a line from the agent turns out to be, and the message itself.
#[derive(Debug, PartialEq)]
pub enum Inbound {
    /// An answer to a request we made, awaited under this id. Carries the id as
    /// it arrived; `id_key` is what the waiting caller is filed under.
    Reply(Value, Value),
    /// The agent asking us something, and waiting. Carries the id its answer
    /// must quote — an unanswered request is a turn that never ends.
    Ask(Value, Value),
    /// The agent telling us something. Nothing is expected back.
    Notify(Value),
    /// JSON-RPC we cannot route: an id that is neither string nor number, or a
    /// frame with neither. Distinct from `Ignore` on purpose — this is the
    /// agent speaking a protocol we both claim to speak, and dropping it in the
    /// same silence as a log line is how a turn hangs with nothing to look at.
    Unroutable(Value),
    /// Neither. A log line on stdout is not a reason to drop the connection.
    Ignore,
}

/// ACP runs in both directions, so an id does not mean "answer". A message
/// carrying a method is the agent speaking even when it carries an id.
pub fn classify(line: &str) -> Inbound {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Inbound::Ignore;
    };
    if !msg.is_object() {
        return Inbound::Ignore;
    }

    if msg.get("method").is_some() {
        return match msg.get("id") {
            None | Some(Value::Null) => Inbound::Notify(msg),
            Some(id) if routable(id) => Inbound::Ask(id.clone(), msg),
            // A question addressed by something we cannot quote back. The agent
            // is waiting on it and always will be; saying so beats silence.
            Some(_) => Inbound::Unroutable(msg),
        };
    }

    match msg.get("id") {
        Some(id) if routable(id) => Inbound::Reply(id.clone(), msg),
        _ if msg.get("jsonrpc").is_some() => Inbound::Unroutable(msg),
        _ => Inbound::Ignore,
    }
}

/// An answer to something the agent asked. It quotes the id **as it arrived**
/// or it answers nobody: the agent is blocked on that exact token, and a number
/// we re-serialised is not the string it sent.
pub fn answer_frame(id: &Value, result: Value) -> String {
    let frame = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    format!("{frame}\n")
}

/// One message, one line — the agent reads until the newline.
pub fn frame(id: u64, method: &str, params: Value) -> String {
    let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    format!("{frame}\n")
}

/// An error from the agent is an error here; a reply with no result is nothing.
pub fn result_of(msg: Value) -> Result<Value, String> {
    if let Some(err) = msg.get("error") {
        return Err(err.to_string());
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

pub struct Agent {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: Mutex<u64>,
    child: Mutex<Child>,
    /// Everything the agent said about itself when it was asked. Kept, because
    /// the handshake is where we find out the rail cannot work, and throwing it
    /// away meant finding out never (#94).
    handshake: Mutex<Value>,
}

/// Whether an agent says it can mount an HTTP MCP server — which is the only way
/// the capability rail reaches it. Read from either place agents put it: the
/// protocol nests it under `agentCapabilities`, and docs/AGENTS.md records
/// opencode reporting it at the top level.
pub fn mounts_http_mcp(handshake: &Value) -> bool {
    handshake
        .pointer("/agentCapabilities/mcpCapabilities/http")
        .or_else(|| handshake.pointer("/mcpCapabilities/http"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// How this agent says a person logs in, if it says at all. The one actionable
/// sentence an agent offers before a session can be opened, and it arrives only
/// here — `session/new` on a logged-out agent answers with an internal error.
pub fn auth_hint(handshake: &Value) -> Option<String> {
    let methods = handshake.get("authMethods")?.as_array()?;
    let hints: Vec<String> = methods
        .iter()
        .filter_map(|m| {
            let name = m.get("name").and_then(Value::as_str);
            let how = m.get("description").and_then(Value::as_str);
            match (name, how) {
                (Some(n), Some(d)) => Some(format!("{n} — {d}")),
                (Some(n), None) => Some(n.to_string()),
                (None, Some(d)) => Some(d.to_string()),
                _ => None,
            }
        })
        .collect();
    (!hints.is_empty()).then(|| hints.join("; "))
}

/// The agents a person is running, by the name they address them with. Generic
/// over what is stored so the bookkeeping can be tested without a process.
pub struct Registry<T>(Mutex<HashMap<String, T>>);

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Registry(Mutex::new(HashMap::new()))
    }
}

impl<T: Clone> Registry<T> {
    /// Replaces any agent already under this name — starting an agent twice is
    /// a restart, not a second process nobody can address.
    pub async fn insert(&self, name: &str, value: T) -> Option<T> {
        self.0.lock().await.insert(name.to_string(), value)
    }

    pub async fn get(&self, name: &str) -> Option<T> {
        self.0.lock().await.get(name).cloned()
    }

    pub async fn take(&self, name: &str) -> Option<T> {
        self.0.lock().await.remove(name)
    }

    /// Everything, emptied — quitting stops every agent, not the last one named.
    pub async fn drain(&self) -> Vec<T> {
        self.0.lock().await.drain().map(|(_, v)| v).collect()
    }

    pub async fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.0.lock().await.keys().cloned().collect();
        names.sort();
        names
    }
}

pub type AgentState = Registry<Arc<Agent>>;

impl Agent {
    /// Launch the agent and complete the ACP handshake.
    pub async fn launch(
        app: AppHandle,
        command: &str,
        args: &[String],
    ) -> Result<Arc<Self>, String> {
        let mut child = tokio::process::Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start `{command}`: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // One reader task owns stdout for the life of the process: replies go to
        // whoever is waiting, notifications become UI events.
        {
            let pending = pending.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match classify(&line) {
                        Inbound::Reply(id, msg) => {
                            if let Some(tx) = pending.lock().await.remove(&id_key(&id)) {
                                let _ = tx.send(msg);
                            }
                        }
                        Inbound::Ask(id, msg) => {
                            // Answered by the person, through the interface. A
                            // client that answers on their behalf has quietly
                            // moved the decision.
                            let _ = app.emit("acp://ask", json!({ "id": id, "request": msg }));
                        }
                        Inbound::Notify(msg) => {
                            let _ = app.emit("acp://notify", msg);
                        }
                        // Nowhere better to put it yet — surfacing what the
                        // agent says is #93's subject. What matters here is
                        // that it is no longer indistinguishable from a log
                        // line the bridge was right to skip.
                        Inbound::Unroutable(msg) => {
                            eprintln!("acp: cannot route {msg}");
                        }
                        Inbound::Ignore => {}
                    }
                }
                let _ = app.emit("acp://closed", json!({}));
            });
        }

        let agent = Arc::new(Agent {
            stdin: Mutex::new(stdin),
            pending,
            next_id: Mutex::new(0),
            child: Mutex::new(child),
            handshake: Mutex::new(Value::Null),
        });

        const PROTOCOL_VERSION: i64 = 1;
        let handshake = agent
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
                }),
            )
            .await?;

        // An agent answering a version we did not ask for is worth saying before
        // the first turn rather than after it behaves oddly. Not fatal: the
        // protocol is young and this is information, not a verdict.
        match handshake.get("protocolVersion").and_then(Value::as_i64) {
            Some(v) if v == PROTOCOL_VERSION => {}
            other => {
                eprintln!("acp: asked for protocol {PROTOCOL_VERSION}, agent answered {other:?}")
            }
        }

        *agent.handshake.lock().await = handshake;
        Ok(agent)
    }

    /// What the agent said about itself. Empty until the handshake completes,
    /// which cannot be observed from outside — `launch` does not return early.
    pub async fn handshake(&self) -> Value {
        self.handshake.lock().await.clone()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };
        let (tx, rx) = oneshot::channel();
        // Filed under the same key the reply will be looked up by, whichever
        // way the agent chooses to spell the id back.
        self.pending.lock().await.insert(id_key(&json!(id)), tx);

        {
            let mut w = self.stdin.lock().await;
            w.write_all(frame(id, method, params).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }

        result_of(rx.await.map_err(|_| "agent closed".to_string())?)
    }

    /// Answer something the agent asked. One line, quoting its id — the agent is
    /// blocked until it arrives.
    pub async fn answer(&self, id: &Value, result: Value) -> Result<(), String> {
        let line = answer_frame(id, result);
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    pub async fn shutdown(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_agent_is_reached_by_the_name_it_was_started_under() {
        let reg: Registry<u32> = Registry::default();
        reg.insert("opencode", 1).await;
        reg.insert("claude", 2).await;

        assert_eq!(reg.get("opencode").await, Some(1));
        assert_eq!(reg.get("claude").await, Some(2));
        assert_eq!(
            reg.get("kimi").await,
            None,
            "an agent nobody started is not running"
        );
        assert_eq!(reg.names().await, vec!["claude", "opencode"]);
    }

    #[tokio::test]
    async fn starting_an_agent_twice_replaces_it() {
        // Otherwise the first process is orphaned: still running, no longer
        // addressable, and holding the user's credentials open.
        let reg: Registry<u32> = Registry::default();
        reg.insert("opencode", 1).await;
        let displaced = reg.insert("opencode", 2).await;

        assert_eq!(
            displaced,
            Some(1),
            "the old process is handed back to be shut down"
        );
        assert_eq!(reg.get("opencode").await, Some(2));
        assert_eq!(reg.names().await.len(), 1);
    }

    #[tokio::test]
    async fn stopping_one_agent_leaves_the_others_running() {
        let reg: Registry<u32> = Registry::default();
        reg.insert("opencode", 1).await;
        reg.insert("claude", 2).await;

        assert_eq!(reg.take("claude").await, Some(2));
        assert_eq!(reg.names().await, vec!["opencode"]);
        assert_eq!(reg.take("claude").await, None, "taking twice is harmless");
    }

    #[tokio::test]
    async fn quitting_stops_every_agent() {
        let reg: Registry<u32> = Registry::default();
        reg.insert("opencode", 1).await;
        reg.insert("claude", 2).await;

        let mut all = reg.drain().await;
        all.sort();
        assert_eq!(
            all,
            vec![1, 2],
            "every process is handed back, not just the last"
        );
        assert!(reg.names().await.is_empty());
    }

    #[test]
    fn a_reply_goes_to_whoever_asked() {
        let Inbound::Reply(id, msg) = classify(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#)
        else {
            panic!("a result is a reply")
        };
        assert_eq!(id, 7);
        assert_eq!(msg["result"]["ok"], true, "the reply arrives intact");
    }

    #[test]
    fn an_error_is_still_a_reply() {
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32601}}"#),
            Inbound::Reply(id, _) if id == 7
        ));
    }

    // JSON-RPC 2.0 says an id is a String or a Number. Everything this client
    // has ever spoken to numbers them, which is why reading ids with `as_u64`
    // was invisible: the first agent to use strings does not fail, it hangs.

    #[test]
    fn a_reply_under_a_string_id_still_reaches_whoever_asked() {
        let Inbound::Reply(id, msg) =
            classify(r#"{"jsonrpc":"2.0","id":"7","result":{"ok":true}}"#)
        else {
            panic!("a string id is an id")
        };
        assert_eq!(msg["result"]["ok"], true);
        assert_eq!(
            id_key(&id),
            id_key(&json!(7)),
            "an agent that answers 7 with \"7\" is answering, and the caller is filed under one key"
        );
    }

    #[test]
    fn a_question_under_a_string_id_is_a_question() {
        let Inbound::Ask(id, _) = classify(
            r#"{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{}}"#,
        ) else {
            panic!("a method with a string id is a question, not an announcement")
        };
        assert_eq!(id, "perm-1");
    }

    #[test]
    fn an_answer_quotes_a_string_id_as_it_arrived() {
        let line = answer_frame(&json!("perm-1"), json!({ "outcome": "cancelled" }));
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();

        assert_eq!(
            parsed["id"], "perm-1",
            "the agent is blocked on that exact token, not on our reading of it"
        );
    }

    // The handshake is the only place an agent says whether the rail can reach
    // it. Discarded, the answer was assumed — and an agent that cannot mount an
    // HTTP MCP server accepts the session, ignores the rail, and answers the
    // turn confidently from nothing.

    #[test]
    fn an_agent_that_mounts_http_mcp_says_so_wherever_it_says_it() {
        // The protocol nests this under agentCapabilities; docs/AGENTS.md
        // records opencode reporting it at the top level. Both are the agent
        // saying yes.
        assert!(mounts_http_mcp(&json!({
            "agentCapabilities": { "mcpCapabilities": { "http": true, "sse": true } }
        })));
        assert!(mounts_http_mcp(&json!({
            "mcpCapabilities": { "http": true, "sse": true }
        })));
    }

    #[test]
    fn silence_about_http_mcp_is_not_a_yes() {
        assert!(!mounts_http_mcp(&json!({})));
        assert!(!mounts_http_mcp(&Value::Null));
        assert!(!mounts_http_mcp(&json!({
            "agentCapabilities": { "mcpCapabilities": { "sse": true } }
        })));
        assert!(
            !mounts_http_mcp(&json!({
                "agentCapabilities": { "mcpCapabilities": { "http": false } }
            })),
            "an agent that says no is not an agent that said nothing"
        );
    }

    #[test]
    fn the_way_in_is_whatever_the_agent_said_it_was() {
        // Measured against @agentclientprotocol/claude-agent-acp: a logged-out
        // agent answers session/new with an opaque internal error and puts the
        // instruction here.
        let hint = auth_hint(&json!({
            "authMethods": [ { "id": "claude-login", "name": "Log in with Claude Code",
                               "description": "Run `claude /login` in the terminal" } ]
        }));

        let Some(hint) = hint else {
            panic!("an agent that says how to log in must be quoted")
        };
        assert!(hint.contains("claude /login"), "the instruction survives");
    }

    #[test]
    fn an_agent_with_nothing_to_say_about_logging_in_says_nothing() {
        assert_eq!(auth_hint(&json!({ "authMethods": [] })), None);
        assert_eq!(auth_hint(&json!({})), None);
    }

    #[test]
    fn json_rpc_we_cannot_route_is_not_a_log_line() {
        // Both are dropped, and only one of them should be quiet about it.
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","id":{"seq":1},"method":"session/request_permission"}"#),
            Inbound::Unroutable(_)
        ));
        assert_eq!(classify("Listening on stdio..."), Inbound::Ignore);
    }

    #[test]
    fn the_agent_asking_us_something_is_never_a_reply() {
        // ACP is bidirectional. A message carrying a method is the agent
        // speaking, even when it carries an id — and agent ids are numbered from
        // one, exactly like ours. Routed by id alone, the agent's first question
        // is handed to whoever awaits our first request.
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","id":1,"method":"session/request_permission"}"#),
            Inbound::Ask(id, _) if id == 1
        ));
    }

    #[test]
    fn the_agent_asking_us_something_needs_an_answer_with_its_id() {
        // A request carries an id and a method. Treated as a notification it is
        // never answered, and the agent waits for the rest of the session.
        let Inbound::Ask(id, _) = classify(
            r#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}"#,
        ) else {
            panic!("a method with an id is a question, not an announcement")
        };
        assert_eq!(id, 7);
    }

    #[test]
    fn a_notification_reaches_the_interface() {
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Inbound::Notify(_)
        ));
    }

    #[test]
    fn an_answer_quotes_the_id_it_answers() {
        let line = answer_frame(
            &json!(7),
            json!({ "outcome": { "outcome": "selected", "optionId": "yes" } }),
        );
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();

        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["result"]["outcome"]["optionId"], "yes");
        assert!(
            parsed.get("method").is_none(),
            "an answer is not a new request"
        );
        assert!(
            line.ends_with('\n'),
            "one message per line, or the agent waits forever"
        );
    }

    #[test]
    fn a_stray_log_line_does_not_take_the_bridge_down() {
        assert_eq!(classify("Listening on stdio..."), Inbound::Ignore);
        assert_eq!(classify(""), Inbound::Ignore);
        assert_eq!(classify("42"), Inbound::Ignore);
        // A frame with neither method nor id used to land here too, and it is
        // not a log line — it is us and the agent disagreeing about JSON-RPC.
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0"}"#),
            Inbound::Unroutable(_)
        ));
    }

    #[test]
    fn what_we_write_is_json_rpc_the_agent_can_read() {
        let line = frame(3, "session/prompt", json!({ "sessionId": "s1" }));
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();

        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], 3);
        assert_eq!(parsed["method"], "session/prompt");
        assert_eq!(parsed["params"]["sessionId"], "s1");
        assert!(
            line.ends_with('\n'),
            "one message per line, or the agent waits forever"
        );
    }

    #[test]
    fn an_agent_error_becomes_an_error_here() {
        let err = result_of(json!({ "id": 1, "error": { "message": "no such session" } }));
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("no such session"));

        assert_eq!(
            result_of(json!({ "id": 1, "result": { "n": 1 } })).unwrap()["n"],
            1
        );
        assert_eq!(result_of(json!({ "id": 1 })).unwrap(), Value::Null);
    }
}

/// Against a second implementation of the protocol, over a real pipe.
///
/// Everything else in this file is exercised against strings we wrote. Both
/// defects in #68 — a header shape the agent cannot read, and a question nobody
/// answers — were invisible from the inside and obvious from the outside.
#[cfg(test)]
mod against_a_real_agent {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    fn agent() -> std::process::Child {
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-agent/agent.mjs");
        Command::new("node")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("node is required for the protocol test")
    }

    #[test]
    fn a_turn_completes_with_the_rail_readable_and_the_question_answered() {
        let mut child = agent();
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());

        let mut say = |line: String| {
            stdin.write_all(line.as_bytes()).unwrap();
            stdin.flush().unwrap();
        };
        let mut hear = || {
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            serde_json::from_str::<Value>(&line).unwrap()
        };

        say(frame(1, "initialize", json!({ "protocolVersion": 1 })));
        assert_eq!(hear()["result"]["protocolVersion"], 1);

        // The rail, in the shape the schema defines.
        say(frame(
            2,
            "session/new",
            json!({ "cwd": "/tmp", "mcpServers": [ {
                "name": "workroom", "type": "http", "url": "http://127.0.0.1:3000/api/rail/meetings",
                "headers": [ { "name": "Authorization", "value": "Bearer tok" } ] } ] }),
        ));
        let session = hear()["result"]["sessionId"].as_str().unwrap().to_string();

        say(frame(
            3,
            "session/prompt",
            json!({ "sessionId": session,
            "prompt": [ { "type": "text", "text": "[ask] do the thing" } ] }),
        ));

        let mut heard = Vec::new();
        loop {
            let msg = hear();
            // The agent asks; nothing happens until we answer.
            if msg["method"] == "session/request_permission" {
                let id = msg["id"].as_u64().unwrap();
                let options = msg["params"]["options"].as_array().unwrap().clone();
                assert_eq!(options[0]["optionId"], "yes");
                say(format!(
                    "{}\n",
                    json!({ "jsonrpc": "2.0", "id": id,
                            "result": { "outcome": { "outcome": "selected", "optionId": "yes" } } })
                ));
                continue;
            }
            if msg["method"] == "session/update" {
                heard.push(
                    msg["params"]["update"]["content"]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                );
                continue;
            }
            if msg["id"] == 3 {
                assert_eq!(msg["result"]["stopReason"], "end_turn", "the turn ended");
                break;
            }
        }

        let said = heard.join(" ");
        assert!(
            said.contains(r#""name":"Authorization""#),
            "the agent must be able to read the rail's header: {said}"
        );
        assert!(
            said.contains(r#""optionId":"yes""#),
            "the answer must reach the agent, or the turn never ends: {said}"
        );

        // Reaped, not merely killed: a test that leaves a zombie behind is a
        // test that leaves something behind on somebody's machine.
        let _ = child.kill();
        let _ = child.wait();
    }
}
