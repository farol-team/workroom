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
