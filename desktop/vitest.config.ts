import { defineConfig } from "vitest/config";

export default defineConfig({
  // One spec reads bin/acp-turn (`?raw`) to pin the vocabulary the two clients
  // share; vite's default workspace root stops at desktop/, so the repository
  // root is allowed explicitly. Test-server only — the built app never sees it.
  server: { fs: { allow: [".."] } },
  test: { environment: "happy-dom", include: ["test/**/*.test.ts"] },
});
