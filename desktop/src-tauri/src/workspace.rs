//! Where a session works, and what it produced there.
//!
//! The directory is derived from who is working, with which agent, in which
//! channel — never chosen by the agent. An agent that could name its own
//! working directory could name someone else's.

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

/// A person, an agent, and a channel each get their own directory. Two channels
/// never share one, and neither do two agents in the same channel.
pub fn workspace_path(root: &Path, user: &str, agent: &str, channel: &str) -> PathBuf {
    root.join(segment(user))
        .join(segment(agent))
        .join(segment(channel))
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

/// The snapshots taken when each session's directory was opened, so what a run
/// produced can be told from what was already there.
#[derive(Default)]
pub struct Workspaces(pub std::sync::Mutex<HashMap<PathBuf, Snapshot>>);

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
    fn each_person_agent_and_channel_gets_its_own_directory() {
        let root = Path::new("/data");
        assert_eq!(
            workspace_path(root, "alice", "opencode", "meetings"),
            PathBuf::from("/data/alice/opencode/meetings")
        );
        assert_ne!(
            workspace_path(root, "alice", "opencode", "meetings"),
            workspace_path(root, "alice", "claude", "meetings"),
        );
        assert_ne!(
            workspace_path(root, "alice", "opencode", "meetings"),
            workspace_path(root, "bob", "opencode", "meetings"),
        );
    }

    #[test]
    fn a_name_cannot_climb_out_of_its_directory() {
        // The channel slug arrives from the server, and the agent name from a
        // file the person edits. Neither may become a path.
        let root = Path::new("/data");
        let escaped = workspace_path(root, "alice", "opencode", "../../.ssh");

        assert!(escaped.starts_with("/data/alice/opencode"), "{escaped:?}");
        assert_eq!(escaped.components().count(), 5);
        assert_eq!(
            workspace_path(root, "..", "..", ".."),
            PathBuf::from("/data/unnamed/unnamed/unnamed"),
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

        let mut both = paths(&first);
        both.extend(paths(&second));
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

        assert_eq!(paths(&files), vec!["late.md"]);
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

        assert_eq!(paths(&offer(&shots, &dir).unwrap()), vec!["report.md"]);
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

        assert_eq!(paths(&offer(&shots, &dir).unwrap()), vec!["new.md"]);
    }

    #[test]
    fn what_was_offered_once_is_not_offered_again() {
        let dir = temp("twice");
        let shots = Workspaces::default();
        baseline(&shots, &dir).unwrap();
        write(&dir, "report.md", "findings");

        assert_eq!(paths(&offer(&shots, &dir).unwrap()), vec!["report.md"]);
        assert!(
            offer(&shots, &dir).unwrap().is_empty(),
            "the next turn is measured from where the last one ended"
        );
    }

    #[test]
    fn a_bound_repository_is_still_answered_by_git() {
        // The line does not apply to somebody's real repository: git already
        // knows what changed there, by their ignore rules rather than ours.
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

        assert_eq!(paths(&offer(&shots, &dir).unwrap()), vec!["report.md"]);
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
