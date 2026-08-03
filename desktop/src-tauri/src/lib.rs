// Lints chosen for what fails silently, not for everything that exists.
//
// This crate holds the bridge to an agent running under somebody's own
// credentials. A panic here is a workspace that vanished mid-turn, not a stack
// trace in a test — so the panicking constructs are denied outside tests, where
// they are allowed deliberately: a test that cannot panic cannot fail.
#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
#![deny(
    clippy::todo,
    clippy::unimplemented,
    clippy::dbg_macro,
    clippy::print_stdout
)]

mod acp;
mod signin;
mod workspace;

use std::sync::Arc;

use acp::{auth_hint, closes_sessions, mounts_http_mcp, Agent, AgentState, Deadlines};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use workspace::{Produced, Workspaces, MAX_ARTIFACT_BYTES};

/// Start one of this person's agents, under the name they address it with.
/// Defaults to the adapter that ships with this application; any other ACP
/// agent works by passing a different command.
#[tauri::command]
async fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    name: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
) -> Result<Value, String> {
    let name = name.unwrap_or_else(|| "claude".into());
    let command = command.unwrap_or_else(|| "claude-agent-acp".into());
    let args = args.unwrap_or_default();

    let command = resolve(&app, &command);
    // The bridge takes what to emit rather than the handle itself, so its tests
    // can launch a real process without a window. This closure is the window.
    let agent = Agent::launch(&name, &command, &args, Deadlines::default(), {
        move |event: &str, payload: Value| {
            let _ = app.emit(event, payload);
        }
    })
    .await?;
    // Starting again under the same name is a restart. The process it replaces
    // is shut down here, or it lingers unaddressable with the user's session open.
    if let Some(previous) = state.insert(&name, agent).await {
        previous.shutdown().await;
    }
    Ok(json!({ "ok": true, "name": name, "command": command }))
}

/// Where an agent named by a bare command actually is.
///
/// The adapter ships with the application, so `npx` never runs: a package
/// resolved from the registry at the moment somebody opens a channel is one
/// that can change between two turns, and the name this project used to name
/// was deprecated besides (#120).
fn resolve(app: &AppHandle, command: &str) -> String {
    located(command, &places(app, command))
}

/// Everywhere a command might be, for the machine this is running on.
fn places(app: &AppHandle, command: &str) -> Vec<std::path::PathBuf> {
    candidates(
        command,
        directories(
            app.path()
                .resolve("agents/bin", tauri::path::BaseDirectory::Resource)
                .ok(),
            std::env::current_dir()
                .ok()
                .map(|dir| dir.join("../node_modules/.bin")),
            app.path().app_data_dir().ok(),
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect(),
        ),
    )
}

/// The directories a bare command is looked for in, in the order this
/// application trusts them: the bundle, then beside the source under
/// `pnpm tauri dev`, then the prefix `agent_install` fetches into — which is
/// `npm/bin` under the app data directory, because that is where
/// `npm install --prefix` leaves what it installed — and last whatever is on
/// the person's own PATH. Somebody naming an agent they already have means
/// that one, and this must not take it away from them.
fn directories(
    bundle: Option<std::path::PathBuf>,
    beside: Option<std::path::PathBuf>,
    app_data: Option<std::path::PathBuf>,
    on_path: Vec<std::path::PathBuf>,
) -> Vec<std::path::PathBuf> {
    let ours = app_data.map(|dir| dir.join("npm").join("bin"));

    [bundle, beside, ours]
        .into_iter()
        .flatten()
        .chain(on_path)
        .collect()
}

/// Where that command would be in each of them.
///
/// A command given as a path is that path and nothing else: it is the one place
/// somebody has said exactly what they mean, and looking up its last segment
/// would run something they did not name.
fn candidates(command: &str, dirs: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return vec![std::path::PathBuf::from(command)];
    }
    dirs.into_iter().map(|dir| dir.join(command)).collect()
}

/// The first of those that is really there.
fn found(places: &[std::path::PathBuf]) -> Option<String> {
    places
        .iter()
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Where the command is, or the name as it was typed — an agent this side
/// cannot find is still worth trying to spawn, and the error it gives is the
/// person's to read.
fn located(command: &str, places: &[std::path::PathBuf]) -> String {
    found(places).unwrap_or_else(|| command.to_string())
}

/// Which of these commands this machine has, and where. Null for one it does
/// not, which is the whole of what the panel needs to stop claiming an agent
/// somebody never installed is available.
#[tauri::command]
async fn agent_probe(app: AppHandle, commands: Vec<String>) -> Result<Vec<Option<String>>, String> {
    Ok(commands
        .iter()
        .map(|command| found(&places(&app, command)))
        .collect())
}

/// What an install did, in enough detail to say why it did not work.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    ok: bool,
    code: Option<i32>,
    stdout_tail: String,
    stderr_tail: String,
}

/// The end of what a command said. npm's output runs to hundreds of lines and
/// the reason is at the end of it; the banner at the start is not why it failed.
const TAIL: usize = 800;

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let start = text
        .char_indices()
        .rev()
        .take(TAIL)
        .last()
        .map_or(0, |(i, _)| i);
    text[start..].to_string()
}

/// Fetch one agent, on a press, into a directory this application owns.
///
/// The command is the catalog's and is on screen before it runs — nothing is
/// downloaded and executed as a script, and nothing is installed by an
/// application that did not say what it was about to do. It goes through the
/// shell because the prefix is an app data path, which on macOS has a space in
/// it: split on whitespace it would install two packages and neither of them
/// where they were meant to go.
#[tauri::command]
async fn agent_install(command: String) -> Result<InstallResult, String> {
    #[cfg(windows)]
    let mut shell = {
        let mut shell = tokio::process::Command::new("cmd");
        shell.args(["/C", &command]);
        shell
    };
    #[cfg(not(windows))]
    let mut shell = {
        let mut shell = tokio::process::Command::new("sh");
        shell.args(["-c", &command]);
        shell
    };

    let out = shell
        .output()
        .await
        .map_err(|e| format!("cannot run `{command}`: {e}"))?;

    Ok(InstallResult {
        ok: out.status.success(),
        code: out.status.code(),
        stdout_tail: tail(&out.stdout),
        stderr_tail: tail(&out.stderr),
    })
}

/// Open the working directory for this session and remember what was in it.
/// The path is derived from who is working, with which agent, in which channel —
/// the agent never names its own directory.
#[tauri::command]
async fn agent_workspace(
    app: AppHandle,
    shots: State<'_, Workspaces>,
    user: String,
    name: String,
    channel: String,
) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("workspaces");

    let dir = workspace::workspace_path(&root, &user, &name, &channel);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    shots
        .0
        .lock()
        .map_err(|_| "workspace state is poisoned".to_string())?
        .insert(dir.clone(), workspace::snapshot(&dir));

    Ok(dir.to_string_lossy().into_owned())
}

/// What this run wrote or changed, offered rather than uploaded — what leaves
/// the machine stays the person's decision (Article D3 does not override P2).
#[tauri::command]
async fn agent_produced(
    shots: State<'_, Workspaces>,
    workspace: String,
) -> Result<Vec<Produced>, String> {
    let dir = std::path::PathBuf::from(&workspace);

    // A folder somebody bound is their real work, and git already knows what
    // changed in it — by their ignore rules, not ours.
    if let Some(changed) = workspace::git_changes(&dir) {
        return Ok(changed
            .into_iter()
            .filter_map(|path| {
                let bytes = std::fs::metadata(dir.join(&path)).ok()?.len();
                (bytes <= MAX_ARTIFACT_BYTES).then_some(Produced { path, bytes })
            })
            .collect());
    }

    let after = workspace::snapshot(&dir);

    let mut state = shots
        .0
        .lock()
        .map_err(|_| "workspace state is poisoned".to_string())?;
    let before = state.get(&dir).cloned().unwrap_or_default();

    let files = workspace::produced(&before, &after)
        .into_iter()
        .filter_map(|rel| {
            let bytes = after.get(&rel).map(|(size, _)| *size).unwrap_or(0);
            (bytes <= MAX_ARTIFACT_BYTES).then(|| Produced {
                path: rel.to_string_lossy().into_owned(),
                bytes,
            })
        })
        .collect();

    // The next turn is measured from here, so one file is not offered twice.
    state.insert(dir, after);
    Ok(files)
}

/// Read one produced file, as base64 — a work product is not always text.
#[tauri::command]
async fn agent_read(workspace: String, path: String) -> Result<String, String> {
    let dir = std::path::PathBuf::from(&workspace)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let file = dir.join(&path).canonicalize().map_err(|e| e.to_string())?;
    // A path that resolves outside its own workspace is not this session's to read.
    if !file.starts_with(&dir) {
        return Err(format!("{path} is outside the workspace"));
    }

    let bytes = std::fs::read(&file).map_err(|e| format!("cannot read {path}: {e}"))?;
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(format!("{path} is too large to attach"));
    }
    Ok(BASE64.encode(bytes))
}

/// Sign in through the person's own browser.
///
/// The listener is opened *before* the browser, or the provider could come back
/// to a port nothing is holding. What comes back is the bearer token this client
/// already carries — no token of the provider's reaches this process.
#[tauri::command]
async fn sign_in_with_provider(app: AppHandle, server: String) -> Result<String, String> {
    let listener = signin::Listener::open().map_err(|e| format!("cannot listen: {e}"))?;
    let port = listener.port();
    let state = signin::nonce(port);

    let url = format!(
        "{}/auth/openid_connect?return_port={port}&state={state}",
        server.trim_end_matches('/')
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("cannot open a browser: {e}"))?;

    let expected = state.clone();
    tokio::task::spawn_blocking(move || {
        listener.wait(std::time::Duration::from_secs(180), Some(&expected))
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|callback| callback.token)
    .ok_or_else(|| "sign-in was not completed".to_string())
}

/// Answer something the agent asked — a tool it wants to run, and is waiting on.
#[tauri::command]
async fn agent_permit(
    state: State<'_, AgentState>,
    name: Option<String>,
    // The id as the agent sent it. Coercing it to a number here is how a string
    // id became a question nobody answered (#96) — the agent is blocked on that
    // exact token, not on our reading of it.
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    let agent = running(&state, name).await?;
    let outcome = match option_id {
        Some(id) => json!({ "outcome": "selected", "optionId": id }),
        None => json!({ "outcome": "cancelled" }),
    };
    agent
        .answer(&request_id, json!({ "outcome": outcome }))
        .await
}

/// Close one session, when the agent says it can. Killing the process is not the
/// same act: a session left open holds its rail registered as an MCP server and
/// leaves a row in the agent's own storage, for as long as that agent lives.
///
/// Returns whether it was closed, so a caller can tell "this agent does not do
/// that" from "it did". An agent that does not advertise `close` gets what
/// happened before this existed, which is nothing.
#[tauri::command]
async fn agent_close_session(
    state: State<'_, AgentState>,
    name: Option<String>,
    session_id: String,
) -> Result<bool, String> {
    let agent = running(&state, name).await?;
    if !closes_sessions(&agent.handshake().await) {
        return Ok(false);
    }

    agent
        .request("session/close", json!({ "sessionId": session_id }))
        .await?;
    Ok(true)
}

/// Ask the agent to give up the turn it is on. The person's to ask for: a run
/// that stops without anybody asking is as surprising as one that never stops.
///
/// A notification, so there is nothing to wait for. The turn ends as a failure
/// with its steps intact and the session stays open — the difference between
/// this and stopping the agent, which takes every other channel's turn with it.
#[tauri::command]
async fn agent_cancel(
    state: State<'_, AgentState>,
    name: Option<String>,
    session_id: String,
) -> Result<(), String> {
    running(&state, name).await?.cancel(&session_id).await
}

/// Which of this person's agents are running — asked of the processes, not of
/// the bookkeeping. An agent whose reader has run out of stdout is a process
/// that is gone, and it is forgotten here rather than hidden: pressing Start
/// again is a fresh process, not a second one nobody can address (#174).
#[tauri::command]
async fn agent_list(state: State<'_, AgentState>) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for name in state.names().await {
        match state.get(&name).await {
            Some(agent) if agent.alive() => names.push(name),
            Some(_) => {
                state.take(&name).await;
            }
            None => {}
        }
    }
    Ok(names)
}

/// The rail is the only way what a room knows reaches an agent. An agent that
/// cannot mount an HTTP MCP server accepts the session, ignores the entry it
/// cannot use, and answers the turn from nothing — which reads as a bad model
/// rather than as a client that never checked (#94).
///
/// Nothing to mount is nothing to check: a session opened without a rail is a
/// session that was not promised one.
async fn rail_would_reach(
    agent: &Arc<Agent>,
    name: &Option<String>,
    mcp_servers: &Value,
) -> Result<(), String> {
    let nothing_to_mount = mcp_servers.as_array().is_none_or(|s| s.is_empty());
    if nothing_to_mount || mounts_http_mcp(&agent.handshake().await) {
        return Ok(());
    }

    let who = name.clone().unwrap_or_else(|| "this agent".into());
    Err(format!(
        "{who} does not report that it can mount an HTTP MCP server, so the capability rail \
         would not reach it. A session opened anyway would answer from nothing rather than \
         from what this room knows."
    ))
}

/// Whatever went wrong, plus the one actionable thing the agent said at the
/// handshake. A logged-out agent answers `session/new` with an internal error
/// and puts the instruction in `authMethods`, where nobody was looking.
async fn with_auth_hint(agent: &Arc<Agent>, error: String) -> String {
    match auth_hint(&agent.handshake().await) {
        Some(hint) => format!("{error} — this agent offers: {hint}"),
        None => error,
    }
}

/// Pick up a session the agent still has. Its failure is not an error: a session
/// the agent has forgotten, or an agent that cannot load one, simply means a new
/// session — which is what happened before this existed.
#[tauri::command]
async fn agent_load_session(
    state: State<'_, AgentState>,
    name: Option<String>,
    session_id: String,
    cwd: String,
    mcp_servers: Option<Value>,
) -> Result<Value, String> {
    let agent = running(&state, name.clone()).await?;
    let mcp_servers = mcp_servers.unwrap_or(json!([]));
    rail_would_reach(&agent, &name, &mcp_servers).await?;

    agent
        .request(
            "session/load",
            json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers }),
        )
        .await
}

#[tauri::command]
async fn agent_new_session(
    state: State<'_, AgentState>,
    name: Option<String>,
    cwd: String,
    mcp_servers: Option<Value>,
) -> Result<Value, String> {
    let agent = running(&state, name.clone()).await?;
    let mcp_servers = mcp_servers.unwrap_or(json!([]));
    rail_would_reach(&agent, &name, &mcp_servers).await?;

    match agent
        .request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": mcp_servers }),
        )
        .await
    {
        Ok(result) => Ok(result),
        Err(error) => Err(with_auth_hint(&agent, error).await),
    }
}

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

/// Send a turn. What the room knows, and what was just said in it, are prepended
/// here rather than stored in the agent — both belong to the channel, and every
/// session starts from them.
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.manage(AgentState::default());
            app.manage(Workspaces::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sign_in_with_provider,
            agent_start,
            agent_probe,
            agent_install,
            agent_permit,
            agent_list,
            agent_workspace,
            agent_produced,
            agent_read,
            agent_new_session,
            agent_load_session,
            agent_prompt,
            agent_set_config,
            agent_export_session,
            agent_close_session,
            agent_cancel,
            agent_stop
        ])
        .run(tauri::generate_context!())
        // A panic here is a backtrace where a person needed a sentence: there is
        // no window yet, so this is the only chance to say anything at all.
        .unwrap_or_else(|error| {
            eprintln!("WorkRoom could not start: {error}");
            std::process::exit(1);
        });
}

#[cfg(test)]
mod resolution {
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-resolve-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn binary(dir: &Path, command: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(command);
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        path
    }

    /// Where `npm install --prefix <data>/npm` leaves what it fetched.
    fn installed_in(data: &Path) -> PathBuf {
        data.join("npm").join("bin")
    }

    /// A machine, as this side is given one: what the bundle holds, what sits
    /// beside the source, the app data directory, and the person's own PATH.
    /// Everything below goes through the same chain the running application
    /// builds — a test that hands `found` a list it ordered itself asserts only
    /// that the list it wrote is in the order it wrote it.
    fn chain(
        command: &str,
        bundle: Option<&Path>,
        data: Option<&Path>,
        on_path: Vec<PathBuf>,
    ) -> Vec<PathBuf> {
        candidates(
            command,
            directories(
                bundle.map(Path::to_path_buf),
                None,
                data.map(Path::to_path_buf),
                on_path,
            ),
        )
    }

    #[test]
    fn our_own_prefix_is_looked_in_after_the_bundle_and_before_the_path() {
        // The one directory this card adds, pinned by where it is and where it
        // sits. `npm install --prefix P` puts its binaries in `P/bin`, so
        // anything else here is a directory nothing will ever be found in.
        let dirs = directories(
            Some(PathBuf::from("/bundle/agents/bin")),
            None,
            Some(PathBuf::from("/data")),
            vec![PathBuf::from("/usr/local/bin")],
        );

        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/bundle/agents/bin"),
                PathBuf::from("/data/npm/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn the_adapter_in_the_bundle_wins_over_one_somebody_installed() {
        // It ships with this application and is the version this client was
        // tested against. An install into our own prefix is a fallback, not a
        // replacement for what came in the bundle.
        let bundle = temp("bundle");
        let data = temp("data");
        let shipped = binary(&bundle, "claude-agent-acp");
        binary(&installed_in(&data), "claude-agent-acp");

        assert_eq!(
            found(&chain(
                "claude-agent-acp",
                Some(&bundle),
                Some(&data),
                vec![]
            )),
            Some(shipped.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn an_agent_in_our_own_prefix_is_found_though_it_is_not_on_path() {
        // What `agent_install` fetches goes into a directory this application
        // owns and nothing else on the machine knows about. Not looking there
        // means an agent somebody just installed still reads as missing.
        let bundle = temp("empty-bundle");
        let data = temp("own-data");
        let elsewhere = temp("their-path");
        let installed = binary(&installed_in(&data), "opencode");

        assert_eq!(
            found(&chain(
                "opencode",
                Some(&bundle),
                Some(&data),
                vec![elsewhere]
            )),
            Some(installed.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn an_agent_the_person_already_has_is_theirs_and_not_ours() {
        // Last in the chain, and it must still be reached: somebody who has
        // opencode on their PATH is not offered an install for it.
        let data = temp("no-installs");
        let theirs = temp("on-their-path");
        let already = binary(&theirs, "opencode");

        assert_eq!(
            found(&chain("opencode", None, Some(&data), vec![theirs])),
            Some(already.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn a_command_nobody_has_is_left_as_it_was_typed() {
        // A person naming their own agent means the one they have, and this
        // must not take that away from them by answering for it.
        let data = temp("nothing-installed");
        let nowhere = temp("nowhere");
        let looked = chain("kimi-acp", None, Some(&data), vec![nowhere]);

        assert_eq!(found(&looked), None);
        assert_eq!(located("kimi-acp", &looked), "kimi-acp");
    }

    #[test]
    fn a_command_given_as_a_path_is_that_path_and_nothing_else() {
        // The one place somebody has said exactly what they mean. Looking for
        // its last segment in our own prefix would run something else entirely.
        let elsewhere = temp("elsewhere");
        let named = binary(&elsewhere, "opencode");

        assert_eq!(
            candidates(&named.to_string_lossy(), vec![temp("ignored")]),
            vec![named]
        );
    }

    #[test]
    fn a_failed_install_is_reported_with_the_end_of_what_it_said() {
        // npm's output runs to hundreds of lines and the reason is at the end
        // of it. Keeping the start reports the banner and drops the cause.
        let noise = "x".repeat(TAIL * 2);
        let said = format!("{noise}\nE404 Not Found - GET https://registry.npmjs.org/nope\n");

        let end = tail(said.as_bytes());
        assert!(end.ends_with("E404 Not Found - GET https://registry.npmjs.org/nope"));
        assert!(end.chars().count() <= TAIL);
    }

    #[test]
    fn what_an_install_said_is_not_cut_through_a_character() {
        let said = "é".repeat(TAIL * 2);

        assert!(tail(said.as_bytes()).ends_with('é'));
    }
}

#[cfg(test)]
mod capabilities {
    /// What this application is allowed to do, and why each one is here.
    ///
    /// A permission added by accident is not a compile error, and this file grew
    /// four times in a single day. Adding a seventh means editing this list,
    /// which is the point: it turns a quiet grant into a line somebody has to
    /// write a reason next to.
    const GRANTED: &[(&str, &str)] = &[
        ("core:default", "the baseline every window needs"),
        (
            "opener:default",
            "open the browser for sign-in through a provider",
        ),
        (
            "dialog:allow-open",
            "the folder picker, when a channel is bound to one",
        ),
        (
            "updater:default",
            "check for a newer release and install when asked",
        ),
        (
            "core:app:allow-version",
            "read our own version, to notice drift from the workspace",
        ),
        (
            "process:allow-restart",
            "restart after an update the person accepted",
        ),
    ];

    #[test]
    fn the_app_is_allowed_exactly_what_it_asks_for() {
        let file =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();

        let mut granted: Vec<String> = json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect();
        let mut expected: Vec<String> = GRANTED.iter().map(|(p, _)| p.to_string()).collect();
        granted.sort();
        expected.sort();

        assert_eq!(
            granted, expected,
            "a permission changed. Add it to GRANTED with a reason, or take it out of the capability file"
        );
    }
}

/// What the agents panel is told, asked the way it asks (#174).
///
/// `agent_list` takes a Tauri `State`, so it is driven here on the mock
/// runtime: a helper that prunes and a command that still asks for every name
/// the registry holds is green everywhere except in front of a person.
#[cfg(test)]
mod the_agents_panel {
    use super::*;
    use std::time::{Duration, Instant};

    async fn launched(name: &str) -> Arc<Agent> {
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-agent/agent.mjs");
        Agent::launch(
            name,
            "node",
            &[script.to_string_lossy().into_owned()],
            // The clocks a person's agent is really given: nothing here waits
            // on one, and a panel measured against a test's clock is a panel
            // nobody has seen.
            acp::Deadlines::default(),
            // Nothing is listening in a test either; what these agents emit is
            // asserted where the bridge is, not here.
            |_event: &str, _payload: Value| {},
        )
        .await
        .expect("node and the scripted agent are required to speak the protocol")
    }

    #[tokio::test]
    async fn an_agent_whose_process_died_is_not_offered_as_running() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock runtime stands in for a window");
        app.manage(AgentState::default());
        let state = || app.state::<AgentState>();

        let claude = launched("claude").await;
        let opencode = launched("opencode").await;
        state().insert("claude", claude.clone()).await;
        state().insert("opencode", opencode.clone()).await;
        assert_eq!(
            agent_list(state()).await.unwrap(),
            vec!["claude", "opencode"],
            "both are running, and both are offered"
        );

        // The process dies from outside — a crash, not this client's own stop —
        // so the only thing that can tell the panel is the reader noticing.
        let pid = claude.pid().await.expect("a live agent has a pid");
        let killed = tokio::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .await
            .expect("kill must be runnable");
        assert!(killed.success(), "the process must be there to die");

        // Asked until it settles, because the process dying and this side
        // noticing are two different moments.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut listed = agent_list(state()).await.unwrap();
        while listed != vec!["opencode"] && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
            listed = agent_list(state()).await.unwrap();
        }

        assert_eq!(
            listed,
            vec!["opencode"],
            "a process that is gone is not an agent to hand a turn to"
        );
        assert!(
            state().get("claude").await.is_none(),
            "and it is forgotten rather than hidden — pressing Start is a fresh process, not a \
             second one nobody can address"
        );

        opencode.shutdown().await;
    }
}
