# Role: formatting

Universal output rules. Apply on top of any other role.

## General

- No emoji in any output (commits, comments, PR body, chat, code)
  unless explicitly requested.
- No preamble (`Here is...`, `I will now...`, `Let me start by...`)
  and no trailing summary unless the user asked for one.
- Markdown is allowed but optional; plain text is fine when shorter.
- Inline code in backticks for paths, commands, function names, flag
  values. Fenced blocks only when the snippet wouldn't fit one line.

## Output contract for workers spawned via `claude -p`

When you are a worker driven by `/flow-run`, your FINAL response —
delivered to meta as the `result` field of the CLI's
`--output-format json` envelope — must be exactly one of these two
lines and NOTHING else:

```
PR_URL=<url>
```

— on success, after `git push` and `gh pr create` (iter 1) or
`git push` (iter ≥ 2). For iter ≥ 2 the URL must match the PR opened
in iter 1.

```
BLOCKED: <one sentence reason>
```

— when you cannot finish per the plan. The sentence must be parseable
in isolation (no "see above", no "as discussed earlier").

You cannot control the CLI process exit code — do not try. Meta
classifies your run purely by the final-response text: `PR_URL=` is
success, `BLOCKED:` is a controlled stop, anything else is treated as
a crash.

All other communication — progress notes, audit findings, code
review, explanations — belongs in commits or PR comments, never in
the final response. Meta parses the final response deterministically;
extra lines trigger a `Worker produced ambiguous output` failure.
