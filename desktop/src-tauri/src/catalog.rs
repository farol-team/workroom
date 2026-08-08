//! The agent catalogue the window shows, rendered from the one the client uses.
//!
//! The table lives in `acp-agents`, shared with the other products that reach a
//! local agent the same way. The panel needs it synchronously — it is drawn
//! before anything has been invoked — so it is *generated* into TypeScript
//! rather than fetched, and the spec below fails when the two drift apart.
//!
//! Regenerate with `UPDATE_CATALOG=1 cargo test` in this directory. Editing the
//! generated file by hand is how the two answers to "what is Claude Code
//! called" came to disagree in the first place.

/// Where the generated module lands, relative to this crate.
const GENERATED: &str = "../src/agents/generated.ts";

/// The TypeScript for what this application offers to install.
///
/// Only agents with a package: the panel's whole job is a button, and an agent
/// this project cannot fetch has nothing behind one. Cursor is in the shared
/// table and not here for exactly that reason.
pub(crate) fn rendered() -> String {
    let mut out = String::from(
        "// Generated from acp-agents::HARNESSES. Do not edit.\n\
         //\n\
         // The table lives in farol-team/acp-agents, with the other products that\n\
         // run a local agent over ACP. Change it there, then regenerate with\n\
         // `UPDATE_CATALOG=1 cargo test` in desktop/src-tauri.\n\
         //\n\
         // Only agents this application can fetch appear here: the panel's whole\n\
         // job is a button, and an agent with no package has nothing behind one.\n\n\
         import type { AgentProfile } from \"./catalog\";\n\n\
         export const BASELINE: AgentProfile[] = [\n",
    );
    for harness in acp_agents::HARNESSES {
        let Some(package) = harness.package else {
            continue;
        };
        let (command, args) = harness.command();
        let args = match args {
            [] => String::new(),
            args => format!(
                " {} ",
                args.iter()
                    .map(|a| format!("\"{a}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        };
        out.push_str(&format!(
            "  {{\n    name: \"{}\", label: \"{}\", command: \"{}\", args: [{}],\n    \
             package: \"{}\",\n    docsUrl: \"{}\",\n  }},\n",
            harness.id, harness.name, command, args, package, harness.docs_url,
        ));
    }
    out.push_str("];\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(GENERATED)
    }

    /// The window and the client must not have two answers to what an agent is
    /// called or which package it comes from. Anything else is a support
    /// ticket that reads "it says Claude Code is installed and it is not".
    #[test]
    fn the_typescript_catalogue_is_the_crates_own() {
        let rendered = rendered();
        if std::env::var("UPDATE_CATALOG").is_ok() {
            std::fs::write(path(), &rendered).expect("the generated module is writable");
            return;
        }

        let on_disk = std::fs::read_to_string(path()).unwrap_or_default();
        assert_eq!(
            on_disk, rendered,
            "src/agents/generated.ts has drifted from the shared table. \
             Regenerate: UPDATE_CATALOG=1 cargo test"
        );
    }

    /// What the generated module is for, said in one place: a person presses a
    /// button, and what runs is `npm install -g --prefix <ours> <package>`.
    #[test]
    fn every_offered_agent_names_the_package_a_press_would_fetch() {
        let rendered = rendered();
        for harness in acp_agents::HARNESSES {
            match harness.package {
                Some(package) => assert!(
                    rendered.contains(package),
                    "{} can be installed and is not offered",
                    harness.id
                ),
                // Nothing to fetch, so nothing to draw a button for.
                None => assert!(
                    !rendered.contains(&format!("name: \"{}\"", harness.id)),
                    "{} is offered with no package behind the button",
                    harness.id
                ),
            }
        }
    }
}
