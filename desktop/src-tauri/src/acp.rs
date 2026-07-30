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

pub struct Agent {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: Mutex<u64>,
    child: Mutex<Child>,
}

#[derive(Default)]
pub struct AgentState(pub Mutex<Option<Arc<Agent>>>);

impl Agent {
    /// Launch the agent and complete the ACP handshake.
    pub async fn launch(app: AppHandle, command: &str, args: &[String]) -> Result<Arc<Self>, String> {
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
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };

                    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                        if let Some(tx) = pending.lock().await.remove(&id) {
                            let _ = tx.send(msg);
                            continue;
                        }
                    }
                    if msg.get("method").is_some() {
                        let _ = app.emit("acp://notify", msg);
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

        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut w = self.stdin.lock().await;
            w.write_all(format!("{frame}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }

        let msg = rx.await.map_err(|_| "agent closed".to_string())?;
        if let Some(err) = msg.get("error") {
            return Err(err.to_string());
        }
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn shutdown(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}
