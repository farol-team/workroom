// Stands in for the Tauri bridge so the interface can be looked at without a
// display or a native build.
//
// It never answers. That is deliberate: a stub returning plausible values hides
// exactly the class of defect a silent bridge causes, and that is how the room
// came to depend on the native side answering before it would open at all (#65).

// Open whatever the caller asked to see, once the room has actually filled in.
const wanted = new URLSearchParams(location.search).get("open");

// The exception to "never answers", for the states that ask to see the channel
// settings dialog: the deploy warning *is* the bridge's answer to
// agent_repo_info, and the folder picker's answer is what leads to it. A
// picture of that state cannot be staged against silence — so these states get
// exactly the answers they are staging, named here rather than implied.
const stagingSettings = (wanted ?? "").startsWith("channel-settings");
window.__TAURI_INTERNALS__ = {
  invoke: (command) => {
    if (stagingSettings && command === "plugin:dialog|open") {
      return Promise.resolve("/tmp/acme-widgets");
    }
    if (stagingSettings && command === "agent_repo_info") {
      return Promise.resolve({ remote: "https://github.com/acme/widgets",
                               default_branch: "main", deploys_on_push: true });
    }
    return new Promise(() => {});
  },
  transformCallback: (callback) => callback,
};

// No polling anywhere in here. Under a headless browser's virtual clock a
// self-renewing timer burns the entire time budget before a real network
// response can land, and the page is captured empty. Hook the event instead.
const showModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function () {
  showModal.call(this);
  // The sign-in is stepped over, never answered — a staged picture is of the
  // room, not of the door into it. Scoped to that one dialog since #203:
  // channel-settings is itself a staged state, and a hook that closes every
  // dialog would photograph nothing of it.
  if (new URLSearchParams(location.search).get("signed-in") !== "no" && this.id === "signin") {
    this.close();
  }
};

if (wanted) {
  new MutationObserver((_, self) => {
    const target = wanted === "thread"
      ? document.querySelector(".thread-summary")
      : wanted === "memory"
        ? document.getElementById("memory-toggle")
        : stagingSettings
          ? document.getElementById("folder")
          : null;
    if (!target || !document.querySelector("#messages .msg")) return;
    self.disconnect();
    target.click();

    if (wanted === "channel-settings-warning") {
      // The warning follows choosing an existing folder; the picker's answer
      // is staged above, so the choice is all that is left to make. Tried
      // immediately as well as on every later mutation: the dialog opened
      // synchronously inside the click above, and a mutation observed only
      // from here on is one that already happened.
      let observer;
      const chooseExisting = () => {
        const dialog = document.getElementById("channel-settings");
        const choice = document.querySelector('input[name="cs-where"][value="existing"]');
        if (!choice || !dialog?.open) return;
        observer.disconnect();
        choice.click();
      };
      observer = new MutationObserver(chooseExisting);
      observer.observe(document.documentElement,
        { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
      chooseExisting();
    }
    // The document element, not the body: this script runs in <head>, where
    // `document.body` is still null and observing it throws — silently taking
    // the rest of this file with it.
  }).observe(document.documentElement, { childList: true, subtree: true });
}
