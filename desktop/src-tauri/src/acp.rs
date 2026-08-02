//! ACP bridge: speaks Agent Client Protocol over stdio to a local agent.
//!
//! The agent runs on the user's machine under the user's own credentials, so
//! nothing here ever handles a model API key. What crosses this boundary is
//! control — prompts out, updates in.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;
type Diagnostics = Arc<Mutex<VecDeque<String>>>;
/// When each session last showed a sign of life, and under `EVERYTHING` when the
/// agent last said anything at all — for requests that name no session.
type Activity = Arc<Mutex<HashMap<String, Instant>>>;

/// The key for "the agent said something", regardless of which session. A slash
/// cannot appear in an id we would otherwise collide with.
const EVERYTHING: &str = "/any";

/// A turn that is streaming is working, however long it takes. A turn that has
/// said nothing for this long has stopped, whatever it believes. Idle rather
/// than total, because total punishes the long turns this product is for.
const IDLE_LIMIT: Duration = Duration::from_secs(620);

/// And a wall clock, because an agent can be talkative and stuck at once.
const HARD_LIMIT: Duration = Duration::from_secs(7200);

/// How often the wait wakes up to ask whether it has been abandoned.
const DEADLINE_TICK: Duration = Duration::from_secs(5);

/// How much of the agent's stderr is worth keeping. Enough for a stack trace or
/// a refusal, far short of a session's logging.
const DIAGNOSTIC_LINES: usize = 50;

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

/// A message with no id, which is what the protocol calls a notification and
/// what makes it one: nothing is expected back. `session/cancel` is one, and
/// every frame this bridge could produce carried an id, so it could not send it.
pub fn notify_frame(method: &str, params: Value) -> String {
    let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
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
    /// The last thing it said on stderr. Not work product and not a step, so it
    /// belongs nowhere in the room — and everywhere a person asks why (#93).
    diagnostics: Diagnostics,
    /// When each session last showed a sign of life. A turn with no deadline is
    /// a run that says "working" forever to everybody watching (#92).
    activity: Activity,
}

/// Which session a message is about, when it says. `session/update` carries it,
/// and so does every request that belongs to one — so a turn is measured by its
/// own silence rather than by another channel's chatter.
fn session_of(msg: &Value) -> Option<String> {
    msg.pointer("/params/sessionId")
        .or_else(|| msg.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::to_string)
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

/// Whether the agent says it can close a session. Guarded rather than called
/// blind, for the same reason the rail is checked before it is mounted: an
/// agent that never said it could is one whose answer we invented.
///
/// The capability is an object, not a flag — its presence is the yes.
pub fn closes_sessions(handshake: &Value) -> bool {
    handshake
        .pointer("/agentCapabilities/sessionCapabilities/close")
        .or_else(|| handshake.pointer("/sessionCapabilities/close"))
        .is_some_and(|v| !v.is_null())
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
        name: &str,
        command: &str,
        args: &[String],
    ) -> Result<Arc<Self>, String> {
        let mut child = tokio::process::Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Kept, not discarded. An agent that starts and then cannot work
            // says why here — a missing credential, a config it could not read —
            // and `opencode acp` starts perfectly well having never been logged
            // in to. Thrown away, that leaves "the agent is online and silent"
            // and nothing to look at (#93).
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start `{command}`: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let diagnostics: Diagnostics = Arc::new(Mutex::new(VecDeque::new()));
        let activity: Activity = Arc::new(Mutex::new(HashMap::new()));

        // A tail, not a log: the last thing the agent said, for a person asking
        // why it is not answering.
        {
            let diagnostics = diagnostics.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = diagnostics.lock().await;
                    if tail.len() == DIAGNOSTIC_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }

        // One reader task owns stdout for the life of the process: replies go to
        // whoever is waiting, notifications become UI events.
        {
            let pending = pending.clone();
            let closing = diagnostics.clone();
            let closing_name = name.to_string();
            let heard = activity.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let inbound = classify(&line);

                    // Any line is a sign of life; one that names a session is a
                    // sign of life for that turn in particular, so a busy
                    // channel cannot keep a stuck one looking alive.
                    if let Inbound::Reply(_, msg) | Inbound::Ask(_, msg) | Inbound::Notify(msg) =
                        &inbound
                    {
                        let now = Instant::now();
                        let mut seen = heard.lock().await;
                        seen.insert(EVERYTHING.to_string(), now);
                        if let Some(session) = session_of(msg) {
                            seen.insert(session, now);
                        }
                    }

                    match inbound {
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
                // Which agent stopped, and the last thing it said. A name is
                // the difference between "an agent stopped" and something a
                // person can act on when several are running.
                let tail: Vec<String> = closing.lock().await.iter().cloned().collect();
                let _ = app.emit(
                    "acp://closed",
                    json!({ "name": closing_name, "diagnostics": tail }),
                );
            });
        }

        let agent = Arc::new(Agent {
            stdin: Mutex::new(stdin),
            pending,
            next_id: Mutex::new(0),
            child: Mutex::new(child),
            handshake: Mutex::new(Value::Null),
            diagnostics: diagnostics.clone(),
            activity: activity.clone(),
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
            .await;

        // A handshake that fails is an agent that started and cannot work.
        // Whatever it said on the way down is the only thing that explains it —
        // `cannot start` covers only a binary that was never there.
        let handshake = match handshake {
            Ok(reply) => reply,
            Err(error) => {
                let tail = agent.diagnostics().await;
                return Err(if tail.is_empty() {
                    error
                } else {
                    format!("{error}\n\n{command} said:\n{}", tail.join("\n"))
                });
            }
        };

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

    /// The last lines the agent wrote to stderr, oldest first.
    pub async fn diagnostics(&self) -> Vec<String> {
        self.diagnostics.lock().await.iter().cloned().collect()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };
        // Measured against this session's own silence where the request names
        // one, and against the agent's where it does not.
        let watching = session_of(&json!({ "params": &params })).unwrap_or(EVERYTHING.into());
        let key = id_key(&json!(id));

        let (tx, rx) = oneshot::channel();
        // Filed under the same key the reply will be looked up by, whichever
        // way the agent chooses to spell the id back.
        self.pending.lock().await.insert(key.clone(), tx);

        {
            let mut w = self.stdin.lock().await;
            w.write_all(frame(id, method, params).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }

        // Sending is a sign of life too, or a first request would be judged
        // against a clock that started when the agent last spoke.
        let sent = Instant::now();
        self.activity.lock().await.insert(watching.clone(), sent);

        result_of(self.awaited(rx, &key, &watching, sent).await?)
    }

    /// Wait for a reply, and stop waiting when nothing is coming.
    ///
    /// Idle rather than total: a turn that is streaming is working however long
    /// it takes, and a turn that has said nothing for ten minutes has stopped
    /// whatever it believes. The wall clock is there because an agent can be
    /// talkative and stuck at the same time.
    ///
    /// The waiting caller is unfiled on the way out, or a hung request leaks its
    /// slot for the life of the process.
    async fn awaited(
        &self,
        mut rx: oneshot::Receiver<Value>,
        key: &str,
        watching: &str,
        sent: Instant,
    ) -> Result<Value, String> {
        loop {
            match tokio::time::timeout(DEADLINE_TICK, &mut rx).await {
                Ok(Ok(msg)) => return Ok(msg),
                Ok(Err(_)) => {
                    self.pending.lock().await.remove(key);
                    return Err("agent closed".into());
                }
                Err(_) => {
                    let idle = self
                        .activity
                        .lock()
                        .await
                        .get(watching)
                        .map(Instant::elapsed)
                        .unwrap_or_else(|| sent.elapsed());

                    let why = if idle >= IDLE_LIMIT {
                        format!("said nothing for {} seconds", idle.as_secs())
                    } else if sent.elapsed() >= HARD_LIMIT {
                        format!("has been at it for {} seconds", sent.elapsed().as_secs())
                    } else {
                        continue;
                    };

                    self.pending.lock().await.remove(key);
                    return Err(format!(
                        "the agent {why}, so this turn was given up on. Its session is still \
                         open — ask it again, or stop the agent."
                    ));
                }
            }
        }
    }

    /// Ask the agent to abandon the turn it is on. A notification, so nothing
    /// comes back; the turn it aborts ends as a failure with its steps intact,
    /// and the session survives — which is the whole difference from killing the
    /// process.
    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        let line = notify_frame("session/cancel", json!({ "sessionId": session_id }));
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
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
    fn a_notification_carries_no_id_or_it_is_a_question() {
        // `frame` always attaches an id, so every message this bridge could
        // produce expected an answer — which is why `session/cancel`, a
        // notification, could not be sent at all (#92).
        let line = notify_frame("session/cancel", json!({ "sessionId": "s1" }));
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();

        assert_eq!(parsed["method"], "session/cancel");
        assert_eq!(parsed["params"]["sessionId"], "s1");
        assert!(
            parsed.get("id").is_none(),
            "an id makes it a request, and nothing is coming back"
        );
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn a_turn_is_measured_by_its_own_silence() {
        // Otherwise one busy channel keeps a stuck turn in another looking
        // alive, on an agent that serves every room this person has open.
        assert_eq!(
            session_of(&json!({ "params": { "sessionId": "s1", "update": {} } })),
            Some("s1".to_string())
        );
        assert_eq!(
            session_of(&json!({ "sessionId": "s2" })),
            Some("s2".to_string())
        );
        assert_eq!(session_of(&json!({ "params": { "cwd": "/tmp" } })), None);
    }

    #[test]
    fn an_agent_that_closes_sessions_says_so() {
        // Measured against @agentclientprotocol/claude-agent-acp 0.64.0. The
        // capability is an object, not a flag — its presence is the yes.
        assert!(closes_sessions(&json!({
            "agentCapabilities": { "sessionCapabilities": {
                "additionalDirectories": {}, "close": {}, "delete": {},
                "fork": {}, "list": {}, "resume": {} } }
        })));
        assert!(closes_sessions(&json!({
            "sessionCapabilities": { "close": {}, "fork": {} }
        })));
    }

    #[test]
    fn an_agent_that_did_not_say_it_closes_sessions_is_not_asked_to() {
        // The deprecated adapter this project baselined advertises fork, list
        // and resume, and no close. Calling it blind is the same mistake as
        // mounting a rail on an agent that never said it could hold one.
        assert!(!closes_sessions(&json!({
            "agentCapabilities": { "sessionCapabilities": {
                "fork": {}, "list": {}, "resume": {} } }
        })));
        assert!(!closes_sessions(&json!({ "agentCapabilities": {} })));
        assert!(!closes_sessions(&Value::Null));
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

/// Against a second implementation of the protocol, over a real pipe — and
/// through this client rather than around it.
///
/// Everything above is exercised against strings we wrote. Both defects in #68
/// — a header shape the agent cannot read, and a question nobody answers — were
/// invisible from the inside and obvious from the outside. What used to be
/// outside was a hand-rolled client in this file, which proved the scripted
/// agent works and said nothing about `launch`, `request` or `answer`. It is
/// the real one now (#174).
///
/// Two seams make it possible, and both exist for a reason a test can state:
/// `launch` takes what to emit rather than an `AppHandle`, because a window is
/// the one thing a test cannot have; and it takes the clocks a turn is measured
/// against, because ten idle minutes is not a thing a suite can wait out.
#[cfg(test)]
mod against_a_real_agent {
    use super::*;

    /// Everything the interface would have been told, recorded instead — and,
    /// for each event, whether the people waiting had already been let go when
    /// it went out. `None` there means the map was locked at that instant and
    /// the order cannot be read from here.
    type Heard = Vec<(String, Value, Option<bool>)>;

    pub(super) struct Watcher {
        heard: Arc<std::sync::Mutex<Heard>>,
        waiting: Arc<std::sync::Mutex<Option<Pending>>>,
    }

    impl Watcher {
        pub(super) fn new() -> Self {
            Watcher {
                heard: Arc::new(std::sync::Mutex::new(Vec::new())),
                waiting: Arc::new(std::sync::Mutex::new(None)),
            }
        }

        /// What an agent is launched with, in place of a window.
        pub(super) fn emit(&self) -> impl Fn(&str, Value) + Send + 'static {
            let heard = self.heard.clone();
            let waiting = self.waiting.clone();
            move |event: &str, payload: Value| {
                let drained = waiting
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|pending| pending.try_lock().map(|map| map.is_empty()).ok());
                heard
                    .lock()
                    .unwrap()
                    .push((event.to_string(), payload, drained));
            }
        }

        /// The map of people waiting, once the agent that owns it exists.
        pub(super) fn watching(&self, pending: Pending) {
            *self.waiting.lock().unwrap() = Some(pending);
        }

        pub(super) fn saw(&self, event: &str) -> bool {
            self.heard
                .lock()
                .unwrap()
                .iter()
                .any(|(e, _, _)| e == event)
        }

        /// The one event of this kind, and what the map looked like as it went.
        pub(super) fn only(&self, event: &str) -> (Value, Option<bool>) {
            let heard = self.heard.lock().unwrap();
            let mut found = heard.iter().filter(|(e, _, _)| e == event);
            let (_, payload, drained) = found
                .next()
                .unwrap_or_else(|| panic!("nothing was emitted as {event}"));
            assert!(
                found.next().is_none(),
                "{event} went out more than once, and it is not a thing that happens twice"
            );
            (payload.clone(), *drained)
        }

        /// Everything the agent said on the way, as the interface would show it.
        pub(super) fn said(&self) -> String {
            self.heard
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _, _)| event == "acp://notify")
                .filter_map(|(_, msg, _)| {
                    msg.pointer("/params/update/content/text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join(" ")
        }
    }

    /// The scripted agent, launched the way the application launches one.
    pub(super) async fn launched(watcher: &Watcher, name: &str) -> Arc<Agent> {
        launched_with(watcher, name, Deadlines::default()).await
    }

    /// The same, on clocks a test can wait out.
    pub(super) async fn launched_with(
        watcher: &Watcher,
        name: &str,
        clocks: Deadlines,
    ) -> Arc<Agent> {
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-agent/agent.mjs");
        Agent::launch(
            name,
            "node",
            &[script.to_string_lossy().into_owned()],
            clocks,
            watcher.emit(),
        )
        .await
        .expect("node and the scripted agent are required to speak the protocol")
    }

    pub(super) async fn session_on(agent: &Arc<Agent>, mcp_servers: Value) -> String {
        agent
            .request(
                "session/new",
                json!({ "cwd": "/tmp", "mcpServers": mcp_servers }),
            )
            .await
            .expect("the scripted agent opens a session")["sessionId"]
            .as_str()
            .expect("a session has an id")
            .to_string()
    }

    /// "[ask]" is the one thing the scripted agent does not answer on its own:
    /// it asks for permission and waits. Until somebody answers, the turn is in
    /// flight — which is what a completed turn needs and what a crash needs to
    /// interrupt.
    pub(super) fn a_turn_that_waits(session: &str) -> Value {
        json!({
            "sessionId": session,
            "prompt": [ { "type": "text", "text": "[ask] do the thing" } ]
        })
    }

    /// A turn the agent finishes on its own, and says something about on the
    /// way — which is what a sign of life is.
    pub(super) fn a_turn_that_answers(session: &str) -> Value {
        json!({
            "sessionId": session,
            "prompt": [ { "type": "text", "text": "still here" } ]
        })
    }

    pub(super) fn permission_granted() -> Value {
        json!({ "outcome": { "outcome": "selected", "optionId": "yes" } })
    }

    /// Waits for something to become true rather than for a duration somebody
    /// guessed, and gives up rather than hanging the suite.
    pub(super) async fn until(what: &str, mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if ready() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("{what}");
    }

    #[tokio::test]
    async fn a_turn_completes_with_the_rail_readable_and_the_question_answered() {
        let watcher = Watcher::new();
        let agent = launched(&watcher, "claude").await;
        watcher.watching(agent.pending.clone());

        assert!(
            mounts_http_mcp(&agent.handshake().await),
            "what the agent said about itself is kept, or the rail is mounted on hope"
        );

        // The rail, in the shape the schema defines.
        let session = session_on(
            &agent,
            json!([ { "name": "workroom", "type": "http",
                      "url": "http://127.0.0.1:3000/api/rail/meetings",
                      "headers": [ { "name": "Authorization", "value": "Bearer tok" } ] } ]),
        )
        .await;

        let turn = tokio::spawn({
            let (agent, session) = (agent.clone(), session.clone());
            async move {
                agent
                    .request("session/prompt", a_turn_that_waits(&session))
                    .await
            }
        });

        // The agent asks, and nothing happens until a person answers — through
        // this client, which is the half of #68 a hand-rolled one cannot see.
        until("the agent must ask before it can be answered", || {
            watcher.saw("acp://ask")
        })
        .await;
        let (asked, _) = watcher.only("acp://ask");
        assert_eq!(asked["request"]["params"]["options"][0]["optionId"], "yes");
        agent
            .answer(&asked["id"], permission_granted())
            .await
            .expect("the answer must be written");

        let done = tokio::time::timeout(Duration::from_secs(10), turn)
            .await
            .expect("an answered question ends the turn")
            .unwrap()
            .expect("a turn the agent finished is an answer, not an error");
        assert_eq!(done["stopReason"], "end_turn", "the turn ended");

        let said = watcher.said();
        assert!(
            said.contains(r#""name":"Authorization""#),
            "the agent must be able to read the rail's header: {said}"
        );
        assert!(
            said.contains(r#""optionId":"yes""#),
            "the answer must reach the agent, or the turn never ends: {said}"
        );
        assert!(
            agent.pending.lock().await.is_empty(),
            "an answered request is unfiled by the reader that answered it"
        );
        assert!(
            !watcher.saw("acp://closed"),
            "an agent that is still reading has not closed — a reader that let go of the living \
             would end every turn the moment it started"
        );

        agent.shutdown().await;
    }
}

/// What happens to the people waiting when the process on the other end goes
/// away, and what must not happen to the ones still being talked to (#174).
///
/// Through `launch` and `request` against the scripted agent, because that is
/// where the defect lives: a crash nobody notices reads as a turn that says
/// "working" for ten idle minutes, and nothing assembled by hand in this file
/// can see it.
#[cfg(test)]
mod when_the_agent_dies {
    use super::against_a_real_agent::{
        a_turn_that_answers, a_turn_that_waits, launched, launched_with, permission_granted,
        session_on, until, Watcher,
    };
    use super::*;

    /// Long enough that a machine starting node cannot be mistaken for an agent
    /// that has stopped talking, short enough that the suite can wait it out.
    const IDLE: Duration = Duration::from_millis(800);

    /// A wait this side of the injected deadline is the deadline working; one
    /// past it is the ten minutes and the five-second tick still compiled in.
    const PATIENCE: Duration = Duration::from_secs(6);

    fn clocks(idle: Duration, hard: Duration) -> Deadlines {
        Deadlines {
            idle,
            hard,
            // The wait wakes up often enough that the limits above are what the
            // measurement is about, rather than the tick they are noticed on.
            tick: Duration::from_millis(20),
        }
    }

    #[tokio::test]
    async fn a_turn_waiting_on_an_agent_that_died_is_told_the_agent_closed() {
        let watcher = Watcher::new();
        let agent = launched(&watcher, "claude").await;
        watcher.watching(agent.pending.clone());
        let session = session_on(&agent, json!([])).await;

        let started = Instant::now();
        let turn = tokio::spawn({
            let (agent, session) = (agent.clone(), session.clone());
            async move {
                agent
                    .request("session/prompt", a_turn_that_waits(&session))
                    .await
            }
        });

        until(
            "the agent must be waiting on us before it is killed",
            || watcher.saw("acp://ask"),
        )
        .await;

        // The process dies under the turn: killed, crashed, out of memory.
        agent.shutdown().await;

        let error = tokio::time::timeout(Duration::from_secs(5), turn)
            .await
            .expect("the wait ends when the process does, not ten idle minutes later")
            .unwrap()
            .expect_err("a turn whose agent died did not succeed");

        assert_eq!(
            error, "agent closed",
            "the turn is told what happened, in the words the interface already shows"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "and told at once — the ten idle minutes compiled in cannot be what ended it ({:?})",
            started.elapsed()
        );
        assert!(
            agent.pending.lock().await.is_empty(),
            "a turn that ended is unfiled, whichever way it ended"
        );

        until("the room must be told the agent stopped", || {
            watcher.saw("acp://closed")
        })
        .await;
        let (closed, drained) = watcher.only("acp://closed");
        assert_eq!(
            closed["name"], "claude",
            "which agent stopped, or a person running several has nothing to act on"
        );
        assert_eq!(
            drained,
            Some(true),
            "empty the map, drop its lock, then say the agent closed. Told in the other order, a \
             room shows a stopped agent with a turn still spinning in it"
        );
    }

    #[tokio::test]
    async fn a_request_that_cannot_be_written_forgets_it_was_ever_filed() {
        let watcher = Watcher::new();
        let agent = launched(&watcher, "claude").await;
        watcher.watching(agent.pending.clone());
        agent.shutdown().await;

        // The reader has run out of stdout and finished before anything is
        // asked — so a slot left behind can only be the one this request filed
        // and did not take back. Racing it against the drain would let the
        // reader tidy up on the writer's behalf, and pass either way.
        until(
            "the reader must have exited before anything is asked",
            || watcher.saw("acp://closed"),
        )
        .await;

        let error = agent
            .request("session/prompt", json!({ "sessionId": "ses_1" }))
            .await
            .expect_err("a frame that could not be written is not a request that was made");

        assert!(
            !error.contains("said nothing for"),
            "it failed at the write, not by waiting out a deadline: {error}"
        );
        assert!(
            agent.pending.lock().await.is_empty(),
            "a request the agent never saw leaves no slot behind, or the map fills with replies \
             that can never come"
        );
    }

    #[tokio::test]
    async fn a_turn_that_keeps_talking_is_never_given_up_on() {
        // The clock measures silence, not length. A turn that streams for hours
        // is working, and the long turns are what this product is for — read as
        // total elapsed instead, the deadline kills exactly the work it was
        // built to protect.
        let watcher = Watcher::new();
        let agent =
            launched_with(&watcher, "claude", clocks(IDLE, Duration::from_secs(3600))).await;
        let session = session_on(&agent, json!([])).await;

        let started = Instant::now();
        let turn = tokio::spawn({
            let (agent, session) = (agent.clone(), session.clone());
            async move {
                agent
                    .request("session/prompt", a_turn_that_waits(&session))
                    .await
            }
        });
        until("the agent must be waiting on us", || {
            watcher.saw("acp://ask")
        })
        .await;

        // Eight signs of life about this session, each one inside the deadline
        // and the lot of them several times past it. This is a streaming turn,
        // said in the only vocabulary the scripted agent has.
        for _ in 0..8 {
            tokio::time::sleep(IDLE / 2).await;
            agent
                .request("session/prompt", a_turn_that_answers(&session))
                .await
                .expect("a turn the agent finishes while another waits is an answer");
        }
        assert!(
            started.elapsed() > IDLE * 3,
            "the wait has to outlast the idle limit several times over for this to mean \
             anything ({:?})",
            started.elapsed()
        );

        // And it ends because the person answered, not because a clock ran out.
        let (asked, _) = watcher.only("acp://ask");
        agent
            .answer(&asked["id"], permission_granted())
            .await
            .expect("the answer must be written");

        let done = tokio::time::timeout(PATIENCE, turn)
            .await
            .expect("an answered question ends the turn")
            .unwrap()
            .expect(
                "a turn whose agent kept talking was never given up on — the clock measures the \
                 silence since the last sign of life, not how long the turn has run",
            );
        assert_eq!(done["stopReason"], "end_turn");

        agent.shutdown().await;
    }

    #[tokio::test]
    async fn a_turn_that_hears_nothing_is_given_up_on_at_its_idle_deadline() {
        let watcher = Watcher::new();
        let agent =
            launched_with(&watcher, "claude", clocks(IDLE, Duration::from_secs(3600))).await;
        let session = session_on(&agent, json!([])).await;

        // Asked, answered with a question, and then nothing — nobody answers
        // the agent, so nobody hears from it again either.
        let started = Instant::now();
        let error = tokio::time::timeout(
            PATIENCE,
            agent.request("session/prompt", a_turn_that_waits(&session)),
        )
        .await
        .expect("the deadline this agent was given is the one that fires")
        .expect_err("silence past the deadline is not an answer");

        assert!(error.contains("said nothing for"), "{error}");
        assert!(
            error.contains("Its session is still open"),
            "the person is told what is still theirs to do: {error}"
        );
        assert!(
            (IDLE..Duration::from_secs(3)).contains(&started.elapsed()),
            "not before the deadline this agent was given, and not on the ten minutes and \
             five-second tick compiled in ({:?})",
            started.elapsed()
        );
        assert!(
            agent.pending.lock().await.is_empty(),
            "a turn given up on is unfiled on the way out"
        );

        agent.shutdown().await;
    }

    #[tokio::test]
    async fn a_turn_with_room_on_its_idle_clock_still_meets_the_wall_clock() {
        // An agent can be talkative and stuck at the same time, so the idle
        // limit is given all the room in the world here and the wall clock
        // none: whichever fires, it is not the idle one.
        let watcher = Watcher::new();
        let agent =
            launched_with(&watcher, "claude", clocks(Duration::from_secs(3600), IDLE)).await;
        let session = session_on(&agent, json!([])).await;

        let started = Instant::now();
        let error = tokio::time::timeout(
            PATIENCE,
            agent.request("session/prompt", a_turn_that_waits(&session)),
        )
        .await
        .expect("the wall clock this agent was given is the one that fires")
        .expect_err("a turn past its wall clock is given up on");

        assert!(error.contains("has been at it for"), "{error}");
        assert!(
            error.contains("Its session is still open"),
            "the same sentence a person is given when a turn goes quiet: {error}"
        );
        assert!(
            (IDLE..Duration::from_secs(3)).contains(&started.elapsed()),
            "the wall clock fired where it was set, not where it was compiled ({:?})",
            started.elapsed()
        );

        agent.shutdown().await;
    }
}
