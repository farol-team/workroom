//! Where a bare command becomes the path this application runs (#241).
//!
//! Everything here consumes std and nothing of tauri's: the `AppHandle`
//! stays in lib.rs with the two one-line wrappers that hold it, so the
//! whole of the resolution order stays reachable from a spec (#279).

/// How long the person's shell has to answer. An rc file that blocks — a
/// network drive that is not there, a prompt nobody will answer — must not
/// become an application that does not start.
const SHELL_ANSWERS_WITHIN: std::time::Duration = std::time::Duration::from_secs(2);

/// The directories this application looks in, and runs an install with.
///
/// Not the ones this process was handed. An application opened from the Dock or
/// Finder inherits the system's own short PATH, and no profile is read for it —
/// while Node arrives on people's machines through nvm and Homebrew, which are
/// on neither. Under `pnpm tauri dev` the terminal's environment is the app's
/// environment and none of this shows, which is exactly the shape of bug #120
/// named: behaving one way where it is written and another where it is used.
///
/// Asked once. A machine does not change its shell configuration under a
/// running window, and asking on every probe would pay a shell start-up for
/// each row of the panel.
pub(crate) fn user_path() -> &'static Vec<std::path::PathBuf> {
    static PATH: std::sync::OnceLock<Vec<std::path::PathBuf>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let given: Vec<std::path::PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        match asked_of_the_persons_shell() {
            Some(said) => merged_path(given, &said),
            None => given,
        }
    })
}

/// What the person's own shell says their PATH is.
///
/// Login **and** interactive: Homebrew writes itself into the file only a login
/// shell reads and nvm into the one only an interactive shell reads, so asking
/// for either alone answers on half the machines.
///
/// `None` for anything that is not an answer — no shell to ask, a shell that
/// failed, a shell still thinking. Windows is `None` by design: `cmd /C` is
/// started with the person's own environment already.
fn asked_of_the_persons_shell() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").ok()?;

    let (said, heard) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let answer = std::process::Command::new(&shell)
            .args(["-lic", "printf %s \"$PATH\""])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
        let _ = said.send(answer);
    });

    // A shell that has not answered by now is one this application stops
    // waiting for. The child is left to finish on its own and its answer is
    // dropped — the alternative is a window that never opens.
    heard.recv_timeout(SHELL_ANSWERS_WITHIN).ok().flatten()
}

/// What the shell said, folded into what this process already had.
///
/// The last line, because an rc file greets people and warns them about flags
/// before anything is printed on purpose. Absolute directories only, because a
/// shell that failed prints its error and fish prints its PATH space-separated
/// — neither is a set of directories, and the pieces would sit in front of
/// every lookup this application makes.
fn merged_path(given: Vec<std::path::PathBuf>, said: &str) -> Vec<std::path::PathBuf> {
    let answer = said
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default();

    let mut seen: std::collections::HashSet<std::path::PathBuf> = given.iter().cloned().collect();
    let mut merged = given;
    for dir in std::env::split_paths(answer) {
        if dir.is_absolute() && seen.insert(dir.clone()) {
            merged.push(dir);
        }
    }
    merged
}

/// Those directories as a child process is given them. A list that cannot be
/// joined — a directory with a separator in its name — leaves the child with
/// what this process has, which is what it had before any of this.
pub(crate) fn path_env(dirs: &[std::path::PathBuf]) -> std::ffi::OsString {
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// The directories a bare command is looked for in, in the order this
/// application trusts them: the prefix `agent_install` fetches into — which is
/// `npm/bin` under the app data directory, because that is where
/// `npm install --prefix` leaves what it installed — and then whatever is on
/// the person's own PATH. Somebody naming an agent they already have means
/// that one, and this must not take it away from them.
///
/// Two, and the same two under `pnpm tauri dev` as in a shipped build. A
/// directory that exists only on one of those is a client that behaves one way
/// where it is written and another way where it is used.
pub(crate) fn directories(
    app_data: Option<std::path::PathBuf>,
    on_path: Vec<std::path::PathBuf>,
) -> Vec<std::path::PathBuf> {
    app_data
        .map(|dir| dir.join("npm").join("bin"))
        .into_iter()
        .chain(on_path)
        .collect()
}

/// Where that command would be in each of them.
///
/// A command given as a path is that path and nothing else: it is the one place
/// somebody has said exactly what they mean, and looking up its last segment
/// would run something they did not name.
pub(crate) fn candidates(command: &str, dirs: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return vec![std::path::PathBuf::from(command)];
    }
    dirs.into_iter().map(|dir| dir.join(command)).collect()
}

/// The first of those that is really there.
pub(crate) fn found(places: &[std::path::PathBuf]) -> Option<String> {
    places
        .iter()
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Where the command is, or the name as it was typed — an agent this side
/// cannot find is still worth trying to spawn, and the error it gives is the
/// person's to read.
pub(crate) fn located(command: &str, places: &[std::path::PathBuf]) -> String {
    found(places).unwrap_or_else(|| command.to_string())
}

#[cfg(test)]
mod resolution {
    use super::*;
    // `tail` and its budget stay in lib.rs — they trim what an install said,
    // which is not resolution — but the two specs that pin them were written
    // into this suite and travel with it.
    use crate::{tail, TAIL};
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

    /// A machine, as this side is given one: the app data directory and the
    /// person's own PATH. Everything below goes through the same chain the
    /// running application builds — a test that hands `found` a list it ordered
    /// itself asserts only that the list it wrote is in the order it wrote it.
    fn chain(command: &str, data: Option<&Path>, on_path: Vec<PathBuf>) -> Vec<PathBuf> {
        candidates(command, directories(data.map(Path::to_path_buf), on_path))
    }

    #[test]
    fn our_own_prefix_is_looked_in_before_the_path_and_is_the_only_one_we_add() {
        // Pinned by where it is and where it sits. `npm install --prefix P` puts
        // its binaries in `P/bin`, so anything else here is a directory nothing
        // will ever be found in — and there is no third place, because this
        // application no longer carries an agent of its own (#120).
        let dirs = directories(
            Some(PathBuf::from("/data")),
            vec![PathBuf::from("/usr/local/bin")],
        );

        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/data/npm/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn an_agent_in_our_own_prefix_is_found_though_it_is_not_on_path() {
        // What `agent_install` fetches goes into a directory this application
        // owns and nothing else on the machine knows about. Not looking there
        // means an agent somebody just installed still reads as missing.
        let data = temp("own-data");
        let elsewhere = temp("their-path");
        let installed = binary(&installed_in(&data), "opencode");

        assert_eq!(
            found(&chain("opencode", Some(&data), vec![elsewhere])),
            Some(installed.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn the_default_adapter_is_found_the_same_way_as_any_other() {
        // Nothing about `claude-agent-acp` is special to this side: it is not
        // carried, not looked for anywhere the others are not, and reads as
        // missing until somebody installs it.
        let data = temp("default-adapter");
        let empty = temp("nothing-here");

        assert_eq!(found(&chain("claude-agent-acp", Some(&data), vec![])), None);

        let installed = binary(&installed_in(&data), "claude-agent-acp");
        assert_eq!(
            found(&chain("claude-agent-acp", Some(&data), vec![empty])),
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
            found(&chain("opencode", Some(&data), vec![theirs])),
            Some(already.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn a_command_nobody_has_is_left_as_it_was_typed() {
        // A person naming their own agent means the one they have, and this
        // must not take that away from them by answering for it.
        let data = temp("nothing-installed");
        let nowhere = temp("nowhere");
        let looked = chain("kimi-acp", Some(&data), vec![nowhere]);

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

/// The PATH a person has, which is not the one this process was handed (#240).
///
/// An application opened from the Dock or Finder inherits the system's own
/// short PATH and no profile is read for it. Node arrives on people's machines
/// through nvm and Homebrew, neither of which is on that PATH, so the press
/// that installs an agent answers `npm: not found` on a machine where `npm`
/// answers perfectly well in a terminal.
///
/// The shell is asked once and can only add: what this process was given keeps
/// its place, because a machine whose shell cannot be asked has to behave as it
/// does today rather than worse.
#[cfg(test)]
mod the_path_a_person_has {
    use super::*;
    use std::path::PathBuf;

    fn dirs(raw: &[&str]) -> Vec<PathBuf> {
        raw.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn what_this_process_was_given_keeps_its_place_and_the_shell_only_adds() {
        let merged = merged_path(
            dirs(&["/usr/bin", "/bin"]),
            "/opt/homebrew/bin:/usr/bin:/bin:/Users/alice/.nvm/versions/node/v22/bin",
        );

        assert_eq!(
            merged,
            dirs(&[
                "/usr/bin",
                "/bin",
                "/opt/homebrew/bin",
                "/Users/alice/.nvm/versions/node/v22/bin",
            ])
        );
    }

    #[test]
    fn a_directory_this_process_already_had_is_not_added_twice() {
        // The lists overlap almost entirely — the system directories are in
        // both. A PATH that repeats them is longer to walk and reads as though
        // something went wrong.
        let merged = merged_path(dirs(&["/usr/bin"]), "/usr/bin:/usr/bin:/opt/homebrew/bin");

        assert_eq!(merged, dirs(&["/usr/bin", "/opt/homebrew/bin"]));
    }

    #[test]
    fn a_shell_that_said_nothing_leaves_the_path_exactly_as_it_was() {
        // A shell that is not there, one that timed out, one that printed a
        // blank line: three ways of answering nothing, and none of them is a
        // reason to change where this application looks.
        let given = dirs(&["/usr/bin", "/bin"]);

        assert_eq!(merged_path(given.clone(), ""), given);
        assert_eq!(merged_path(given.clone(), "  \n \n"), given);
    }

    #[test]
    fn the_answer_is_the_last_line_because_a_profile_prints_its_own() {
        // Somebody's rc file greets them, or warns about a deprecated flag.
        // Taking the first line takes the greeting and loses the PATH.
        let merged = merged_path(
            dirs(&["/usr/bin"]),
            "Welcome back, Alice\nnvm: using node v22\n/opt/homebrew/bin:/usr/bin\n",
        );

        assert_eq!(merged, dirs(&["/usr/bin", "/opt/homebrew/bin"]));
    }

    #[test]
    fn what_a_shell_says_is_only_believed_when_it_looks_like_a_path() {
        // fish keeps PATH as a list and prints it space-separated; a shell that
        // fails prints its own error. Neither is a set of directories, and
        // adding the pieces would put nonsense in front of every lookup.
        let given = dirs(&["/usr/bin"]);

        assert_eq!(
            merged_path(given.clone(), "command not found: printf"),
            given
        );
    }

    #[test]
    fn an_install_runs_with_the_path_the_person_has() {
        // The one that matters. `npm` is found by the shell this application
        // starts, so the directories have to be in that shell's environment —
        // the same list the probe walks, in the same order.
        let joined = path_env(&dirs(&["/usr/bin", "/opt/homebrew/bin"]));

        assert_eq!(joined.to_string_lossy(), "/usr/bin:/opt/homebrew/bin");
    }
}
