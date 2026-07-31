// Stands in for the Tauri bridge so the interface can be looked at without a
// display or a native build.
//
// It never answers. That is deliberate: a stub returning plausible values hides
// exactly the class of defect a silent bridge causes, and that is how the room
// came to depend on the native side answering before it would open at all (#65).
window.__TAURI_INTERNALS__ = {
  invoke: () => new Promise(() => {}),
  transformCallback: (callback) => callback,
};

// No polling anywhere in here. Under a headless browser's virtual clock a
// self-renewing timer burns the entire time budget before a real network
// response can land, and the page is captured empty. Hook the event instead.
const showModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function () {
  showModal.call(this);
  if (new URLSearchParams(location.search).get("signed-in") !== "no") this.close();
};

// Open whatever the caller asked to see, once the room has actually filled in.
const wanted = new URLSearchParams(location.search).get("open");
if (wanted) {
  new MutationObserver((_, self) => {
    const target = wanted === "thread"
      ? document.querySelector(".thread-summary")
      : document.getElementById("memory-toggle");
    if (!target || !document.querySelector("#messages .msg")) return;
    self.disconnect();
    target.click();
    // The document element, not the body: this script runs in <head>, where
    // `document.body` is still null and observing it throws — silently taking
    // the rest of this file with it.
  }).observe(document.documentElement, { childList: true, subtree: true });
}
