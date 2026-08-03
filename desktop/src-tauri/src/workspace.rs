//! Where a session works, and what it produced there.
//!
//! The directory is derived from the workspace and the channel — never
//! chosen by the agent. An agent that could name its own working directory
//! could name someone else's.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// One path segment, safe to join. Everything that is not a plain name becomes
/// a dash, so a channel called `../../.ssh` cannot climb out of its directory.
fn segment(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "unnamed".into()
    } else {
        out.to_lowercase()
    }
}

/// A workspace and a channel each get their own directory. Two channels never
/// share one; two agents in the same channel share it, because they are
/// working on the same thing (#201).
pub fn workspace_path(root: &Path, workspace: &str, channel: &str) -> PathBuf {
    root.join(segment(workspace)).join(segment(channel))
}

/// What a directory held at a moment: each file, its size and its modified time.
pub type Snapshot = HashMap<PathBuf, (u64, Option<SystemTime>)>;

const MAX_DEPTH: usize = 8;

/// Walk the directory, skipping anything hidden — an agent's own scratch state
/// (`.git`, `.cache`) is not work product.
pub fn snapshot(dir: &Path) -> Snapshot {
    let mut out = Snapshot::new();
    walk(dir, dir, 0, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Snapshot) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let hidden = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.'));
        if hidden {
            continue;
        }
        match entry.metadata() {
            Ok(m) if m.is_dir() => walk(root, &path, depth + 1, out),
            Ok(m) if m.is_file() => {
                let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
                out.insert(relative, (m.len(), m.modified().ok()));
            }
            _ => {}
        }
    }
}

/// What the run produced: files that appeared, and files that changed. A file
/// the agent deleted is not work product, and one it left alone was not its work.
pub fn produced(before: &Snapshot, after: &Snapshot) -> Vec<PathBuf> {
    let mut changed: Vec<PathBuf> = after
        .iter()
        .filter(|(path, now)| before.get(*path).is_none_or(|then| then != *now))
        .map(|(path, _)| path.clone())
        .collect();
    changed.sort();
    changed
}

/// What git reports as changed, when the folder is a repository.
///
/// A bound folder is somebody's real work, and `node_modules` and `target` are
/// not hidden — one install would turn a diff into thousands of files. git
/// already answers exactly this question, and answers it by the team's own
/// ignore rules rather than by a list we invented.
///
/// `None` means this is not a repository, and the snapshot diff is the answer.
pub fn git_changes(dir: &Path) -> Option<Vec<String>> {
    let inside = std::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output()
        .ok()?;
    if !inside.status.success() {
        return None;
    }

    let out = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(dir)
        .output()
        .ok()?;

    Some(parse_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

/// `XY path`, and for a rename `XY old -> new`. What was produced is the new
/// name; the old one is gone and gone is not work product.
pub fn parse_porcelain(out: &str) -> Vec<String> {
    out.lines()
        .filter(|l| l.len() > 3)
        .map(|l| {
            let path = l[3..].trim();
            path.rsplit(" -> ")
                .next()
                .unwrap_or(path)
                .trim_matches('"')
                .to_string()
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// What a turn is measured against. In a repository the answer is the
/// porcelain path set *and where HEAD stood*; anywhere else it is a
/// filesystem snapshot. Taken when a turn begins, so work the person's hands
/// got to first is never offered as the run's (#202).
pub enum Baseline {
    Git(GitLine),
    Fs(Snapshot),
}

/// A repository as the line saw it (#206). The dirty paths alone cannot tell
/// a commit from a clean tree — both are an empty porcelain set — so the
/// branch and the sha are kept alongside: their moving is how a later offer
/// knows the turn committed rather than did nothing.
#[derive(Clone)]
pub struct GitLine {
    pub dirty: std::collections::HashSet<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// Measure a repository the way the line needs it measured. Branch is read
/// with symbolic-ref, the way `repo_info` reads it: an unborn branch is
/// still a branch, and a detached HEAD is none. `rev-parse HEAD` failing is
/// a repository with no commits yet — null, not an error.
fn git_line(dir: &Path, changed: Vec<String>) -> GitLine {
    GitLine {
        dirty: changed.into_iter().collect(),
        branch: git_answer(dir, &["symbolic-ref", "--short", "HEAD"]),
        head: git_answer(dir, &["rev-parse", "HEAD"]),
    }
}

/// Measure a directory the way a turn start needs it measured.
fn measure(dir: &Path) -> Baseline {
    match git_changes(dir) {
        Some(changed) => Baseline::Git(git_line(dir, changed)),
        None => Baseline::Fs(snapshot(dir)),
    }
}

/// What the turn itself changed: the current porcelain minus what was
/// already dirty when it began, and how many paths that minus excluded.
/// The granularity is a file — an agent's edit inside a file the person had
/// already touched keeps the whole file out of the offer, because there is
/// no hunk-level truth here to separate them.
pub fn turn_delta(
    current: &[String],
    baseline: &std::collections::HashSet<String>,
) -> (Vec<String>, usize) {
    let mut files: Vec<String> = current
        .iter()
        .filter(|p| !baseline.contains(*p))
        .cloned()
        .collect();
    files.sort();
    let pre_existing = current.len() - files.len();
    (files, pre_existing)
}

/// The line each workspace's turns are measured from.
#[derive(Default)]
pub struct Workspaces(pub std::sync::Mutex<HashMap<PathBuf, Baseline>>);

/// A file worth offering: where it is, and how big.
#[derive(serde::Serialize)]
pub struct Produced {
    pub path: String,
    pub bytes: u64,
}

/// Large files are not offered. A person who wants to publish a video can do it
/// deliberately; an agent that writes a two-gigabyte core dump should not get a
/// prompt suggesting the channel wants it.
pub const MAX_ARTIFACT_BYTES: u64 = 25 * 1024 * 1024;

/// Take the line this workspace's turns are measured from, if it has none yet.
///
/// Opening a workspace is not the same act as starting a turn: a person clicks
/// back into a channel whose agent is still working, and a fresh snapshot there
/// would quietly move the line past everything the turn has written so far —
/// which then belongs to nobody, because the next turn measures from after it.
/// The first entry has to take a line, or a folder with a year of work in it is
/// offered whole; every entry after that already has one (#179).
pub fn baseline(shots: &Workspaces, dir: &Path) -> Result<(), String> {
    let mut state = shots
        .0
        .lock()
        .map_err(|_| "workspace state is poisoned".to_string())?;
    state
        .entry(dir.to_path_buf())
        .or_insert_with(|| measure(dir));
    Ok(())
}

/// A turn begins: the line moves to now, deliberately. Opening a workspace
/// takes the line only if there is none, because clicking back into a channel
/// mid-turn is not the start of a turn — but a prompt going out is, and from
/// here everything already dirty is the person's, not the run's (#202).
pub fn turn_start(shots: &Workspaces, dir: &Path) -> Result<(), String> {
    shots
        .0
        .lock()
        .map_err(|_| "workspace state is poisoned".to_string())?
        .insert(dir.to_path_buf(), measure(dir));
    Ok(())
}

/// What a turn's offer is made of: the files, how many changed paths
/// were held back because they were dirty before the turn began, and the
/// commit the turn landed when it landed one (#206).
#[derive(serde::Serialize)]
pub struct TurnProduced {
    pub files: Vec<Produced>,
    pub pre_existing: usize,
    /// Always present, null when the turn did not commit: the client reads
    /// one shape either way.
    pub committed: Option<Committed>,
}

/// The turn's work as a commit: where it landed, how much, and whether the
/// branch it landed on is the repository's mainline — the one case a person
/// must read as shipping-adjacent (#206).
#[derive(serde::Serialize)]
pub struct Committed {
    pub branch: String,
    pub commits: u32,
    pub stat: String,
    pub on_default: bool,
}

/// What the repository calls its mainline, read the one way everywhere it
/// matters (#203 reads it for the warning, #206 for the mark): origin/HEAD
/// once somebody has fetched, the checkout's own branch before that.
fn default_branch(dir: &Path) -> Option<String> {
    git_answer(
        dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .map(|head| head.trim_start_matches("origin/").to_string())
    .or_else(|| git_answer(dir, &["symbolic-ref", "--short", "HEAD"]))
}

/// What the turn committed, measured between the line and now. `None` when
/// HEAD stands where the line left it — a dirty tree is the files' story,
/// not a commit's. The range is `then..HEAD`; from the empty tree when the
/// line predates the first commit (the empty tree's sha is a constant of
/// git's, not something to compute).
fn committed_since(dir: &Path, line: &GitLine, now: &GitLine) -> Option<Committed> {
    const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    now.head.as_ref()?;
    if line.head == now.head {
        return None;
    }
    let from = line.head.as_deref().unwrap_or(EMPTY_TREE);
    let range = format!("{from}..HEAD");
    let commits = git_answer(dir, &["rev-list", "--count", &range])
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0);
    // Head moved without a commit the range can see — a reset, a rebase.
    // That is history being rewritten, not work the turn produced.
    if commits == 0 {
        return None;
    }
    let stat = git_answer(dir, &["diff", "--shortstat", &range]).unwrap_or_default();
    let branch = now.branch.clone().unwrap_or_else(|| "HEAD".into());
    let on_default = default_branch(dir).is_some_and(|d| now.branch.as_ref() == Some(&d));
    Some(Committed {
        branch,
        commits,
        stat,
        on_default,
    })
}

/// What this turn wrote or changed, and the line moved to where it ends.
///
/// Reading the line and moving it is one act, so it is done holding the map:
/// two channels can be bound to one folder and their turns can finish in the
/// same moment, and a "before" both of them read is a file the room is offered
/// twice — or, when the write lands between one turn's snapshot and its turn to
/// hold the map, a file offered by neither and then left behind the line. Under
/// the lock the second turn diffs against what the first one left, which is
/// nothing (#179).
pub fn offer(shots: &Workspaces, dir: &Path) -> Result<TurnProduced, String> {
    // A folder somebody bound is their real work, and git already knows what
    // changed in it — by their ignore rules, not ours. Since #202 the line
    // applies here too: porcelain minus what was dirty when the turn began.
    if let Some(changed) = git_changes(dir) {
        let now = git_line(dir, changed.clone());
        let mut state = shots
            .0
            .lock()
            .map_err(|_| "workspace state is poisoned".to_string())?;
        let (paths, pre_existing) = match state.get(dir) {
            Some(Baseline::Git(line)) => turn_delta(&changed, &line.dirty),
            // No line, or one taken before this folder was a repository:
            // the whole porcelain answer, as before.
            _ => (changed.clone(), 0),
        };
        // A commit empties the porcelain set, so it never appears in `paths`:
        // without this, the turn that did the tidiest work would read as the
        // turn that did nothing (#206). Only a Git line can see it — a folder
        // that became a repository mid-turn has no head to measure from.
        let committed = match state.get(dir) {
            Some(Baseline::Git(line)) => committed_since(dir, line, &now),
            _ => None,
        };
        state.insert(dir.to_path_buf(), Baseline::Git(now));
        let files = paths
            .into_iter()
            .filter_map(|path| {
                let bytes = fs::metadata(dir.join(&path)).ok()?.len();
                (bytes <= MAX_ARTIFACT_BYTES).then_some(Produced { path, bytes })
            })
            .collect();
        return Ok(TurnProduced {
            files,
            pre_existing,
            committed,
        });
    }

    let mut state = shots
        .0
        .lock()
        .map_err(|_| "workspace state is poisoned".to_string())?;
    let after = snapshot(dir);
    let before = match state.get(dir) {
        Some(Baseline::Fs(snap)) => snap.clone(),
        _ => Snapshot::default(),
    };

    let files = produced(&before, &after)
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
    state.insert(dir.to_path_buf(), Baseline::Fs(after));
    Ok(TurnProduced {
        files,
        pre_existing: 0,
        // Outside a repository there is no commit to see: the snapshot diff
        // is the whole answer.
        committed: None,
    })
}

/// The person's unreviewed work in a folder, as the gate sees it (#207).
#[derive(serde::Serialize)]
pub struct HumanChanges {
    pub files: Vec<Produced>,
    pub branch: Option<String>,
    pub is_repo: bool,
}

/// What changed outside any run: the current porcelain minus the line's own
/// dirt. Read-only, deliberately — the line is the turn's to move (#202), and
/// a gate that consumed what it saw would ask its question exactly once.
/// Without a line, everything dirty counts: nothing was ever measured, so
/// nothing is the turn's.
///
/// Outside a repository the gate itself never fires — `is_repo: false` and
/// the client does not pause anything. But the files are listed all the
/// same, since part B's review dialog is also the upgrade path: a plain
/// folder that gains a history starts by showing what would be in it (#207).
pub fn human_changes(shots: &Workspaces, dir: &Path) -> Result<HumanChanges, String> {
    let Some(changed) = git_changes(dir) else {
        let state = shots
            .0
            .lock()
            .map_err(|_| "workspace state is poisoned".to_string())?;
        let after = snapshot(dir);
        let before = match state.get(dir) {
            Some(Baseline::Fs(line)) => line.clone(),
            _ => Snapshot::default(),
        };
        drop(state);
        let files = produced(&before, &after)
            .into_iter()
            .map(|path| {
                let bytes = after.get(&path).map(|(size, _)| *size).unwrap_or(0);
                Produced {
                    path: path.to_string_lossy().into_owned(),
                    bytes,
                }
            })
            .collect();
        return Ok(HumanChanges {
            files,
            branch: None,
            is_repo: false,
        });
    };

    let state = shots
        .0
        .lock()
        .map_err(|_| "workspace state is poisoned".to_string())?;
    let files = match state.get(dir) {
        Some(Baseline::Git(line)) => changed
            .into_iter()
            .filter(|path| !line.dirty.contains(path))
            .collect(),
        _ => changed,
    };
    drop(state);

    let branch = git_answer(dir, &["symbolic-ref", "--short", "HEAD"]);
    let files = files
        .into_iter()
        .map(|path| {
            let bytes = fs::metadata(dir.join(&path)).map(|m| m.len()).unwrap_or(0);
            Produced { path, bytes }
        })
        .collect();
    Ok(HumanChanges {
        files,
        branch,
        is_repo: true,
    })
}

/// One git command that changes the tree, run for a person who pressed a
/// button. git's own stderr is the error text: "stash" failing has reasons
/// the person recognises, and a paraphrase would only hide them.
fn git_tree_change(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if said.is_empty() {
            format!("git {} exited with {}", args[0], out.status)
        } else {
            said
        });
    }
    Ok(())
}

/// The person's unreviewed work, set aside with a name that says who put it
/// there (#207). `git stash pop` brings it back, which is exactly what the
/// button's suffix says. Nothing to stash is a success: the work is as gone
/// as it would be after one.
pub fn stash(dir: &Path) -> Result<(), String> {
    git_tree_change(
        dir,
        &["stash", "push", "-u", "-m", "workroom: human changes"],
    )
}

/// A folder becomes a repository when a person says so. Idempotent — init in
/// an existing repository is a no-op — and deliberately remote-less: where it
/// pushes is a later decision, not this one's.
pub fn git_init(dir: &Path) -> Result<(), String> {
    git_tree_change(dir, &["init"])
}

/// How much of a new file the review shows before saying "and more". Enough
/// to know what the file is; the rest is on disk one click away.
const NEW_FILE_PREVIEW_LINES: usize = 200;

/// One file's changes, as the review dialog shows them (#207).
///
/// A tracked file answers with `git diff -- <path>` — the worktree against
/// the index, deliberately not more: the gate's question is "what did the
/// person just write", and work already staged was gathered deliberately
/// once. An untracked file has no diff, so it is shown as what it is — a new
/// file, its content capped with the cap said. Confined to the folder the
/// way `agent_read` is: a path that climbs out is not reviewed.
pub fn file_diff(dir: &Path, path: &str) -> Result<String, String> {
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let file = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&root) {
        return Err(format!("{path} is outside the workspace"));
    }

    let tracked = std::process::Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", path])
        .current_dir(&root)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);

    if tracked {
        let out = std::process::Command::new("git")
            .args(["diff", "--", path])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("cannot run git: {e}"))?;
        let diff = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // A tracked file with no worktree diff was staged, not edited since:
        // said, because an empty answer reads as broken.
        return Ok(if diff.is_empty() {
            "no unstaged changes — the file's changes are already staged".into()
        } else {
            diff
        });
    }

    let body = fs::read_to_string(&file).map_err(|e| format!("cannot read {path}: {e}"))?;
    let lines: Vec<&str> = body.lines().take(NEW_FILE_PREVIEW_LINES + 1).collect();
    let mut shown = format!(
        "new file — every line is added (showing {} lines)\n",
        lines.len().min(NEW_FILE_PREVIEW_LINES)
    );
    shown.push_str(&lines[..lines.len().min(NEW_FILE_PREVIEW_LINES)].join("\n"));
    Ok(shown)
}

/// The reviewed changes, committed under the machine's own git identity
/// (#207). No configuration is ever written here: whose name goes on a
/// commit is the person's git setup, and its absence comes back as git's own
/// error for the dialog to show. Answers with the new commit's short sha.
pub fn commit(dir: &Path, paths: &[String], message: &str) -> Result<String, String> {
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str));
    git_tree_change(dir, &add)?;
    git_tree_change(dir, &["commit", "-m", message])?;
    git_answer(dir, &["rev-parse", "--short", "HEAD"])
        .ok_or_else(|| "the commit landed but HEAD could not be named".to_string())
}

/// One git question asked of a folder. `None` covers both "this is not a
/// repository" and "git could not say" — a caller warning about what a folder
/// *might* do has nothing to warn about in either case.
fn git_answer(dir: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let answer = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if answer.is_empty() {
        None
    } else {
        Some(answer)
    }
}

/// What the room is about to let an agent work in, said before it works there
/// (#203): where the folder comes from, what it calls its mainline, and
/// whether merging to that mainline ships something.
#[derive(serde::Serialize)]
pub struct RepoInfo {
    pub remote: Option<String>,
    pub default_branch: Option<String>,
    pub deploys_on_push: bool,
}

/// Read the three facts off a folder. Null-safe by construction: a folder
/// that is not a repository answers every question with nothing.
pub fn repo_info(dir: &Path) -> RepoInfo {
    let remote = git_answer(dir, &["remote", "get-url", "origin"]);
    // One reading, shared with the offer's on_default mark: origin/HEAD once
    // somebody has fetched, the checkout's own branch before that (#206).
    let default_branch = default_branch(dir);

    // A cheap heuristic, and named as one: a GitHub workflow whose text
    // mentions both `push` and the default branch is read as "merging ships
    // it". Deliberately not a YAML parse — the warning this feeds is advice
    // to protect a branch, where a false positive costs somebody a checklist
    // they should have anyway and a false negative costs the warning, so it
    // errs toward saying yes.
    let deploys_on_push = default_branch.as_ref().is_some_and(|branch| {
        let Ok(entries) = fs::read_dir(dir.join(".github/workflows")) else {
            return false;
        };
        entries.flatten().any(|entry| {
            let path = entry.path();
            let is_workflow = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext == "yml" || ext == "yaml");
            is_workflow
                && fs::read_to_string(&path)
                    .is_ok_and(|body| body.contains("push") && body.contains(branch.as_str()))
        })
    });

    RepoInfo {
        remote,
        default_branch,
        deploys_on_push,
    }
}

/// What a folder is, before anybody touches it (#204): whether it is there,
/// whether it holds anything, and which repository it is when it is one.
/// Provisioning reads this to decide — clone, leave alone, or warn — and the
/// whole point of asking first is that a folder holding somebody's work is
/// never written to.
#[derive(serde::Serialize)]
pub struct FolderState {
    pub exists: bool,
    /// Missing counts as empty: both are a place a clone may land.
    pub empty: bool,
    pub remote: Option<String>,
}

/// Read the three facts off a directory. Nothing here creates or modifies —
/// deciding what to do with the answer is the caller's.
pub fn folder_state(dir: &Path) -> FolderState {
    let exists = dir.exists();
    let empty = fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true);
    let remote = git_answer(dir, &["remote", "get-url", "origin"]);
    FolderState {
        exists,
        empty,
        remote,
    }
}

/// The room's repository, cloned into the folder the room works in (#203).
///
/// A non-empty directory is refused rather than merged into: cloning into
/// somebody's existing work does not clone, it litters — and what the person
/// then sees is their folder with extra files in it and no way to tell which
/// were already theirs. Re-cloning a folder that already holds the repository
/// is #204's concern; here "already something there" earns a sentence, never
/// a deletion.
pub fn clone_repository(url: &str, dir: &Path) -> Result<(), String> {
    // The url is the room's setting — server data another member typed, run
    // on this machine. No shell, so no injection; but a "url" that starts
    // with a dash is a flag to git (`--upload-pack` executes a command), and
    // flags are not the room's to set (#203).
    if url.starts_with('-') {
        return Err("a repository address does not start with a dash".to_string());
    }
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let non_empty = fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if non_empty {
        return Err(format!(
            "{} is not empty — bind it as the existing folder instead, or empty it yourself",
            dir.display()
        ));
    }

    let out = std::process::Command::new("git")
        .args(["clone", "--", url])
        .arg(dir)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        // git's own words: "repository not found" means more than "failed".
        let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if said.is_empty() {
            format!("git clone exited with {}", out.status)
        } else {
            said
        });
    }
    Ok(())
}

#[cfg(test)]
mod folder_state_tests {
    //! What provisioning has to know before it touches anything (#204): is
    //! the folder there, does it hold something, and which repository is it.

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-state-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_folder_that_was_never_made_is_not_there_and_holds_nothing() {
        let dir = temp("missing");

        let state = folder_state(&dir);

        assert!(!state.exists);
        assert!(
            state.empty,
            "nothing there is nothing in the way of a clone"
        );
        assert!(state.remote.is_none());
    }

    #[test]
    fn an_empty_folder_is_a_place_a_clone_may_land() {
        let dir = temp("empty");
        fs::create_dir_all(&dir).unwrap();

        let state = folder_state(&dir);

        assert!(state.exists);
        assert!(state.empty);
        assert!(state.remote.is_none());
    }

    #[test]
    fn a_repository_says_which_one_it_is() {
        let dir = temp("repo");
        fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        run(&["init", "-q", "."]);
        run(&[
            "remote",
            "add",
            "origin",
            "https://example.test/acme/widgets.git",
        ]);

        let state = folder_state(&dir);

        assert!(state.exists);
        assert!(!state.empty, ".git is already something held");
        assert_eq!(
            state.remote.as_deref(),
            Some("https://example.test/acme/widgets.git")
        );
    }

    #[test]
    fn a_folder_of_somebodys_work_is_not_empty_and_is_no_repository() {
        // The mismatch case: something is here, and it is not the room's
        // repository — so provisioning must not touch it.
        let dir = temp("theirs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.md"), "somebody's work").unwrap();

        let state = folder_state(&dir);

        assert!(state.exists);
        assert!(!state.empty);
        assert!(state.remote.is_none());
    }
}

#[cfg(test)]
mod repo_info_tests {
    //! The three facts, against real repositories: a fake remote, a fake
    //! workflow file, and a clone that must not destroy anything.

    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-repo-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repository(name: &str) -> PathBuf {
        let dir = temp(name);
        run(&dir, &["init", "-q", "-b", "main", "."]);
        run(&dir, &["config", "user.email", "a@b"]);
        run(&dir, &["config", "user.name", "a"]);
        run(
            &dir,
            &[
                "remote",
                "add",
                "origin",
                "https://example.test/acme/widgets.git",
            ],
        );
        dir
    }

    #[test]
    fn a_repository_says_where_it_came_from_and_what_it_calls_mainline() {
        let dir = repository("named");

        let info = repo_info(&dir);

        assert_eq!(
            info.remote.as_deref(),
            Some("https://example.test/acme/widgets.git")
        );
        // Nothing was fetched, so origin/HEAD does not exist yet; the local
        // checkout's branch is the answer then.
        assert_eq!(info.default_branch.as_deref(), Some("main"));
        assert!(!info.deploys_on_push);
    }

    #[test]
    fn a_workflow_that_ships_on_push_to_the_mainline_is_said_to_deploy() {
        let dir = repository("deploys");
        fs::create_dir_all(dir.join(".github/workflows")).unwrap();
        fs::write(
            dir.join(".github/workflows/deploy.yml"),
            "on:\n  push:\n    branches: [main]\njobs:\n  ship:\n    runs-on: ubuntu-latest\n",
        )
        .unwrap();

        assert!(repo_info(&dir).deploys_on_push);
    }

    #[test]
    fn a_workflow_for_another_branch_does_not_warn() {
        // Shipping a release branch on push is not shipping the mainline.
        let dir = repository("other-branch");
        fs::create_dir_all(dir.join(".github/workflows")).unwrap();
        fs::write(
            dir.join(".github/workflows/deploy.yaml"),
            "on:\n  push:\n    branches: [release]\njobs:\n  ship:\n    runs-on: ubuntu-latest\n",
        )
        .unwrap();

        assert!(!repo_info(&dir).deploys_on_push);
    }

    #[test]
    fn a_folder_that_is_not_a_repository_says_nothing() {
        let dir = temp("plain");

        let info = repo_info(&dir);

        assert!(info.remote.is_none());
        assert!(info.default_branch.is_none());
        assert!(!info.deploys_on_push);
    }

    #[test]
    fn a_clone_lands_where_it_was_asked() {
        let source = repository("source");
        let mut f = fs::File::create(source.join("README.md")).unwrap();
        f.write_all(b"# widgets\n").unwrap();
        run(&source, &["add", "-A"]);
        run(&source, &["commit", "-qm", "init"]);

        // A directory that does not exist yet, under one that does not either:
        // the parents are the command's to make.
        let into = temp("target").join("deep").join("widgets");
        clone_repository(&source.to_string_lossy(), &into).unwrap();

        assert!(into.join(".git").exists());
        assert_eq!(
            fs::read_to_string(into.join("README.md")).unwrap(),
            "# widgets\n"
        );
    }

    #[test]
    fn a_clone_refuses_to_litter_an_existing_folder() {
        let dir = temp("occupied");
        fs::write(dir.join("mine.txt"), "already here").unwrap();

        let error = clone_repository("https://example.test/nope.git", &dir).unwrap_err();

        assert!(error.contains("not empty"), "{error}");
        assert_eq!(
            fs::read_to_string(dir.join("mine.txt")).unwrap(),
            "already here"
        );
    }

    #[test]
    fn a_clone_that_git_refused_reports_gits_own_words() {
        let into = temp("unreachable").join("nope");

        let error = clone_repository("https://example.test/no/such-repo.git", &into).unwrap_err();

        assert!(!error.is_empty());
        assert!(
            !into.exists(),
            "a refused clone leaves nothing behind to trip over"
        );
    }

    #[test]
    fn a_repository_address_is_not_a_flag() {
        // The url is the room's setting — server data another member typed.
        // `git clone --upload-pack=<cmd>` runs the command; nobody's setting
        // gets to do that on this machine.
        let into = temp("dash").join("nope");

        let error = clone_repository("--upload-pack=touch /tmp/pwned", &into).unwrap_err();

        assert!(error.contains("dash"), "{error}");
        assert!(!into.exists());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn git_says_what_changed_and_stays_quiet_about_what_it_ignores() {
        let out = " M src/main.rs\n?? report.md\n";

        assert_eq!(parse_porcelain(out), vec!["src/main.rs", "report.md"]);
    }

    #[test]
    fn a_renamed_file_is_produced_under_its_new_name() {
        // The old name is gone, and gone is not work product.
        assert_eq!(parse_porcelain("R  old.md -> new.md\n"), vec!["new.md"]);
    }

    #[test]
    fn a_path_with_a_space_survives() {
        assert_eq!(
            parse_porcelain("?? \"my report.md\"\n"),
            vec!["my report.md"]
        );
    }

    #[test]
    fn nothing_changed_is_nothing_produced() {
        assert!(parse_porcelain("").is_empty());
        assert!(parse_porcelain("\n").is_empty());
    }

    #[test]
    fn a_folder_that_is_not_a_repository_has_no_git_answer() {
        let dir = temp("notarepo");

        assert!(
            git_changes(&dir).is_none(),
            "the snapshot diff is the answer there"
        );
    }

    #[test]
    fn each_workspace_and_channel_gets_its_own_directory() {
        // ~/WorkRoom/<workspace>/<channel> — home is already per-person,
        // and two agents in one channel work on one thing, so neither gets
        // a path level of its own (#201).
        let root = Path::new("/data");
        assert_eq!(
            workspace_path(root, "farol", "meetings"),
            PathBuf::from("/data/farol/meetings")
        );
        assert_ne!(
            workspace_path(root, "farol", "meetings"),
            workspace_path(root, "farol", "marketing"),
        );
        assert_ne!(
            workspace_path(root, "farol", "meetings"),
            workspace_path(root, "acme", "meetings"),
        );
    }

    #[test]
    fn a_name_cannot_climb_out_of_its_directory() {
        // Both slugs arrive from the server. Neither may become a path.
        let root = Path::new("/data");
        let escaped = workspace_path(root, "farol", "../../.ssh");

        assert!(escaped.starts_with("/data/farol"), "{escaped:?}");
        assert_eq!(escaped.components().count(), 4);
        assert_eq!(
            workspace_path(root, "..", ".."),
            PathBuf::from("/data/unnamed/unnamed"),
            "a name that is nothing but dots is not a directory name"
        );
    }

    #[test]
    fn a_file_the_run_wrote_is_work_product() {
        let dir = temp("produced");
        let before = snapshot(&dir);
        write(&dir, "report.md", "findings");

        assert_eq!(
            produced(&before, &snapshot(&dir)),
            vec![PathBuf::from("report.md")]
        );
    }

    #[test]
    fn a_file_the_run_changed_is_work_product_too() {
        let dir = temp("changed");
        write(&dir, "notes.md", "one");
        let before = snapshot(&dir);
        write(&dir, "notes.md", "one and then some more");

        assert_eq!(
            produced(&before, &snapshot(&dir)),
            vec![PathBuf::from("notes.md")]
        );
    }

    #[test]
    fn what_the_run_left_alone_is_not_offered() {
        let dir = temp("untouched");
        write(&dir, "old.md", "from an earlier turn");
        let before = snapshot(&dir);
        write(&dir, "new.md", "this turn");

        assert_eq!(
            produced(&before, &snapshot(&dir)),
            vec![PathBuf::from("new.md")]
        );
    }

    #[test]
    fn a_deleted_file_is_not_work_product() {
        let dir = temp("deleted");
        write(&dir, "gone.md", "x");
        let before = snapshot(&dir);
        fs::remove_file(dir.join("gone.md")).unwrap();

        assert!(produced(&before, &snapshot(&dir)).is_empty());
    }

    #[test]
    fn the_agents_own_scratch_state_is_not_work_product() {
        // Otherwise every turn offers to publish `.git` into the channel.
        let dir = temp("hidden");
        let before = snapshot(&dir);
        write(&dir, ".git/config", "[core]");
        write(&dir, ".env", "TOKEN=secret");
        write(&dir, "report.md", "findings");

        assert_eq!(
            produced(&before, &snapshot(&dir)),
            vec![PathBuf::from("report.md")]
        );
    }

    #[test]
    fn nested_work_keeps_its_shape() {
        let dir = temp("nested");
        let before = snapshot(&dir);
        write(&dir, "out/charts/q3.svg", "<svg/>");

        assert_eq!(
            produced(&before, &snapshot(&dir)),
            vec![PathBuf::from("out/charts/q3.svg")]
        );
    }
}

#[cfg(test)]
mod the_offer_a_turn_leaves {
    //! What a turn is offered, when another turn is finishing at the same
    //! moment and when the person re-opens the channel while it still runs.
    //!
    //! The two commands own one line — what was already there — and both read
    //! it and move it. Everything below is about that line being read and moved
    //! once per turn, by the turn that did the work.

    use super::*;
    use std::io::Write as _;
    use std::time::Duration;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-offer-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path)
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
    }

    fn paths(files: &[Produced]) -> Vec<String> {
        let mut out: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        out.sort();
        out
    }

    /// Two turns, held at the door until the work is on disk, then let go at
    /// once. Racing them on wall-clock alone proves nothing — the loser is
    /// usually finished before the winner starts — and the map is the only
    /// door both of them have to come through.
    fn both_turns_at_once(dir: &Path, shots: &Workspaces, work: &str) -> Vec<String> {
        let held = shots.0.lock().unwrap();
        let (first, second) = std::thread::scope(|s| {
            let one = s.spawn(|| offer(shots, dir).unwrap());
            let two = s.spawn(|| offer(shots, dir).unwrap());
            std::thread::sleep(Duration::from_millis(150));
            write(dir, work, "findings");
            drop(held);
            (one.join().unwrap(), two.join().unwrap())
        });

        let mut both = paths(&first.files);
        both.extend(paths(&second.files));
        both
    }

    #[test]
    fn two_turns_finishing_at_once_offer_the_work_once() {
        // Two channels can be bound to one folder, and their turns can land in
        // the same millisecond. A file offered twice is a room told twice that
        // it was written, and a person asked twice to publish it.
        let dir = temp("race");
        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();

        assert_eq!(
            both_turns_at_once(&dir, &shots, "report.md"),
            vec!["report.md"],
            "one turn's work, offered by one turn"
        );
    }

    #[test]
    fn work_written_while_the_line_is_held_is_not_lost() {
        // The other way the race hurts. A turn that snapshots before it takes
        // the map has already missed everything written since — and nobody
        // else offers it either, because the line is then moved past it.
        let dir = temp("under-lock");
        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();

        let held = shots.0.lock().unwrap();
        let files = std::thread::scope(|s| {
            let turn = s.spawn(|| offer(&shots, &dir).unwrap());
            std::thread::sleep(Duration::from_millis(150));
            write(&dir, "late.md", "written while the map was held");
            drop(held);
            turn.join().unwrap()
        });

        assert_eq!(paths(&files.files), vec!["late.md"]);
    }

    #[test]
    fn opening_the_workspace_again_does_not_move_the_line() {
        // Clicking back into a channel whose agent is mid-turn is not the start
        // of a turn. Re-snapshotting there silently swallows everything the
        // turn has written so far.
        let dir = temp("re-entry");
        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();
        write(&dir, "report.md", "written while the turn still runs");

        baseline(&shots, &dir).unwrap();

        assert_eq!(
            paths(&offer(&shots, &dir).unwrap().files),
            vec!["report.md"]
        );
    }

    #[test]
    fn a_workspace_opened_for_the_first_time_starts_from_what_was_there() {
        // The other half: a first entry must take the line, or a folder with a
        // year of work in it is offered whole on the first turn.
        let dir = temp("first-entry");
        write(&dir, "old.md", "from an earlier day");
        let shots = Workspaces::default();

        baseline(&shots, &dir).unwrap();
        write(&dir, "new.md", "this turn");

        assert_eq!(paths(&offer(&shots, &dir).unwrap().files), vec!["new.md"]);
    }

    #[test]
    fn what_was_offered_once_is_not_offered_again() {
        let dir = temp("twice");
        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();
        write(&dir, "report.md", "findings");

        assert_eq!(
            paths(&offer(&shots, &dir).unwrap().files),
            vec!["report.md"]
        );
        assert!(
            offer(&shots, &dir).unwrap().files.is_empty(),
            "the next turn is measured from where the last one ended"
        );
    }

    #[test]
    fn a_turn_is_measured_from_its_own_start() {
        // Dirty when the turn began: the person's. Appeared during it: the
        // run's. The offer is the difference, and the difference only.
        let baseline: std::collections::HashSet<String> =
            ["draft.md".to_string()].into_iter().collect();
        let current = vec!["draft.md".to_string(), "report.md".to_string()];

        let (files, pre_existing) = turn_delta(&current, &baseline);

        assert_eq!(files, vec!["report.md"]);
        assert_eq!(pre_existing, 1);
    }

    #[test]
    fn a_file_in_both_stays_the_persons() {
        // The granularity is a file: the agent touched something that was
        // already dirty, and there is no hunk-level truth to separate them
        // here. The file stays out of the offer, and the count says why.
        let baseline: std::collections::HashSet<String> =
            ["notes.md".to_string()].into_iter().collect();
        let current = vec!["notes.md".to_string()];

        let (files, pre_existing) = turn_delta(&current, &baseline);

        assert!(files.is_empty());
        assert_eq!(pre_existing, 1);
    }

    #[test]
    fn without_a_line_everything_is_offered() {
        // An older client that never marks a turn start gets yesterday's
        // behavior, not a broken bridge.
        let current = vec!["a.md".to_string(), "b.md".to_string()];

        let (files, pre_existing) = turn_delta(&current, &std::collections::HashSet::new());

        assert_eq!(files, current);
        assert_eq!(pre_existing, 0);
    }

    #[test]
    fn a_repository_with_no_line_answers_whole() {
        // The same fallback at the bridge: no turn_start, no baseline call —
        // the whole porcelain answer, as before #202.
        let dir = temp("noline");
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        run(&["init", "-q", "."]);
        run(&["config", "user.email", "a@b"]);
        run(&["config", "user.name", "a"]);
        write(&dir, "src.rs", "fn main() {}");
        run(&["add", "-A"]);
        run(&["commit", "-qm", "init"]);
        write(&dir, "draft.md", "dirty before anything we know");

        let shots = Workspaces::default();

        let got = offer(&shots, &dir).unwrap();
        assert_eq!(paths(&got.files), vec!["draft.md"]);
        assert_eq!(got.pre_existing, 0);
    }

    #[test]
    fn a_bound_repository_is_still_answered_by_git() {
        // In somebody's real repository git answers what changed, by their
        // ignore rules rather than ours. Since #202 the line applies here
        // too: the answer is measured from the turn's start.
        let dir = temp("bound");
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        run(&["init", "-q", "."]);
        run(&["config", "user.email", "a@b"]);
        run(&["config", "user.name", "a"]);
        write(&dir, ".gitignore", "node_modules/\n");
        write(&dir, "src/main.rs", "fn main() {}");
        run(&["add", "-A"]);
        run(&["commit", "-qm", "init"]);

        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();
        write(&dir, "report.md", "findings");
        write(&dir, "node_modules/left-pad/index.js", "junk");

        assert_eq!(
            paths(&offer(&shots, &dir).unwrap().files),
            vec!["report.md"]
        );
        // Still uncommitted, still not offered twice: the line moved to the
        // porcelain set the first offer saw, so the second offer of the same
        // turn's end is empty — and says one path was held back as already
        // accounted for.
        let second = offer(&shots, &dir).unwrap();
        assert!(
            second.files.is_empty(),
            "offered once, in a repository too — the turn's start is the line"
        );
        assert_eq!(second.pre_existing, 1);
    }

    #[test]
    fn a_turns_own_start_is_the_line_in_a_repository() {
        // The attribution hole #202 closes: work a person left uncommitted
        // before the turn is measured separately from what the turn did.
        let dir = temp("dirty");
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        run(&["init", "-q", "."]);
        run(&["config", "user.email", "a@b"]);
        run(&["config", "user.name", "a"]);
        write(&dir, "src.rs", "fn main() {}");
        run(&["add", "-A"]);
        run(&["commit", "-qm", "init"]);

        // The person's unfinished edit, sitting in the tree before any turn.
        write(&dir, "draft.md", "half a thought");
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();

        // The turn: the agent writes its report.
        write(&dir, "report.md", "findings");

        let got = offer(&shots, &dir).unwrap();
        assert_eq!(paths(&got.files), vec!["report.md"]);
        assert_eq!(
            got.pre_existing, 1,
            "the person's draft is not the run's work"
        );
    }

    #[test]
    fn a_new_turn_re_takes_the_line() {
        // Editing between turns must not leak into the next turn's offer:
        // the prompt going out re-takes the line (#202), while merely
        // re-entering the channel does not (#179, the re-entry spec above).
        let dir = temp("between");
        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();

        write(&dir, "mine.md", "edited by hand between turns");
        turn_start(&shots, &dir).unwrap();
        write(&dir, "report.md", "the turn's own work");

        assert_eq!(
            paths(&offer(&shots, &dir).unwrap().files),
            vec!["report.md"]
        );
    }
}

#[cfg(test)]
mod bound_folder_tests {
    use super::*;
    use std::io::Write;

    /// The claim this card rests on, against a real repository rather than a
    /// parsed string: a build's output is invisible and the work is not.
    #[test]
    fn a_build_in_a_bound_repository_is_not_offered_as_work() {
        let dir = std::env::temp_dir().join(format!("wr-bound-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/left-pad")).unwrap();

        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        run(&["init", "-q", "."]);
        run(&["config", "user.email", "a@b"]);
        run(&["config", "user.name", "a"]);
        fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-qm", "init"]);

        // A turn: the agent writes a report, edits a file, and something
        // installs three thousand things nobody asked to publish.
        fs::write(dir.join("report.md"), "findings").unwrap();
        let mut f = fs::File::options()
            .append(true)
            .open(dir.join("src/main.rs"))
            .unwrap();
        f.write_all(b"\n// and this\n").unwrap();
        for i in 0..50 {
            fs::write(dir.join(format!("node_modules/left-pad/{i}.js")), "junk").unwrap();
        }

        let mut produced = git_changes(&dir).expect("a repository answers");
        produced.sort();

        assert_eq!(produced, vec!["report.md", "src/main.rs"]);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod commit_aware_offer_tests {
    //! The turn that *commits* (#206). A commit empties the porcelain set, so
    //! without a head on the line the offer would say such a turn did nothing.
    //! Real repositories, the way the line is really taken: origin/HEAD is
    //! written directly rather than fetched, because what matters is the
    //! reading — which branch the mainline is — not the fetch.

    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-commit-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    /// A repository on `main`, with origin/HEAD naming main as the mainline.
    fn repository(name: &str) -> PathBuf {
        let dir = temp(name);
        run(&dir, &["init", "-q", "-b", "main", "."]);
        run(&dir, &["config", "user.email", "a@b"]);
        run(&dir, &["config", "user.name", "a"]);
        write(&dir, "src.rs", "fn main() {}");
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-qm", "init"]);
        run(
            &dir,
            &[
                "remote",
                "add",
                "origin",
                "https://example.test/acme/widgets.git",
            ],
        );
        let sha = String::from_utf8_lossy(
            &std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&dir)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        run(&dir, &["update-ref", "refs/remotes/origin/main", &sha]);
        run(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        dir
    }

    #[test]
    fn a_turn_that_commits_is_offered_as_a_commit_not_as_files() {
        let dir = repository("commits");
        run(&dir, &["checkout", "-qb", "agent/weekly-notes"]);
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();

        write(&dir, "notes.md", "findings\n");
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-qm", "the turn's work"]);

        let got = offer(&shots, &dir).unwrap();

        let committed = got.committed.expect("a turn that committed says so");
        assert_eq!(committed.branch, "agent/weekly-notes");
        assert_eq!(committed.commits, 1);
        assert!(
            committed.stat.contains("1 file changed"),
            "{}",
            committed.stat
        );
        assert!(!committed.on_default, "an agent branch is not the mainline");
        assert!(
            got.files.is_empty(),
            "committed files left the porcelain set; offering them too would count them twice"
        );
    }

    #[test]
    fn a_turn_that_only_dirties_is_offered_as_files_with_no_commit() {
        let dir = repository("dirties");
        run(&dir, &["checkout", "-qb", "agent/weekly-notes"]);
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();

        write(&dir, "report.md", "findings\n");

        let got = offer(&shots, &dir).unwrap();

        assert!(got.committed.is_none());
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].path, "report.md");
    }

    #[test]
    fn a_turn_committing_onto_the_mainline_is_marked_on_default() {
        let dir = repository("on-main");
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();

        write(&dir, "hotfix.rs", "fn hotfix() {}\n");
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-qm", "straight onto main"]);

        let got = offer(&shots, &dir).unwrap();

        let committed = got.committed.expect("the commit is the turn's work");
        assert_eq!(committed.branch, "main");
        assert!(
            committed.on_default,
            "the one offer a person must read as shipping-adjacent"
        );
    }

    #[test]
    fn a_commit_from_an_older_line_counts_every_commit_since() {
        let dir = repository("several");
        run(&dir, &["checkout", "-qb", "agent/weekly-notes"]);
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();

        for i in 1..=2 {
            write(&dir, &format!("part-{i}.md"), "more\n");
            run(&dir, &["add", "-A"]);
            run(&dir, &["commit", "-qm", "part"]);
        }

        let got = offer(&shots, &dir).unwrap();

        let committed = got.committed.expect("two commits are two");
        assert_eq!(committed.commits, 2);
        assert!(
            committed.stat.contains("2 files changed"),
            "{}",
            committed.stat
        );
    }
}

#[cfg(test)]
mod human_changes_tests {
    //! The person's work, seen from outside the run (#207). The line is the
    //! turn's; everything past it is the person's, and reading it never moves
    //! the line.

    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-human-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    fn repository(name: &str) -> PathBuf {
        let dir = temp(name);
        run(&dir, &["init", "-q", "-b", "main", "."]);
        run(&dir, &["config", "user.email", "a@b"]);
        run(&dir, &["config", "user.name", "a"]);
        write(&dir, "src.rs", "fn main() {}");
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn only_work_past_the_line_counts_as_the_persons() {
        let dir = repository("past-the-line");
        write(&dir, "before.md", "dirty before the line");
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();

        write(&dir, "after.md", "written after the line");

        let got = human_changes(&shots, &dir).unwrap();
        let paths: Vec<&str> = got.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["after.md"],
            "the line's own dirt is the turn's baseline, not a change"
        );
        assert!(got.is_repo);
        assert_eq!(got.branch.as_deref(), Some("main"));
    }

    #[test]
    fn without_a_line_everything_dirty_counts() {
        let dir = repository("no-line");
        write(&dir, "one.md", "x");
        write(&dir, "two.md", "y");
        let shots = Workspaces::default();

        let got = human_changes(&shots, &dir).unwrap();

        assert_eq!(
            got.files.len(),
            2,
            "nothing was ever measured, so nothing is excluded"
        );
    }

    #[test]
    fn reading_changes_never_moves_the_line() {
        let dir = repository("read-only");
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();
        write(&dir, "work.md", "x");

        human_changes(&shots, &dir).unwrap();
        let again = human_changes(&shots, &dir).unwrap();

        assert_eq!(
            again.files.len(),
            1,
            "a gate that consumed what it saw would stop gating"
        );
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_not_gated_but_is_listed() {
        // The gate never fires here — `is_repo` is the client's signal for
        // that — but the files are named all the same: the review dialog is
        // the upgrade path, and "make it a git repo" starts by showing what
        // would gain a history (#207 part B).
        let dir = temp("plain");
        write(&dir, "notes.md", "x");
        let shots = Workspaces::default();

        let got = human_changes(&shots, &dir).unwrap();

        assert!(!got.is_repo);
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].path, "notes.md");
    }

    #[test]
    fn a_stash_sets_the_work_aside_where_it_can_be_brought_back() {
        let dir = repository("stashed");
        let shots = Workspaces::default();
        turn_start(&shots, &dir).unwrap();
        write(&dir, "wip.md", "half a thought");

        stash(&dir).unwrap();

        let after = human_changes(&shots, &dir).unwrap();
        assert!(after.files.is_empty(), "stashed work is out of the tree");
        let list = std::process::Command::new("git")
            .args(["stash", "list"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let list = String::from_utf8_lossy(&list.stdout);
        assert!(list.contains("workroom: human changes"), "{list}");
    }

    #[test]
    fn a_stash_with_nothing_to_stash_is_not_an_error() {
        let dir = repository("nothing-to-stash");

        stash(&dir).unwrap();
    }

    #[test]
    fn init_makes_a_plain_folder_a_repository_the_gate_can_read() {
        let dir = temp("becomes-a-repo");
        write(&dir, "notes.md", "x");
        let shots = Workspaces::default();
        assert!(!human_changes(&shots, &dir).unwrap().is_repo);

        git_init(&dir).unwrap();
        git_init(&dir).unwrap(); // idempotent: asking twice is not an error

        assert!(human_changes(&shots, &dir).unwrap().is_repo);
    }
}

#[cfg(test)]
mod review_dialog_tests {
    //! What the review dialog shows and does (#207 part B): one file's
    //! changes, and a commit of exactly the paths the person confirmed.

    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-review-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    fn repository(name: &str) -> PathBuf {
        let dir = temp(name);
        run(&dir, &["init", "-q", "-b", "main", "."]);
        run(&dir, &["config", "user.email", "a@b"]);
        run(&dir, &["config", "user.name", "a"]);
        write(&dir, "src.rs", "fn main() {}\n");
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn a_tracked_files_diff_is_the_worktree_against_the_index() {
        let dir = repository("diff");
        write(&dir, "src.rs", "fn main() {}\nfn more() {}\n");

        let diff = file_diff(&dir, "src.rs").unwrap();

        assert!(diff.contains("+fn more() {}"), "{diff}");
        assert!(diff.contains("src.rs"), "{diff}");
    }

    #[test]
    fn an_untracked_file_is_shown_as_new_with_its_content_capped() {
        let dir = repository("new-file");
        let body = (1..=250)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        write(&dir, "notes.md", &body);

        let diff = file_diff(&dir, "notes.md").unwrap();

        assert!(diff.contains("new file"), "{diff}");
        assert!(diff.contains("line 1"));
        assert!(diff.contains("line 200"));
        assert!(!diff.contains("line 201"), "capped, with the cap said");
        assert!(diff.contains("200"), "the note says how much was shown");
    }

    #[test]
    fn a_path_outside_the_folder_is_not_reviewed() {
        let dir = repository("escape");
        let outside = temp("outside");
        write(&outside, "secret.md", "token");

        let error = file_diff(&dir, "../wr-review-escape-does-not-matter").unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn a_commit_lands_exactly_the_confirmed_paths_and_names_its_sha() {
        let dir = repository("commit");
        write(&dir, "one.md", "reviewed\n");
        write(&dir, "two.md", "not reviewed yet\n");

        let sha = commit(&dir, &["one.md".to_string()], "Manual edits by Alice").unwrap();

        assert_eq!(sha.len(), 7, "a short sha, {sha}");
        let status = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(
            status.contains("two.md"),
            "the unconfirmed file is still dirty: {status}"
        );
        assert!(
            !status.contains("one.md"),
            "the confirmed file is committed: {status}"
        );
        let log = std::process::Command::new("git")
            .args(["log", "-1", "--format=%s"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "Manual edits by Alice"
        );
    }

    #[test]
    fn a_commit_without_an_identity_reports_gits_own_words() {
        // No config is ever written: whose name goes on the commit is the
        // machine's git configuration, and its absence is git's sentence.
        let dir = temp("no-identity");
        run(&dir, &["init", "-q", "."]);
        run(&dir, &["config", "user.name", ""]);
        run(&dir, &["config", "user.email", ""]);
        write(&dir, "one.md", "x");

        let error = commit(&dir, &["one.md".to_string()], "x").unwrap_err();

        assert!(!error.is_empty());
        let log = std::process::Command::new("git")
            .args(["log", "--format=%s"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(!log.status.success(), "no commit was made");
    }
}

/// One file of the room's mirror, as the client rendered it (#220).
#[derive(serde::Deserialize)]
pub struct MirrorFile {
    pub path: String,
    pub body: String,
    #[serde(default)]
    pub base64: bool,
}

/// The sentence spike #45 requires, word for word.
const MIRROR_README: &str =
    "This is a snapshot of the room; edits here do not survive — write to the channel instead.\n";

/// Write the room's mirror under `<dir>/.workroom/` (#220). One-way and only
/// inside the mirror, whatever a row says its name is: a path that steps out —
/// `..`, an absolute component, a prefix — is refused whole, because a mirror
/// that can write one file outside itself is not a mirror.
pub fn write_mirror(dir: &Path, files: &[MirrorFile]) -> Result<usize, String> {
    use base64::Engine as _;

    let root = dir.join(".workroom");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::write(root.join("README.md"), MIRROR_README).map_err(|e| e.to_string())?;

    let mut written = 0;
    for file in files {
        let rel = Path::new(&file.path);
        if rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(format!(
                "refusing a path that leaves the mirror: {}",
                file.path
            ));
        }
        let target = root.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = if file.base64 {
            base64::engine::general_purpose::STANDARD
                .decode(file.body.as_bytes())
                .map_err(|e| e.to_string())?
        } else {
            file.body.clone().into_bytes()
        };
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod mirror_tests {
    //! The journal as files inside the channel's folder (#220): written where
    //! it belongs, refused where it does not, and saying what it is.

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-mirror-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(path: &str) -> MirrorFile {
        MirrorFile {
            path: path.into(),
            body: "---\nseq: 1\n---\n\n# Cadence\n".into(),
            base64: false,
        }
    }

    #[test]
    fn the_mirror_lands_under_workroom_and_says_what_it_is() {
        let dir = temp("plain");

        let written = write_mirror(&dir, &[entry("journal/00001-memory.md")]).unwrap();

        assert_eq!(written, 1);
        let readme = fs::read_to_string(dir.join(".workroom/README.md")).unwrap();
        assert!(
            readme.contains("edits here do not survive"),
            "the spike's sentence, or the mirror invites edits it will discard"
        );
        assert!(dir.join(".workroom/journal/00001-memory.md").exists());
    }

    #[test]
    fn a_path_that_leaves_the_mirror_is_refused_whole() {
        let dir = temp("escape");

        let err = write_mirror(&dir, &[entry("../outside.md")]).unwrap_err();

        assert!(err.contains("leaves the mirror"), "{err}");
        assert!(!dir.join("outside.md").exists());
        assert!(!dir.parent().unwrap().join("outside.md").exists());
    }

    #[test]
    fn artifact_bytes_travel_base64_and_land_as_bytes() {
        use base64::Engine as _;
        let dir = temp("bytes");
        let file = MirrorFile {
            path: "artifacts/chart.png".into(),
            body: base64::engine::general_purpose::STANDARD.encode([0x89, 0x50, 0x4e, 0x47]),
            base64: true,
        };

        write_mirror(&dir, &[file]).unwrap();

        assert_eq!(
            fs::read(dir.join(".workroom/artifacts/chart.png")).unwrap(),
            vec![0x89, 0x50, 0x4e, 0x47]
        );
    }
}
