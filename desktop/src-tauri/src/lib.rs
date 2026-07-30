mod acp;

use std::sync::Arc;

use acp::{Agent, AgentState};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

/// Start the local agent. Defaults to opencode, which ships a first-party ACP
/// server; any other ACP agent works by passing a different command.
#[tauri::command]
async fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    command: Option<String>,
    args: Option<Vec<String>>,
) -> Result<Value, String> {
    let command = command.unwrap_or_else(|| "opencode".into());
    let args = args.unwrap_or_else(|| vec!["acp".into()]);

    let agent = Agent::launch(app, &command, &args).await?;
    *state.0.lock().await = Some(agent);
    Ok(json!({ "ok": true, "command": command }))
}

#[tauri::command]
async fn agent_new_session(
    state: State<'_, AgentState>,
    cwd: String,
    mcp_servers: Option<Value>,
) -> Result<Value, String> {
    let agent = current(&state).await?;
    agent
        .request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": mcp_servers.unwrap_or(json!([])) }),
        )
        .await
}

/// Send a turn. What the room knows is prepended here, not stored in the agent —
/// the memory belongs to the channel, and every session starts from it.
#[tauri::command]
async fn agent_prompt(
    state: State<'_, AgentState>,
    session_id: String,
    text: String,
    context: Option<String>,
) -> Result<Value, String> {
    let agent = current(&state).await?;
    let body = match context.filter(|c| !c.trim().is_empty()) {
        Some(c) => format!("{c}\n\n---\n\n{text}"),
        None => text,
    };
    agent
        .request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": body }] }),
        )
        .await
}

#[tauri::command]
async fn agent_stop(state: State<'_, AgentState>) -> Result<(), String> {
    if let Some(agent) = state.0.lock().await.take() {
        agent.shutdown().await;
    }
    Ok(())
}

async fn current(state: &State<'_, AgentState>) -> Result<Arc<Agent>, String> {
    state
        .0
        .lock()
        .await
        .clone()
        .ok_or_else(|| "agent is not running".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AgentState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_start,
            agent_new_session,
            agent_prompt,
            agent_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
