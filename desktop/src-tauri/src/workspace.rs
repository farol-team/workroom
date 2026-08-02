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
/// porcelain path set; anywhere else it is a filesystem snapshot. Taken when
/// a turn begins, so work the person's hands got to first is never offered
/// as the run's (#202).
pub enum Baseline {
    Git(std::collections::HashSet<String>),
    Fs(Snapshot),
}

/// Measure a directory the way a turn start needs it measured.
fn measure(dir: &Path) -> Baseline {
    match git_changes(dir) {
        Some(changed) => Baseline::Git(changed.into_iter().collect()),
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

/// What a turn's offer is made of: the files, and how many changed paths
/// were held back because they were dirty before the turn began.
#[derive(serde::Serialize)]
pub struct TurnProduced {
    pub files: Vec<Produced>,
    pub pre_existing: usize,
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
        let mut state = shots
            .0
            .lock()
            .map_err(|_| "workspace state is poisoned".to_string())?;
        let (paths, pre_existing) = match state.get(dir) {
            Some(Baseline::Git(line)) => turn_delta(&changed, line),
            // No line, or one taken before this folder was a repository:
            // the whole porcelain answer, as before.
            _ => (changed.clone(), 0),
        };
        state.insert(
            dir.to_path_buf(),
            Baseline::Git(changed.into_iter().collect()),
        );
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
    })
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
    // origin/HEAD names the mainline only once somebody has fetched; before
    // that the checkout's own branch is the best answer there is. Asked with
    // symbolic-ref rather than rev-parse: a repository with no commits yet
    // still has an unborn branch, and rev-parse cannot name one. A detached
    // HEAD answers neither, which is correct — it is not a branch.
    let default_branch = git_answer(
        dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .map(|head| head.trim_start_matches("origin/").to_string())
    .or_else(|| git_answer(dir, &["symbolic-ref", "--short", "HEAD"]));

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
