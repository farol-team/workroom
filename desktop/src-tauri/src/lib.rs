mod acp;

use std::sync::Arc;

use acp::{Agent, AgentState};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

/// Start one of this person's agents, under the name they address it with.
/// Defaults to opencode, which ships a first-party ACP server; any other ACP
/// agent works by passing a different command.
#[tauri::command]
async fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    name: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
) -> Result<Value, String> {
    let name = name.unwrap_or_else(|| "opencode".into());
    let command = command.unwrap_or_else(|| "opencode".into());
    let args = args.unwrap_or_else(|| vec!["acp".into()]);

    let agent = Agent::launch(app, &command, &args).await?;
    // Starting again under the same name is a restart. The process it replaces
    // is shut down here, or it lingers unaddressable with the user's session open.
    if let Some(previous) = state.insert(&name, agent).await {
        previous.shutdown().await;
    }
    Ok(json!({ "ok": true, "name": name, "command": command }))
}

/// Which of this person's agents are running.
#[tauri::command]
async fn agent_list(state: State<'_, AgentState>) -> Result<Vec<String>, String> {
    Ok(state.names().await)
}

#[tauri::command]
async fn agent_new_session(
    state: State<'_, AgentState>,
    name: Option<String>,
    cwd: String,
    mcp_servers: Option<Value>,
) -> Result<Value, String> {
    let agent = running(&state, name).await?;
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
/// Change one of the session's options — the model, the mode, whatever the
/// agent offers. Returns the full updated list, which is what the agent sends
/// back, so the client never has to guess what took effect.
#[tauri::command]
async fn agent_set_config(
    state: State<'_, AgentState>,
    name: Option<String>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let agent = running(&state, name).await?;
    agent
        .request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
        )
        .await
}

#[tauri::command]
async fn agent_prompt(
    state: State<'_, AgentState>,
    name: Option<String>,
    session_id: String,
    text: String,
    context: Option<String>,
    history: Option<String>,
) -> Result<Value, String> {
    let agent = running(&state, name).await?;
    let mut body = String::new();
    for block in [context, history].into_iter().flatten() {
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
        .args(["export", &session_id])
        .output()
        .await
        .map_err(|e| format!("cannot run `{command} export`: {e}"))?;

    if !out.status.success() {
        return Ok(None);
    }
    let body = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if body.is_empty() { None } else { Some(body) })
}

/// Stop one agent, or every agent when no name is given.
#[tauri::command]
async fn agent_stop(state: State<'_, AgentState>, name: Option<String>) -> Result<(), String> {
    match name {
        Some(name) => {
            if let Some(agent) = state.take(&name).await {
                agent.shutdown().await;
            }
        }
        None => {
            for agent in state.drain().await {
                agent.shutdown().await;
            }
        }
    }
    Ok(())
}

/// The named agent, or the only one running when the caller did not say. A
/// person with one agent should not have to name it.
async fn running(
    state: &State<'_, AgentState>,
    name: Option<String>,
) -> Result<Arc<Agent>, String> {
    let name = match name {
        Some(name) => name,
        None => match state.names().await.as_slice() {
            [only] => only.clone(),
            [] => return Err("no agent is running".into()),
            many => return Err(format!("say which agent: {}", many.join(", "))),
        },
    };
    state
        .get(&name)
        .await
        .ok_or_else(|| format!("`{name}` is not running"))
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
            agent_list,
            agent_new_session,
            agent_prompt,
            agent_set_config,
            agent_export_session,
            agent_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
