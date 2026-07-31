#!/usr/bin/env bash
# scope-guard.sh — PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit) for
# flow workers. Provisioned by /flow-run Phase 1 into each card's
# worktree together with .claude/settings.local.json and
# .claude/plan-allowed-files.txt (the manifest derived from the PLAN's
# `## Files`).
#
# Turns the prompt-level rule "do not change files outside `## Files`" into
# a deterministic block: an edit to a file not matching the manifest is
# rejected before it happens (exit 2; stderr is fed back to the worker).
#
# Fail-open by design: no manifest (or no jq) -> allow. The acceptance
# check still enforces scope post-hoc; this hook is defense-in-depth, and
# it must never brick a human's interactive session in the same worktree.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
[ -z "$FILE" ] && exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
MANIFEST="$ROOT/.claude/plan-allowed-files.txt"
[ -f "$MANIFEST" ] || exit 0

# Normalize to a repo-relative path.
REL="${FILE#"$ROOT"/}"
if [ "$REL" = "$FILE" ] && [ "${FILE#/}" != "$FILE" ]; then
  echo "scope-guard: $FILE is outside this worktree ($ROOT). Workers only edit files inside their own worktree." >&2
  exit 2
fi

while IFS= read -r pat; do
  case "$pat" in ''|'#'*) continue;; esac
  # shellcheck disable=SC2254  # glob patterns from the manifest are intended
  case "$REL" in
    $pat) exit 0;;
  esac
done < "$MANIFEST"

{
  echo "scope-guard: '$REL' is not in the PLAN's ## Files (manifest: .claude/plan-allowed-files.txt)."
  echo "Work strictly within the plan. If the plan itself is wrong or incomplete, do not improvise:"
  echo "finish with 'BLOCKED: plan does not cover required file $REL' instead."
} >&2
exit 2
