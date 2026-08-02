import { beforeEach, describe, expect, test, vi } from "vitest";
import { createChannelSettings, setupSteps, type ChannelSettingsDeps, type RepoInfo } from "../src/channel-settings";
import type { Channel } from "../src/api";

// The dialog's half of index.html — the ids the module draws into. Kept in
// step with the real markup by hand, the way the timeline spec keeps its own.
const MARKUP = `
  <dialog id="channel-settings">
    <form method="dialog">
      <label>Name <input id="cs-name" readonly /></label>
      <label>Repository <input id="cs-repository" autocomplete="off" /></label>
      <div class="section-head"><span>This machine</span></div>
      <label class="choice">
        <input type="radio" name="cs-where" value="derived" />
        Derived folder <span id="cs-derived-path" class="muted"></span>
      </label>
      <label class="choice" id="cs-clone-row" hidden>
        <input type="radio" name="cs-where" value="clone" />
        Clone the repository into the derived folder
      </label>
      <label class="choice">
        <input type="radio" name="cs-where" value="existing" />
        Use existing folder… <span id="cs-existing-path" class="muted"></span>
      </label>
      <div id="cs-warning" hidden>
        <p id="cs-warning-text"></p>
        <button type="button" id="cs-copy-steps" class="ghost">Copy setup steps</button>
      </div>
      <p id="cs-error" class="muted"></p>
      <menu>
        <button value="cancel" formnovalidate id="cs-cancel">Cancel</button>
        <button type="button" id="cs-save">Save</button>
        <button value="cancel" formnovalidate id="cs-done" hidden>Done</button>
      </menu>
    </form>
  </dialog>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function room(over: Partial<Channel> = {}): Channel {
  return {
    id: 1, slug: "meetings", name: "Meetings", purpose: null, visibility: "open",
    memory_uri: "viking://resources/channels/meetings/", message_count: 0,
    ...over,
  };
}

const quiet: RepoInfo = { remote: null, default_branch: null, deploys_on_push: false };
const deploys: RepoInfo = {
  remote: "https://github.com/acme/widgets", default_branch: "main", deploys_on_push: true,
};

/// The seams the module cannot own: the room's record, the machine's binding,
/// and everything that crosses the bridge.
function deps(channel: Channel, over: Partial<ChannelSettingsDeps> = {}): ChannelSettingsDeps {
  return {
    currentChannel: () => channel,
    workspaceSlug: () => "farol",
    updateChannel: vi.fn(async (_slug: string, url: string | null) => ({ ...channel, repository_url: url })),
    bindings: () => ({}),
    bind: vi.fn(),
    chooseFolder: vi.fn(async () => null),
    derivedFolder: vi.fn(async () => "/home/alice/WorkRoom/farol/meetings"),
    clone: vi.fn(async () => {}),
    repoInfo: vi.fn(async () => quiet),
    releaseChannel: vi.fn(async () => {}),
    applied: vi.fn(),
    copyText: vi.fn(async () => {}),
    ...over,
  };
}

const radio = (value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="cs-where"][value="${value}"]`)!;

beforeEach(() => { document.body.innerHTML = MARKUP; });

describe("channel settings", () => {
  test("the clone choice is hidden while the room names no repository", () => {
    const settings = createChannelSettings(deps(room()));

    settings.open();

    expect($("cs-clone-row").hidden).toBe(true);
    expect(radio("derived").checked).toBe(true);
    expect($("cs-derived-path").textContent).toBe("~/WorkRoom/farol/meetings");
  });

  test("a room with a repository offers to clone it", () => {
    const settings = createChannelSettings(deps(room({ repository_url: "https://github.com/acme/widgets" })));

    settings.open();

    expect($("cs-clone-row").hidden).toBe(false);
    expect($<HTMLInputElement>("cs-repository").value).toBe("https://github.com/acme/widgets");
  });

  test("a bound channel opens with its folder chosen", () => {
    const settings = createChannelSettings(deps(room(), {
      bindings: () => ({ meetings: "/home/alice/src/billing" }),
    }));

    settings.open();

    expect(radio("existing").checked).toBe(true);
    expect($("cs-existing-path").textContent).toContain("billing");
  });

  test("saving an unchanged address does not write to the room", async () => {
    const d = deps(room({ repository_url: "https://github.com/acme/widgets" }));
    const settings = createChannelSettings(d);
    settings.open();

    $<HTMLButtonElement>("cs-save").click();
    await vi.waitFor(() => expect($<HTMLDialogElement>("channel-settings").open).toBe(false));

    // The server journals every change it gets — a PATCH that says nothing
    // would still be said in the room's record.
    expect(d.updateChannel).not.toHaveBeenCalled();
    expect(d.applied).toHaveBeenCalled();
  });

  test("saving a new address writes it, and a blank one clears it", async () => {
    const d = deps(room());
    const settings = createChannelSettings(d);
    settings.open();
    $<HTMLInputElement>("cs-repository").value = "https://github.com/acme/widgets";

    $<HTMLButtonElement>("cs-save").click();
    await vi.waitFor(() => expect(d.applied).toHaveBeenCalled());

    expect(d.updateChannel).toHaveBeenCalledWith("meetings", "https://github.com/acme/widgets");

    const clearing = deps(room({ repository_url: "https://github.com/acme/widgets" }));
    const again = createChannelSettings(clearing);
    again.open();
    $<HTMLInputElement>("cs-repository").value = "   ";

    $<HTMLButtonElement>("cs-save").click();
    await vi.waitFor(() => expect(clearing.applied).toHaveBeenCalled());

    expect(clearing.updateChannel).toHaveBeenCalledWith("meetings", null);
  });

  test("choosing derived hands a bound folder back to the derivation", async () => {
    const d = deps(room(), {
      bindings: () => ({ meetings: "/home/alice/src/billing" }),
    });
    const settings = createChannelSettings(d);
    settings.open();
    radio("derived").click();

    $<HTMLButtonElement>("cs-save").click();
    await vi.waitFor(() => expect(d.applied).toHaveBeenCalled());

    expect(d.bind).toHaveBeenCalledWith("meetings", null);
    expect(d.releaseChannel).toHaveBeenCalledWith("meetings");
  });

  test("an existing folder that deploys on merge warns before anything is saved", async () => {
    const d = deps(room(), {
      chooseFolder: vi.fn(async () => "/home/alice/src/widgets"),
      repoInfo: vi.fn(async () => deploys),
    });
    const settings = createChannelSettings(d);
    settings.open();
    radio("existing").click();

    await vi.waitFor(() => expect($("cs-warning").hidden).toBe(false));

    expect($("cs-warning-text").textContent).toContain("deploys on merge to main");
    expect(d.repoInfo).toHaveBeenCalledWith("/home/alice/src/widgets");
    // The dialog is still open and nothing was bound: the warning arrives
    // before the fact.
    expect($<HTMLDialogElement>("channel-settings").open).toBe(true);
    expect(d.bind).not.toHaveBeenCalled();
  });

  test("declining the folder picker declines the choice with it", async () => {
    const d = deps(room(), { chooseFolder: vi.fn(async () => null) });
    const settings = createChannelSettings(d);
    settings.open();
    radio("existing").click();

    await vi.waitFor(() => expect(radio("derived").checked).toBe(true));
  });

  test("saving a clone clones into the derived folder and warns when it deploys", async () => {
    const channel = room({ repository_url: "https://github.com/acme/widgets" });
    const d = deps(channel, { repoInfo: vi.fn(async () => deploys) });
    const settings = createChannelSettings(d);
    settings.open();
    radio("clone").click();

    $<HTMLButtonElement>("cs-save").click();
    await vi.waitFor(() => expect($("cs-warning").hidden).toBe(false));

    expect(d.clone).toHaveBeenCalledWith(
      "https://github.com/acme/widgets", "/home/alice/WorkRoom/farol/meetings");
    expect(d.applied).toHaveBeenCalled();
    // The work is done but the warning is the point: the dialog stays, and
    // what is left to press is Done.
    expect($<HTMLDialogElement>("channel-settings").open).toBe(true);
    expect($<HTMLButtonElement>("cs-save").hidden).toBe(true);
    expect($<HTMLButtonElement>("cs-done").hidden).toBe(false);
  });

  test("a clone git refused is said inline, with its own words", async () => {
    const channel = room({ repository_url: "https://github.com/acme/nope" });
    const d = deps(channel, {
      clone: vi.fn(async () => { throw new Error("repository not found"); }),
    });
    const settings = createChannelSettings(d);
    settings.open();
    radio("clone").click();

    $<HTMLButtonElement>("cs-save").click();
    await vi.waitFor(() => expect($("cs-error").textContent).toContain("repository not found"));

    expect($<HTMLDialogElement>("channel-settings").open).toBe(true);
    expect(d.applied).not.toHaveBeenCalled();
  });

  test("the room renaming its repository while the dialog is open wins over a half-typed answer", () => {
    const settings = createChannelSettings(deps(room()));
    settings.open();
    $<HTMLInputElement>("cs-repository").value = "half-typed";

    settings.refresh(room({ repository_url: "https://github.com/acme/widgets" }));

    expect($<HTMLInputElement>("cs-repository").value).toBe("https://github.com/acme/widgets");
    expect($("cs-clone-row").hidden).toBe(false);
  });

  test("the setup steps say what protecting the branch means", () => {
    const steps = setupSteps("main");

    expect(steps).toContain("main");
    expect(steps).toContain("pull request");
    expect(steps).toContain("review");
  });
});
