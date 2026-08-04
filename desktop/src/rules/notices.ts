// What the client says out loud about versions and git — and the fallback for
// a bridge call that never answers.

/// Versions, as numbers. `0.10.0` is newer than `0.9.0`, and comparing the two
/// as text says the opposite.
function parts(version?: string): number[] | null {
  if (!version) return null;
  const numbers = version.trim().split(".").map((p) => Number(p));
  return numbers.length === 3 && numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/// What to say about a release that exists. Nothing is installed by saying it:
/// an agent workspace that replaces its own binary without being asked is a
/// thing people are right to distrust.
export function updateNotice(v: { current: string; available: string }): string | null {
  const here = parts(v.current);
  const there = parts(v.available);
  if (!here || !there || compare(there, here) <= 0) return null;

  return `WorkRoom ${v.available} is available. You have ${v.current}.`;
}

/// A client and a workspace that have drifted apart. The failure is not an
/// error — it is a feature that quietly does nothing, which is the most
/// expensive kind — so it is said plainly rather than discovered.
///
/// A patch apart is not drift: these ship together and will always be a few
/// commits apart, and saying so every launch teaches people to ignore the one
/// that matters.
export function driftNotice(client: string, server?: string): string | null {
  const here = parts(client);
  const there = parts(server);
  if (!here || !there) return null;
  if (here[0] === there[0] && here[1] === there[1]) return null;

  return compare(there, here) > 0
    ? `This workspace is running ${server} and this app is ${client}. Some things here may not work.`
    : `This app is ${client} and the workspace is running ${server}. Some things here may not work.`;
}

/// What to do with an answer that may never come.
///
/// A call across the bridge to the native side usually answers. "Usually" is
/// what leaves somebody looking at a window that never filled in, with nothing
/// to report — so a call that hangs, or fails, falls back instead of winning.
export function orAfter<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/// Where a branch can be looked at, when the room's repository is on GitHub
/// (#206). Anything else — a local path, another host — is no link at all,
/// and the caller hides the control rather than offering a dead one.
export function githubTreeUrl(repositoryUrl: string | null, branch: string): string | null {
  const url = repositoryUrl?.trim();
  if (!url) return null;
  const match = /^git@github\.com:([^/]+)\/(.+)$/.exec(url)
    ?? /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(url);
  if (!match) return null;
  const repo = match[2].replace(/\.git\/?$/, "").replace(/\/$/, "");
  return `https://github.com/${match[1]}/${repo}/tree/${branch}`;
}

/// The standing rules of a session whose workspace is a repository (#205).
///
/// Prompt-level, and honestly so: the agent is *told* these rules, and branch
/// protection on the repository is the structure that makes the telling hold.
/// That is also why the real default branch is named rather than spoken of as
/// "the default branch" — a rule about a name the agent can see is one it can
/// follow, and one a person reading the transcript can check.
export function gitBoundary(defaultBranch: string): string {
  return [
    "This channel's workspace is a git repository. Its standing rules:",
    `- Work on branches named agent/<topic>; never commit to ${defaultBranch}.`,
    `- Never push to ${defaultBranch}, and never force-push anywhere.`,
    "- Never merge a pull request unless a person explicitly asks for it in this turn.",
    "- End every commit message with a Co-Authored-By trailer naming yourself;",
    "  the commit's author stays the person whose machine you run on.",
  ].join("\n");
}

/// A word in a command line, where "main" inside a message is not the branch
/// named as a target — the best a text match can do, and used knowing that.
const mentionsWord = (command: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(command);

/// Where a push is going, when the command says: `git push <remote> <branch>`.
/// Flags are skipped, a refspec's source is dropped — what matters is the
/// destination, because that is what a person is being asked to allow.
function pushTarget(command: string): string | null {
  const words = command.split(/\s+/);
  const at = words.findIndex((w) => w === "push");
  if (at < 0) return null;
  const rest = words.slice(at + 1).filter((w) => !w.startsWith("-"));
  const refspec = rest[1];
  if (!refspec) return null;
  return refspec.replace(/^\+/, "").split(":").pop() || null;
}

/// What a permission ask means, one muted line, when the ask is git (#205).
///
/// Annotation only: the allow/deny mechanics are the agent's and stay
/// untouched. A commit that never leaves the machine is quiet — local and
/// reversible, and the boundary already said its piece. A push is always
/// named, because it is the moment work leaves. The default branch named in
/// the command of a repository that deploys earns the warning in words:
/// that is the one ask where Allow ships something.
export function gitAskNote(
  command: string, defaultBranch: string | null, deploysOnPush: boolean,
): string | null {
  const deployWarning = deploysOnPush && defaultBranch
    ? ` — this repository deploys on merge to ${defaultBranch}.`
    : "";
  const onDefault = defaultBranch != null && mentionsWord(command, defaultBranch);

  if (/\bgit\s+push\b/.test(command)) {
    if (onDefault) return `Push to origin (${defaultBranch})${deployWarning}`;
    const target = pushTarget(command);
    return target ? `Push to origin (${target})` : "Push to origin";
  }
  if (/\bgit\s+commit\b/.test(command) && onDefault) {
    return `Commit to ${defaultBranch}, the default branch${deployWarning}`;
  }
  return null;
}
