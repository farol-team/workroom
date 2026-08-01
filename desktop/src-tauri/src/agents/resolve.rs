//! Specs for what Rust alone can answer: where a command resolves, what an
//! install runs, and where an install is allowed to write.
//!
//! Written before the module they cover (#131, phase A). The functions under
//! test arrive with the implementation; until then this file is the failing
//! test that demands them.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A directory of this test's own, on the real filesystem — resolution is
    /// about what is on disk, and a stubbed filesystem would prove nothing.
    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wr-resolve-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A file somebody could actually run.
    fn executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn a_command_installed_where_path_does_not_look_is_still_found() {
        // The whole reason this exists. A person who installed node with a
        // version manager has an npm bin directory the app's inherited PATH
        // does not carry, and reporting their agent as missing is a guess
        // contradicted by their disk.
        let dir = temp("extra");
        let binary = executable(&dir, "wr-fake-agent-acp");

        assert_eq!(
            resolve_command("wr-fake-agent-acp", &[dir.clone()]),
            Some(binary)
        );
    }

    #[test]
    fn a_command_on_path_is_found_without_any_extra_directory() {
        assert!(resolve_command("sh", &[]).is_some());
    }

    #[test]
    fn a_command_that_is_nowhere_is_none_rather_than_a_guess() {
        assert_eq!(resolve_command("wr-agent-nobody-installed", &[temp("empty")]), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_be_run_is_not_a_command() {
        // A leftover README named like the binary would otherwise report an
        // agent as available, and the failure would arrive at spawn time in a
        // room somebody was working in.
        let dir = temp("not-executable");
        fs::write(dir.join("wr-fake-agent-acp"), "notes").unwrap();

        assert_eq!(resolve_command("wr-fake-agent-acp", &[dir]), None);
    }

    #[test]
    fn the_first_directory_offered_wins() {
        // Which is how the prefix WorkRoom installed into takes precedence over
        // whatever else on the machine answers to the same name: it is passed
        // ahead of the rest.
        let managed = temp("managed");
        let elsewhere = temp("elsewhere");
        let theirs = executable(&managed, "wr-fake-agent-acp");
        executable(&elsewhere, "wr-fake-agent-acp");

        assert_eq!(
            resolve_command("wr-fake-agent-acp", &[managed, elsewhere]),
            Some(theirs)
        );
    }

    #[test]
    fn the_augmented_list_covers_where_people_actually_install_things() {
        let dirs: Vec<String> = augmented_dirs()
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        let has = |needle: &str| dirs.iter().any(|d| d.contains(needle));

        assert!(has("/opt/homebrew/bin"), "homebrew on apple silicon: {dirs:?}");
        assert!(has("/usr/local/bin"), "homebrew on intel, and much else: {dirs:?}");
        assert!(has(".local/bin"), "pip and pipx: {dirs:?}");
        assert!(has(".volta/bin"), "volta: {dirs:?}");
        assert!(has("mise"), "mise shims: {dirs:?}");
        assert!(has("asdf"), "asdf shims: {dirs:?}");
    }

    #[test]
    fn installing_the_adapter_writes_where_workroom_can_clean_up_after_itself() {
        // The person's own global npm prefix is theirs. An install that writes
        // into it changes a version they may have chosen, and leaves something
        // behind that uninstalling WorkRoom cannot take back.
        let prefix = temp("npm");
        let command = npm_install_command(&prefix, "@agentclientprotocol/claude-agent-acp");

        let at = command.iter().position(|a| a == "--prefix").expect("must name a prefix");
        assert_eq!(command[at + 1], prefix.to_string_lossy());
        assert_eq!(command.first().map(String::as_str), Some("npm"));
        assert!(command.iter().any(|a| a == "install"));
        assert!(command.iter().any(|a| a == "-g" || a == "--global"));
        assert_eq!(
            command.last().map(String::as_str),
            Some("@agentclientprotocol/claude-agent-acp")
        );
    }

    #[test]
    fn the_package_is_one_argument_that_no_shell_reads() {
        let command = npm_install_command(Path::new("/tmp/wr/npm"), "@zed-industries/codex-acp");

        assert!(command.iter().any(|a| a == "@zed-industries/codex-acp"));
        assert!(
            !command.iter().any(|a| a.contains('"') || a.contains('\'')),
            "quotes belong to a shell, and there is no shell here: {command:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_step_that_fails_stops_the_sequence_and_says_what_the_command_said() {
        // The failure a person reads is the one their command printed. A generic
        // message sends them to look for a problem nobody reported, and a step
        // that runs after a failed one installs an adapter for a CLI that is
        // not there.
        let dir = temp("steps");
        let marker = dir.join("third-ran");
        let steps = vec![
            format!("echo installing > {}/first", dir.display()),
            "echo 'npm ERR! code E404' >&2; exit 3".to_string(),
            format!("touch {}", marker.display()),
        ];

        let done = run_steps(&steps);

        assert_eq!(done.len(), 2, "the sequence stops where it failed: {done:?}");
        assert!(done[0].ok);
        assert!(!done[1].ok);
        assert_eq!(done[1].code, Some(3));
        assert!(done[1].stderr_tail.contains("npm ERR! code E404"));
        assert!(!marker.exists(), "a step after a failure must not run");
    }

    #[cfg(unix)]
    #[test]
    fn each_step_carries_its_own_output_and_its_own_name() {
        // Never another command's. A message that mixes them names a package
        // the person was not installing.
        let steps = vec![
            "echo first-said-this".to_string(),
            "echo second-said-this; exit 1".to_string(),
        ];

        let done = run_steps(&steps);

        assert_eq!(done[0].command, "echo first-said-this");
        assert!(done[0].stdout_tail.contains("first-said-this"));
        assert!(done[1].stdout_tail.contains("second-said-this"));
        assert!(!done[1].stdout_tail.contains("first-said-this"));
    }

    #[cfg(unix)]
    #[test]
    fn every_step_of_a_sequence_that_works_is_reported() {
        let done = run_steps(&["true".to_string(), "true".to_string()]);

        assert_eq!(done.len(), 2);
        assert!(done.iter().all(|s| s.ok));
        assert!(done.iter().all(|s| s.code == Some(0)));
    }
}
