// Which shell this build talks to.
//
// The desktop is the default because it is what `tsc` and the dev server see;
// the web build replaces this module with `./web` through a Vite alias, so the
// implementation it does not use is never in the bundle to be found.
export { platform } from "./desktop";
