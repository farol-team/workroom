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

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// What a line from the agent turns out to be, and the message itself.
#[derive(Debug, PartialEq)]
pub enum Inbound {
    /// An answer to a request we made, awaited under this id.
    Reply(u64, Value),
    /// The agent speaking to us — an update, or a question of its own.
    Notify(Value),
    /// Neither. A log line on stdout is not a reason to drop the connection.
    Ignore,
}

/// ACP runs in both directions, so an id does not mean "answer". A message
/// carrying a method is the agent speaking even when it carries an id — and its
/// ids are numbered from one, exactly like ours.
pub fn classify(line: &str) -> Inbound {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Inbound::Ignore;
    };
    if msg.get("method").is_some() {
        return Inbound::Notify(msg);
    }
    match msg.get("id").and_then(|v| v.as_u64()) {
        Some(id) => Inbound::Reply(id, msg),
        None => Inbound::Ignore,
    }
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
                            if let Some(tx) = pending.lock().await.remove(&id) {
                                let _ = tx.send(msg);
                            }
                        }
                        Inbound::Notify(msg) => {
                            let _ = app.emit("acp://notify", msg);
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
        });

        agent
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
                }),
            )
            .await?;

        Ok(agent)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        {
            let mut w = self.stdin.lock().await;
            w.write_all(frame(id, method, params).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }

        result_of(rx.await.map_err(|_| "agent closed".to_string())?)
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
            Inbound::Reply(7, _)
        ));
    }

    #[test]
    fn the_agent_asking_us_something_is_never_a_reply() {
        // ACP is bidirectional. A message carrying a method is the agent
        // speaking, even when it carries an id — and agent ids are numbered from
        // one, exactly like ours. Routed by id alone, the agent's first question
        // is handed to whoever awaits our first request.
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","id":1,"method":"session/request_permission"}"#),
            Inbound::Notify(_)
        ));
    }

    #[test]
    fn a_notification_reaches_the_interface() {
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Inbound::Notify(_)
        ));
    }

    #[test]
    fn a_stray_log_line_does_not_take_the_bridge_down() {
        assert_eq!(classify("Listening on stdio..."), Inbound::Ignore);
        assert_eq!(classify(""), Inbound::Ignore);
        assert_eq!(classify(r#"{"jsonrpc":"2.0"}"#), Inbound::Ignore);
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
