import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The same source, built for a browser.
//
// One alias is the whole difference. `src/platform/impl.ts` re-exports the desktop
// shell; here it resolves to the web one instead, so the desktop implementation —
// and every `@tauri-apps` import behind it — is not reachable from the entry point
// and therefore not in the bundle. A runtime branch would have put both in it, which
// is exactly what `test/web-bundle.test.ts` fails on.
//
// A separate output directory because `dist/` is what Tauri packages: a web build
// left there would ship a browser bundle inside a native application.
export default defineConfig({
  resolve: {
    alias: {
      "./platform/impl": fileURLToPath(new URL("./src/platform/web.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
  },
});
