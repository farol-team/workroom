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

/// Send a turn. What the room knows, and what was just said in it, are prepended
/// here rather than stored in the agent — both belong to the channel, and every
/// session starts from them.
#[tauri::command]
async fn agent_prompt(
    state: State<'_, AgentState>,
    session_id: String,
    text: String,
    context: Option<String>,
    history: Option<String>,
) -> Result<Value, String> {
    let agent = current(&state).await?;
    let mut body = String::new();
    for block in [ context, history ].into_iter().flatten() {
        if !block.trim().is_empty() {
            body.push_str(block.trim());
            body.push_str("\n\n---\n\n");
        }
    }
    body.push_str(&text);
    agent
        .request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": body }] }),
        )
        .await
}

/// Ask the agent for its own record of a session.
///
/// Invoked as the agent's published command, not by reading its storage — the
/// storage is an implementation detail and the command is an interface. Returns
/// null when the configured agent has no exporter, so the feature is simply
/// absent rather than broken.
#[tauri::command]
async fn agent_export_session(
    command: Option<String>,
    session_id: String,
) -> Result<Option<String>, String> {
    let command = command.unwrap_or_else(|| "opencode".into());

    let out = tokio::process::Command::new(&command)
        .args([ "export", &session_id ])
        .output()
        .await
        .map_err(|e| format!("cannot run `{command} export`: {e}"))?;

    if !out.status.success() {
        return Ok(None);
    }
    let body = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if body.is_empty() { None } else { Some(body) })
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
            agent_export_session,
            agent_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
