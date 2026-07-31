# Conventions

Rules a worker follows in this repository, beyond the constitution.

## Attribution

Work that the flow performs on GitHub is published by **`ori-cofounder`**, an
account that exists for this and nothing else. A human's account is never used
to speak for an agent.

| Surface | Author |
|---|---|
| Issues, issue comments, pull-request bodies and comments | `ori-cofounder` |
| Commits and pushes | the human whose machine ran the work, with `Co-Authored-By:` |

Commits stay under a person because git history reads better that way and
already carries the fact in a trailer.

**Every body the flow writes still ends with:**

```
— Farol AI Agent Flow
```

The account answers *who*; the line answers *how*. They are different questions,
and the line survives where the avatar does not — GitHub's notification mail
shows the body far more prominently than the author.

Angle-bracket forms such as `<ai agent-flow>` do not survive: the markdown
sanitizer strips unknown HTML tags and the marker disappears silently.

The `ai` label remains the machine-readable counterpart, for
filtering. It complements both; it replaces neither.

## Credentials

The `ori-cofounder` token lives outside the repository and is passed per
invocation, never written into git config or a file under version control:

```sh
GH_TOKEN=$(cat "$TOKEN_PATH") gh issue comment …
```

Per-invocation rather than `gh auth switch`, so the wrong account cannot be left
active by a command that failed halfway.

A token for publishing comments needs `repo` and nothing else. Scope it to this
repository with a fine-grained token; the broad classic scopes — `delete_repo`,
`admin:org`, `admin:enterprise` — have no use here and are a standing risk.
