# Conventions

Rules a worker follows in this repository, beyond the constitution.

## Attribution

Everything the flow writes to GitHub is posted under a human's account, because
`gh` authenticates as that person. Without a marker, an agent's issue, comment
or pull-request body is indistinguishable from something they wrote themselves.

**Every issue body, issue comment and pull-request body authored by the flow
ends with:**

```
— Farol AI Agent Flow
```

In the text itself, as its last line — not a label, not a separated footnote.
Labels are easy to miss and get filtered out of notification emails; the line is
part of the body wherever the body is read.

Angle-bracket forms such as `<ai agent-flow>` do not survive: GitHub's markdown
sanitizer strips unknown HTML tags, and the marker silently disappears.

Commits carry the same fact by a different mechanism — `Co-Authored-By:` — and
do not need the line.

The `ai-generated` label stays as a machine-readable counterpart for filtering.
It complements the signature; it does not replace it.
