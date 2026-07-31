#!/usr/bin/env bash
# git-guard.sh — PreToolUse hook (Bash) for flow workers.
# Provisioned by /flow-run Phase 1 into each card's worktree.
#
# Deterministically blocks the git operations the worker prompts forbid
# (history rewrites, branch escapes, self-merge). Exit 2 rejects the
# command; stderr is fed back to the worker so it can take the sanctioned
# path (new commit / push to the same branch / BLOCKED) instead.
#
# Fail-open: no jq, or no command field -> allow.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
[ -z "$CMD" ] && exit 0

deny() {
  echo "git-guard: blocked — $1" >&2
  echo "Command was: $CMD" >&2
  exit 2
}

case_insensitive_match() { printf '%s' "$CMD" | grep -qiE "$1"; }

if case_insensitive_match 'git[^|;&]* push[^|;&]*( --force\b| -f\b|--force-with-lease)'; then
  deny "force-push. Push normal commits to the same branch; if the branch is unusable, finish with BLOCKED."
fi
if case_insensitive_match 'git[^|;&]* reset[^|;&]* --hard'; then
  deny "git reset --hard. It can destroy human edits made between iterations; finish with BLOCKED instead."
fi
if case_insensitive_match 'git[^|;&]* (checkout|switch)[^|;&]* (main|master)\b'; then
  deny "switching to main/master. Workers stay on their card branch."
fi
if case_insensitive_match 'git[^|;&]* rebase\b'; then
  deny "rebase. Make new commits on the card branch; meta and the human handle history shape."
fi
if case_insensitive_match 'git[^|;&]* commit[^|;&]* --amend'; then
  deny "commit --amend. Make a NEW commit (pre-commit hooks + audit trail rely on it)."
fi
if case_insensitive_match 'git[^|;&]* branch[^|;&]* -D'; then
  deny "force branch deletion."
fi
if case_insensitive_match 'git[^|;&]* worktree[^|;&]* remove'; then
  deny "worktree removal. Worktrees are cleaned up by humans after inspection."
fi
if case_insensitive_match 'gh[^|;&]* pr[^|;&]* merge'; then
  deny "merging the PR. Only meta's Phase 3 (auto-merge decision) or the human merges."
fi

exit 0
