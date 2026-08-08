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

use acp::{AgentState, Running};
use acp_agents::path::{candidates, directories, found, located, path_env, user_path};
use acp_client::SessionOpts;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use workspace::{MirrorFile, TurnProduced, Workspaces, MAX_ARTIFACT_BYTES};

/// Start one of this person's agents, under the name they address it with.
/// Defaults to the adapter `@agent` means when nobody has said otherwise; any
/// other ACP agent works by passing a different command.
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
    let agent = Running::launch(&name, &command, &args, {
        move |event: &str, payload: Value| {
            let _ = app.emit(event, payload);
        }
    })
    .await?;
    // Starting again under the same name is a restart. The process it replaces
    // is shut down here, or it lingers unaddressable with the user's session open.
    if let Some(previous) = state.insert(&name, agent).await {
        previous.shutdown();
    }
    Ok(json!({ "ok": true, "name": name, "command": command }))
}

/// Where an agent named by a bare command actually is.
///
/// Nothing is ever fetched here: an agent arrives by `agent_install`, on a
/// press, before any of this runs. A package resolved from the registry at the
/// moment somebody opens a channel is one that can change between two turns —
/// which is why `npx` appears nowhere in this application (#120).
fn resolve(app: &AppHandle, command: &str) -> String {
    located(command, &places(app, command))
        .to_string_lossy()
        .into_owned()
}

/// Everywhere a command might be, for the machine this is running on.
fn places(app: &AppHandle, command: &str) -> Vec<std::path::PathBuf> {
    candidates(command, directories(app.path().app_data_dir().ok()))
}

/// Which of these commands this machine has, and where. Null for one it does
/// not, which is the whole of what the panel needs to stop claiming an agent
/// somebody never installed is available.
#[tauri::command]
async fn agent_probe(app: AppHandle, commands: Vec<String>) -> Result<Vec<Option<String>>, String> {
    Ok(commands
        .iter()
        .map(|command| {
            found(&places(&app, command)).map(|path| path.to_string_lossy().into_owned())
        })
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

    // `sh -c` reads no profile, and a packaged application was handed no
    // useful PATH to begin with — so `npm` is not found on a machine where it
    // answers in a terminal. The person's own directories are what this runs
    // with (#240).
    shell.env("PATH", path_env(user_path()));

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
/// The path is derived from the workspace and the channel — the agent never
/// names its own directory. The root is `~/WorkRoom`: where an agent spends
/// its days is work, and work should be visible in Finder, not hidden in
/// app-data like a cache — and it stays out of iCloud's Documents domain,
/// whose file eviction would corrupt an agent's working tree (#201).
///
/// Everything here reads a disk, so it happens on the blocking pool. An async
/// command that walks a directory inline holds a runtime worker for as long as
/// the walk takes, and on somebody's real repository that is the whole bridge
/// answering nothing, mid-turn, for a directory listing (#179).
#[tauri::command]
async fn agent_workspace(
    app: AppHandle,
    workspace: String,
    channel: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let root = app
            .path()
            .home_dir()
            .map_err(|e| format!("no home directory: {e}"))?
            .join("WorkRoom");

        let dir = workspace::workspace_path(&root, &workspace, &channel);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

        workspace::baseline(&app.state::<Workspaces>(), &dir)?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("opening the workspace did not finish: {e}"))?
}

/// What this run wrote or changed, offered rather than uploaded — what leaves
/// the machine stays the person's decision (Article D3 does not override P2).
///
/// The walk and the `git status` are the slow part and belong off the runtime;
/// which files those are, and where the line between turns now sits, is
/// `workspace::offer`'s to decide.
#[tauri::command]
async fn agent_produced(app: AppHandle, workspace: String) -> Result<TurnProduced, String> {
    tokio::task::spawn_blocking(move || {
        workspace::offer(&app.state::<Workspaces>(), std::path::Path::new(&workspace))
    })
    .await
    .map_err(|e| format!("looking at the workspace did not finish: {e}"))?
}

/// Mark where a turn begins. Everything the offer says about the run is
/// measured from here — what was already dirty is the person's, and only
/// the delta is the run's (#202).
#[tauri::command]
async fn agent_turn_start(app: AppHandle, workspace: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        workspace::turn_start(&app.state::<Workspaces>(), std::path::Path::new(&workspace))
    })
    .await
    .map_err(|e| format!("marking the turn's start did not finish: {e}"))?
}

/// What a folder's repository would mean for an agent about to work in it —
/// read when the person picks the folder, so the warning that a merge ships
/// something arrives before the agent does (#203). The reading is `git` and a
/// directory listing, and belongs off the runtime like every other walk.
#[tauri::command]
async fn agent_repo_info(path: String) -> Result<workspace::RepoInfo, String> {
    tokio::task::spawn_blocking(move || workspace::repo_info(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("looking at the repository did not finish: {e}"))
}

/// Clone the room's repository into the folder the room works in. The url is
/// the room's own setting and the directory is derived — like every session
/// working directory, it is never the agent's to name (#201).
#[tauri::command]
async fn agent_clone(url: String, dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        workspace::clone_repository(&url, std::path::Path::new(&dir))
    })
    .await
    .map_err(|e| format!("cloning did not finish: {e}"))?
}

/// Where the channel would work, answered *without* making it (#204).
/// `agent_workspace` creates on sight, which is right when a session is about
/// to start and wrong here: provisioning is only deciding what to do, and a
/// decision that creates the folder would make every later answer — empty?
/// missing? — a question about a directory we just made ourselves.
#[tauri::command]
async fn agent_derived_path(
    app: AppHandle,
    workspace: String,
    channel: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let root = app
            .path()
            .home_dir()
            .map_err(|e| format!("no home directory: {e}"))?
            .join("WorkRoom");
        Ok(workspace::workspace_path(&root, &workspace, &channel)
            .to_string_lossy()
            .into_owned())
    })
    .await
    .map_err(|e| format!("deriving the path did not finish: {e}"))?
}

/// What the channel's folder currently is — there or not, empty or not, and
/// which repository when it is one (#204). Read-only by construction: the
/// answer decides between cloning, leaving alone, and warning, and every one
/// of those needs the folder as it actually is.
#[tauri::command]
async fn agent_folder_state(dir: String) -> Result<workspace::FolderState, String> {
    tokio::task::spawn_blocking(move || workspace::folder_state(std::path::Path::new(&dir)))
        .await
        .map_err(|e| format!("looking at the folder did not finish: {e}"))
}

/// Work in the folder that no run did (#207). Read-only: the line is the
/// turn's to move, and the gate that asks this question asks it again on
/// every focus, every open and every turn's end.
#[tauri::command]
async fn agent_human_changes(
    app: AppHandle,
    dir: String,
) -> Result<workspace::HumanChanges, String> {
    tokio::task::spawn_blocking(move || {
        workspace::human_changes(&app.state::<Workspaces>(), std::path::Path::new(&dir))
    })
    .await
    .map_err(|e| format!("reading the folder did not finish: {e}"))?
}

/// Set the person's unreviewed work aside so a run can start from a clean
/// tree (#207). The button says how to bring it back; git keeps it.
#[tauri::command]
async fn agent_stash(dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || workspace::stash(std::path::Path::new(&dir)))
        .await
        .map_err(|e| format!("stashing did not finish: {e}"))?
}

/// A plain folder becomes a repository when the person says so (#207).
/// Idempotent, and deliberately remote-less.
#[tauri::command]
async fn agent_git_init(dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || workspace::git_init(std::path::Path::new(&dir)))
        .await
        .map_err(|e| format!("init did not finish: {e}"))?
}

/// One file's changes, for the review dialog (#207). The dialog asks one row
/// at a time, as the person expands them.
#[tauri::command]
async fn agent_file_diff(dir: String, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || workspace::file_diff(std::path::Path::new(&dir), &path))
        .await
        .map_err(|e| format!("reading the diff did not finish: {e}"))?
}

/// The reviewed changes, committed as the machine's own git identity (#207).
/// No configuration is written here: if git cannot name the author, its own
/// error is the dialog's to show.
#[tauri::command]
async fn agent_commit(dir: String, paths: Vec<String>, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        workspace::commit(std::path::Path::new(&dir), &paths, &message)
    })
    .await
    .map_err(|e| format!("committing did not finish: {e}"))?
}

/// Read one produced file, as base64 — a work product is not always text.
#[tauri::command]
async fn agent_read(workspace: String, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("reading the file did not finish: {e}"))?
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
    running(&state, name)
        .await?
        .answer(&request_id, option_id)
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
    let closes = agent.agent().handshake().closes_sessions();
    let closed = agent
        .session(&session_id)
        .await?
        .close(closes)
        .await
        .map_err(|e| e.to_string())?;
    agent.forget(&session_id).await;
    Ok(closed)
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
    running(&state, name)
        .await?
        .session(&session_id)
        .await?
        .cancel()
        .await
        .map_err(|e| e.to_string())
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
fn rail_would_reach(
    agent: &Arc<Running>,
    name: &Option<String>,
    mcp_servers: &[Value],
) -> Result<(), String> {
    if mcp_servers.is_empty() || agent.agent().handshake().mounts_http_mcp() {
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
fn with_auth_hint(agent: &Arc<Running>, error: String) -> String {
    match agent.agent().handshake().auth_hint() {
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
    mcp_servers: Option<Vec<Value>>,
    // Whether the history the agent replays is wanted. It is not, for a resume
    // — the room already shows it — and it is the whole point when a
    // transcript is being taken (#124).
    replay: Option<bool>,
) -> Result<Value, String> {
    let agent = running(&state, name.clone()).await?;
    let mcp_servers = mcp_servers.unwrap_or_default();
    rail_would_reach(&agent, &name, &mcp_servers)?;

    let mut opts = SessionOpts::default().cwd(&cwd);
    opts.mcp_servers = mcp_servers;
    if replay.unwrap_or(false) {
        opts = opts.replaying();
    }
    let session = agent
        .agent()
        .load_session(&session_id, opts)
        .await
        .map_err(|e| with_auth_hint(&agent, e.to_string()))?;
    let options = session.options().await;
    agent.remember(session).await;
    Ok(json!({
        "sessionId": session_id,
        "configOptions": options.iter().map(|o| o.to_json()).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn agent_new_session(
    state: State<'_, AgentState>,
    name: Option<String>,
    cwd: String,
    mcp_servers: Option<Vec<Value>>,
) -> Result<Value, String> {
    let agent = running(&state, name.clone()).await?;
    let mcp_servers = mcp_servers.unwrap_or_default();
    rail_would_reach(&agent, &name, &mcp_servers)?;

    let mut opts = SessionOpts::default().cwd(&cwd);
    opts.mcp_servers = mcp_servers;
    let session = agent
        .agent()
        .new_session(opts)
        .await
        .map_err(|e| with_auth_hint(&agent, e.to_string()))?;
    let id = session.id().to_string();
    let options = session.options().await;
    agent.remember(session).await;
    Ok(json!({
        "sessionId": id,
        "configOptions": options.iter().map(|o| o.to_json()).collect::<Vec<_>>(),
    }))
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
    let options = agent
        .session(&session_id)
        .await?
        .set_config(&config_id, &value)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "configOptions": options.iter().map(|o| o.to_json()).collect::<Vec<_>>(),
    }))
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
    // The run's own summary — stop reason, token usage, vendor extras — is
    // handed back verbatim: it is the caller's to record, not this bridge's to
    // drop (#97).
    agent
        .session(&session_id)
        .await?
        .prompt(&body)
        .await
        .map(|outcome| outcome.raw)
        .map_err(|e| e.to_string())
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
    // A missing command is an error, not a guess at somebody else's CLI: the
    // default here used to be "opencode", which made the bundled adapter's
    // sessions read as "keeps no transcript" (#124).
    let Some(command) = command else {
        return Err("no command to export with — the agent's definition names one".into());
    };

    let out = tokio::process::Command::new(&command)
        .args(["export", &session_id])
        // Named rather than resolved: this command has no app handle to derive
        // the prefix from. The person's own directories are the difference
        // between an exporter that is found and a feature that reads as absent
        // in a packaged build (#240).
        .env("PATH", path_env(user_path()))
        .output()
        .await
        .map_err(|e| format!("cannot run `{command} export`: {e}"))?;

    if !out.status.success() {
        return Ok(None);
    }
    let body = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if body.is_empty() { None } else { Some(body) })
}

/// The room's journal as files inside the channel's folder (#220). One-way and
/// read-only in contract: the mirror is exactly as good as the journal, and a
/// write path is what spike #45 declined.
#[tauri::command]
async fn workspace_write_mirror(dir: String, files: Vec<MirrorFile>) -> Result<usize, String> {
    workspace::write_mirror(std::path::Path::new(&dir), &files)
}

/// Stop one agent, or every agent when no name is given.
#[tauri::command]
async fn agent_stop(state: State<'_, AgentState>, name: Option<String>) -> Result<(), String> {
    match name {
        Some(name) => {
            if let Some(agent) = state.take(&name).await {
                agent.shutdown();
            }
        }
        None => {
            for agent in state.drain().await {
                agent.shutdown();
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
) -> Result<Arc<Running>, String> {
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
            // Asked now and off the thread that opens the window, so the first
            // panel does not pay a shell start-up and a shell that never
            // answers costs nobody a window (#240).
            std::thread::spawn(|| {
                let _ = user_path();
            });
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
            agent_turn_start,
            agent_repo_info,
            agent_clone,
            agent_derived_path,
            agent_folder_state,
            agent_human_changes,
            agent_stash,
            agent_git_init,
            agent_file_diff,
            agent_commit,
            agent_read,
            agent_new_session,
            agent_load_session,
            agent_prompt,
            agent_set_config,
            agent_export_session,
            agent_close_session,
            agent_cancel,
            agent_stop,
            workspace_write_mirror
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
mod what_the_commands_delegate {
    //! Where the two workspace commands keep their behaviour, which is not in
    //! themselves.
    //!
    //! A `#[tauri::command]` taking `State` cannot be invoked from a test —
    //! there is no way to build one without a running application — so what
    //! these commands do with the workspace is written as functions a test can
    //! call, in `workspace`. That only means anything if the commands actually
    //! go through those functions and keep no second copy of the logic: a
    //! correct `offer` beside an `agent_produced` still diffing inline is a
    //! green suite over a defect that never moved. Read off the source, the
    //! way the capability list already is, because a command that cannot be
    //! called leaves nothing else to look at.
    //!
    //! Only the delegation is asserted here. That the work then reaches the
    //! blocking pool is read at the call sites when the card is accepted —
    //! blocking and not blocking return the same value, and the difference is
    //! visible only to everything else waiting on the runtime.

    /// Each command, the function it must hand the workspace to, and what it
    /// must therefore no longer be doing itself. Leaving the old inline copy in
    /// place is how a suite goes green over a defect that is still there.
    const DELEGATES: &[(&str, &str, &[&str])] = &[
        (
            "agent_workspace",
            "workspace::baseline(",
            &["workspace::snapshot(", ".lock()", ".insert("],
        ),
        (
            "agent_produced",
            "workspace::offer(",
            &[
                "workspace::snapshot(",
                "workspace::git_changes(",
                "workspace::produced(",
                ".lock()",
            ],
        ),
        // Provisioning's two questions (#204): the path is derived by the same
        // function that derives it for a session, and the folder is read by
        // the function the tests can reach — a second copy of either in the
        // command would be logic no test can see.
        (
            "agent_derived_path",
            "workspace::workspace_path(",
            &["create_dir_all"],
        ),
        (
            "agent_folder_state",
            "workspace::folder_state(",
            &["create_dir_all"],
        ),
        // The gate's three (#207): read the person's work without moving the
        // line, and the two tree changes a button can ask for. A second copy
        // of any of them in a command body would be logic no test can see.
        (
            "agent_human_changes",
            "workspace::human_changes(",
            &[".insert("],
        ),
        ("agent_stash", "workspace::stash(", &["create_dir_all"]),
        (
            "agent_git_init",
            "workspace::git_init(",
            &["create_dir_all"],
        ),
        // The review dialog's two (#207 part B): what one file's changes
        // look like, and the commit that lands them. Same rule: the command
        // wires, the workspace decides.
        (
            "agent_file_diff",
            "workspace::file_diff(",
            &["create_dir_all"],
        ),
        ("agent_commit", "workspace::commit(", &["create_dir_all"]),
    ];

    fn source() -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .unwrap()
    }

    /// What one command does, from its signature to the brace that closes it,
    /// with the commentary taken out — a command that only mentions a function
    /// in a comment about it is not calling it.
    fn body(source: &str, name: &str) -> String {
        let start = source
            .find(&format!("async fn {name}("))
            .unwrap_or_else(|| panic!("`{name}` is not a command in this file"));
        let rest = &source[start..];
        let end = rest.find("\n}\n").expect("a command that ends");
        rest[..end]
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_commands_wire_and_the_workspace_decides() {
        let source = source();

        for (name, delegate, kept_inline) in DELEGATES {
            let body = body(&source, name);
            assert!(
                body.contains(*delegate),
                "`{name}` does not name `{delegate}` at all. What it passes is read at the call \
                 site; that it calls it is read here"
            );
            for inline in kept_inline.iter() {
                assert!(
                    !body.contains(*inline),
                    "`{name}` still does `{inline}` itself — a second copy of the line between \
                     turns, in the one place no test can reach it"
                );
            }
        }
    }
}

#[cfg(test)]
mod reading_a_produced_file {
    //! The one workspace command a test can call: it takes no state, only the
    //! two strings the panel sends. Its body is about to move inside a closure,
    //! and the check that a path cannot climb out of its own workspace is the
    //! kind of thing that survives a move by accident or not at all.

    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-read-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_produced_file_comes_back_as_it_was_written() {
        let dir = temp("plain");
        std::fs::write(dir.join("report.md"), "findings").unwrap();

        let body = agent_read(dir.to_string_lossy().into_owned(), "report.md".into())
            .await
            .unwrap();

        assert_eq!(BASE64.decode(body).unwrap(), b"findings");
    }

    #[tokio::test]
    async fn a_path_that_climbs_out_of_the_workspace_is_not_this_sessions_to_read() {
        // The agent names the path, and the panel passes it through. A session
        // that can read a sibling's directory by writing `..` is not scoped by
        // anything.
        let dir = temp("escape");
        std::fs::create_dir_all(dir.join("inside")).unwrap();
        std::fs::write(dir.join("secret.env"), "TOKEN=secret").unwrap();

        let error = agent_read(
            dir.join("inside").to_string_lossy().into_owned(),
            "../secret.env".into(),
        )
        .await
        .unwrap_err();

        assert!(error.contains("outside the workspace"), "{error}");
    }

    #[tokio::test]
    async fn a_file_too_large_to_attach_is_refused_rather_than_sent() {
        // The other guard in this body, and the other one a move could drop.
        let dir = temp("too-large");
        std::fs::write(
            dir.join("dump.bin"),
            vec![0u8; MAX_ARTIFACT_BYTES as usize + 1],
        )
        .unwrap();

        let error = agent_read(dir.to_string_lossy().into_owned(), "dump.bin".into())
            .await
            .unwrap_err();

        assert!(error.contains("too large to attach"), "{error}");
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

    async fn launched(name: &str) -> Arc<Running> {
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-agent/agent.mjs");
        Running::launch(
            name,
            "node",
            &[script.to_string_lossy().into_owned()],
            // Nothing is listening in a test; what these agents emit is
            // asserted where the client is, not here.
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
        let pid = claude.agent().pid().expect("a live agent has a pid");
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

        opencode.shutdown();
    }
}

#[cfg(test)]
mod the_protocol_is_not_spoken_here {
    //! ACP itself is no longer this application's to speak (#312).
    //!
    //! The client, the process-group bookkeeping and the agent catalogue live
    //! in `acp-client` / `acp-agents`, shared with the other products that
    //! reach a local agent the same way, and the specs that pin every lesson
    //! travel with them. What is left here is a window's bookkeeping.
    //!
    //! Read off the source, the way `what_the_commands_delegate` already reads
    //! it: a dependency boundary is not behaviour a test can call, and a
    //! second copy of a frame is exactly the thing that would not fail. Every
    //! needle is assembled at run time, because this module lives in one of
    //! the files it scans — written out literally, the strings below would
    //! read as the very definitions they say must be gone.

    /// Fragments of the wire. One of these in this crate means a frame is
    /// being built or read somewhere other than the client.
    fn wire_fragments() -> Vec<String> {
        vec![
            ["json", "rpc"].concat(),
            ["session", "/prompt"].concat(),
            ["session", "/new"].concat(),
            ["session", "/request_permission"].concat(),
            ["protocol", "Version"].concat(),
        ]
    }

    /// The resolution subsystem, which moved out whole.
    const RESOLUTION: &[&str] = &["merged_path", "asked_of_the_persons_shell", "user_path"];

    fn source(file: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(file);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("src/{file} should be part of this crate: {error}"))
    }

    /// The commentary taken out — a name mentioned in a doc comment is not a
    /// definition that stayed behind.
    fn code(file: &str) -> String {
        source(file)
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn no_frame_is_built_or_read_in_this_crate() {
        for file in ["lib.rs", "acp.rs"] {
            let text = code(file);
            for fragment in wire_fragments() {
                assert!(
                    !text.contains(&fragment),
                    "src/{file} still speaks the protocol (`{fragment}`) — a second copy of a \
                     frame is what drifts from the one the client's specs pin"
                );
            }
        }
    }

    #[test]
    fn the_resolution_subsystem_left_with_its_specs() {
        let lib = code("lib.rs");
        for name in RESOLUTION {
            assert!(
                !lib.contains(&format!("fn {name}(")),
                "`{name}` is still defined here — the crate answers where a command lives now"
            );
        }
        assert!(
            !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/path.rs")
                .exists(),
            "src/path.rs is still here, so there are two answers to where a binary is"
        );
    }

    #[test]
    fn both_crates_are_depended_on_by_tag() {
        // By tag, not by branch: three repositories with three release rhythms
        // must not break on each other.
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        )
        .expect("this crate has a manifest");

        for crate_name in ["acp-client", "acp-agents"] {
            let line = manifest
                .lines()
                .find(|line| line.starts_with(crate_name))
                .unwrap_or_else(|| panic!("{crate_name} should be a dependency"));
            assert!(
                line.contains("tag = "),
                "{crate_name} must be pinned by tag, not tracked on a branch: {line}"
            );
        }
    }

    #[test]
    fn the_handle_stays_at_the_door() {
        // `tauri` here has no `test` feature, so there is no mock app: a
        // function that takes the handle is one no spec can reach. The two
        // wrappers keep the handle in this file, and the crate they call into
        // never sees it.
        let lib = code("lib.rs");
        assert!(
            lib.contains("fn resolve("),
            "`resolve` should stay in lib.rs as the thin wrapper over the crate"
        );
        assert!(
            lib.contains("fn places("),
            "`places` should stay in lib.rs as the thin wrapper over the crate"
        );
    }
}
