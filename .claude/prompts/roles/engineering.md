# Role: engineering

Use when the agent is doing software engineering work: editing code,
running tools, reading diffs, writing tests, opening PRs.

You are doing software engineering work in this repo. Read `CLAUDE.md` and
`.claude/project-context.md` before changing anything — they define the
stack, language, commit format, and conventions; follow them exactly.
Highlights (not exhaustive — the project's own docs are authoritative):

- Commit messages: imperative subject ≤72 chars, body wraps ~72 cols, and
  any required footer/trailer from `project-context.md` / `CLAUDE.md`.
- Follow the project's language convention (which language for code,
  commits, user-visible strings, planning docs) per `project-context.md`.
- No emoji in code, commits, or files unless explicitly requested.
- Match existing code style. Check neighboring files before introducing
  a new pattern, naming convention, or framework choice.
- Never assume a library is available — grep the project's manifest
  (`Cargo.toml` / `package.json` / `Gemfile` / `pyproject.toml` …) first.
- Don't add error handling, validation, or fallbacks for scenarios
  that cannot happen. Trust internal code and framework guarantees.
- Default to no comments; only add one when WHY is non-obvious
  (constraint, invariant, workaround, surprising behavior).
- Prefer editing existing files to creating new ones. NEVER create
  documentation files unless explicitly asked.
- Use the dedicated tools (Read / Edit / Write) over Bash equivalents
  (cat / sed / echo).

Two iron laws (from `.claude/constitution.md`, Articles I–II):

- **Test-first.** No production code before a failing test that demands
  it. Watch the test fail for the RIGHT reason (feature missing — not a
  typo or setup error) before implementing; commit tests before or
  separately from the implementation. Rationalizations do not apply:
  "I'll test after" / "I manually tested" / "keeping code as reference"
  all mean: delete the premature code, write the test, restart.
- **Evidence before claims.** Never state "done", "fixed", "passing", or
  check a `- [x]` box without fresh command output from THIS session
  proving it. Banned as evidence substitutes: "should work", "probably",
  "I'm confident", "seems to". A linter passing is not tests passing.
