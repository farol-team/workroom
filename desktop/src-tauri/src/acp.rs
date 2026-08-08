//! The agents a person is running, and what each of them is holding.
//!
//! Speaking ACP is not this application's job any more: the client, the
//! process-group bookkeeping and the agent catalogue live in `acp-client` /
//! `acp-agents`, shared with the other products that reach a local agent the
//! same way, together with the tests that pin every lesson this bridge learned
//! the hard way — string ids, a replay that is not news, a timed-out turn's
//! tail, the handshake being the only place a capability is stated.
//!
//! What is here is the bookkeeping a *window* needs: agents by the name a
//! person addresses them with, the sessions each one is holding, and the
//! questions waiting for somebody to answer.

use std::collections::HashMap;
use std::sync::Arc;

use acp_client::{Agent, Config, Event, EventKind, PermissionRequest, Session};
use serde_json::{json, Value};
use tokio::sync::Mutex;

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

pub type AgentState = Registry<Arc<Running>>;

/// One agent process, the sessions it is holding, and the questions it is
/// blocked on.
pub struct Running {
    agent: Arc<Agent>,
    /// One per conversation. Kept here rather than in the window, because the
    /// window can be closed and reopened while the agent goes on working.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Questions the agent is waiting on, by the id its answer must quote.
    /// Nothing is answered from here — a person answers, through the interface.
    asked: Mutex<HashMap<String, PermissionRequest>>,
}

impl Running {
    /// Start the agent and forward everything it says to the window.
    ///
    /// Takes what to emit rather than an `AppHandle`, because a window is the
    /// one thing a cargo test cannot have.
    pub async fn launch(
        name: &str,
        command: &str,
        args: &[String],
        emit: impl Fn(&str, Value) + Send + 'static,
    ) -> Result<Arc<Self>, String> {
        let (events, inbox) = tokio::sync::mpsc::channel::<Event>(256);
        let agent = Agent::launch(
            Config::new(command)
                .args(args.to_vec())
                .client("workroom", env!("CARGO_PKG_VERSION")),
            events,
        )
        .await
        .map_err(|e| e.to_string())?;

        let running = Arc::new(Self {
            agent,
            sessions: Mutex::new(HashMap::new()),
            asked: Mutex::new(HashMap::new()),
        });
        tokio::spawn(forward(inbox, running.clone(), name.to_string(), emit));
        Ok(running)
    }

    pub fn agent(&self) -> &Arc<Agent> {
        &self.agent
    }

    pub fn alive(&self) -> bool {
        self.agent.alive()
    }

    pub async fn remember(&self, session: Session) -> Arc<Session> {
        let session = Arc::new(session);
        self.sessions
            .lock()
            .await
            .insert(session.id().to_string(), session.clone());
        session
    }

    /// The session behind an id the window is holding. `None` is a session
    /// this agent never opened or has since dropped, which is a message worth
    /// giving back rather than a panic.
    pub async fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("this agent is not holding session {id}"))
    }

    pub async fn forget(&self, id: &str) {
        self.sessions.lock().await.remove(id);
    }

    /// A person's answer to something the agent asked. No option id means they
    /// declined to choose, which the protocol calls cancelled.
    pub async fn answer(
        &self,
        request_id: &Value,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let key = acp_client::wire::id_key(request_id);
        let request = self
            .asked
            .lock()
            .await
            .remove(&key)
            // Answering twice is not an error worth showing anybody, but
            // answering something nobody asked is: the agent is blocked on a
            // request this bridge no longer has.
            .ok_or_else(|| format!("no question is waiting under {key}"))?;

        match option_id {
            Some(id) => request.answer(&id).await,
            None => request.cancel().await,
        }
        .map_err(|e| e.to_string())
    }

    pub fn shutdown(&self) {
        self.agent.stop();
    }
}

/// Everything the agent says, on its way to the window.
///
/// One stream, tagged by kind and by session: registering a listener per turn
/// meant every turn heard every session, and a permission dialog for one agent
/// was shown as though another had asked.
async fn forward(
    mut inbox: tokio::sync::mpsc::Receiver<Event>,
    running: Arc<Running>,
    name: String,
    emit: impl Fn(&str, Value),
) {
    while let Some(event) = inbox.recv().await {
        let payload = with_agent(event.to_json(), &name);
        // A question is parked before it is announced, or an answer could
        // arrive for something this bridge has not filed yet.
        if let EventKind::Permission(request) = event.kind {
            let key = acp_client::wire::id_key(&request.id);
            running.asked.lock().await.insert(key, request);
        }
        emit("acp://event", payload);
    }
}

/// Which agent said it. One window can be running several, and "an agent
/// stopped" is not something a person can act on when three are up.
fn with_agent(mut payload: Value, name: &str) -> Value {
    match payload.as_object_mut() {
        Some(map) => {
            map.insert("agent".into(), json!(name));
            payload
        }
        None => json!({ "agent": name, "event": payload }),
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

    /// Which agent an event came from, so a window running three of them can
    /// say which one stopped.
    #[test]
    fn an_event_carries_the_name_it_was_started_under() {
        let payload = with_agent(json!({ "kind": "closed", "diagnostics": [] }), "claude");
        assert_eq!(payload["agent"], "claude");
        assert_eq!(payload["kind"], "closed");
    }
}
