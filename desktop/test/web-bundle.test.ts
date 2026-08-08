/// <reference types="node" />
// Node's types, pulled in here and nowhere else. The project sets `types: []` so
// that `process` and `Buffer` are not in scope across `src`, which is a browser
// program — this file is the one that legitimately reads a file off disk, and it
// asks for them by name.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The card's claim, checked rather than promised.
//
// "The web build contains no bridge" is the kind of rule that survives until the
// first Friday if a reviewer reading imports is what enforces it — one `invoke` in
// one branch of one handler, and the browser gets a window that throws where it
// should have said there is no agent here. So the build runs, the emitted bundle is
// read off disk, and the strings that could only come from a shell are looked for in
// what was actually shipped.
//
// Slow on purpose: this runs a real build. It is one test, and it is the one that
// makes the other seventy meaningful.
describe("the web bundle", () => {
  // `process.cwd()` rather than `import.meta.url`: this file runs under the jsdom
  // environment, where `import.meta.url` is not a file url, and vitest's cwd is the
  // package root either way.
  const root = process.cwd();
  const out = join(root, "dist-web", "assets");

  const built = (() => {
    execFileSync("pnpm", [ "build:web" ], { cwd: root, stdio: "pipe" });
    return readdirSync(out)
      .filter((f: string) => f.endsWith(".js"))
      .map((f: string) => readFileSync(join(out, f), "utf8"))
      .join("\n");
  })();

  test("was built at all, so an empty read cannot pass this file", () => {
    expect(built.length).toBeGreaterThan(10_000);
  });

  // Both spellings: the import is what a source file writes, `__TAURI` is what the
  // shell injects and what a bundler leaves behind after mangling the import away.
  test("carries no trace of the native shell", () => {
    expect(built).not.toContain("@tauri-apps");
    expect(built).not.toContain("__TAURI");
  });

  // The room is the point. A bundle that dropped the shell by dropping everything
  // would pass the check above and be useless.
  test("is still the room", () => {
    expect(built).toContain("workroom");
  });
});
