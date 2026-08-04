// ---------- the client, driven ----------
//
// What follows drives main.ts itself — the real composer, the real boot chain,
// the real notice strip — with the two edges standing in: the server it talks
// to over HTTP, and the local bridge it talks to over Tauri. A notice is a
// thing on screen and a blocking dialog is a thing that is not, so this is the
// only place the difference between them can be measured; and no source-level
// guard can see whether the text somebody typed survived a failed send.

import { afterEach, describe, expect, test, vi } from "vitest";
import { aBridge, aServer, aShell, blockingDialog, el, notices, openTheClient, settle, submit } from "./harness";
import type { Edges } from "./harness";

/// A request this test holds open, so what the window does *while* one is in
/// flight can be measured at all. `settle()` drains everything pending, and
/// what it drains is exactly where an optimistic clear hides: a composer that
/// empties only once the server has answered looks identical afterwards.
function heldOpen<T = any>() {
  let answer!: (value: T) => void;
  let refuse!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; });
  return { promise, answer, refuse };
}

afterEach(() => { blockingDialog.mockClear(); vi.unstubAllGlobals(); });

describe("a client whose edges all answer", () => {
  test("says nothing, so a notice below means something failed", async () => {
    // The control the rest of this section rests on. Without it, an
    // unconditional notice at boot would satisfy every expectation below.
    await openTheClient();

    expect(el("channel-name").textContent).toBe("# meetings");
    expect(notices()).toBe("");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("clears the composer while the message is still in flight", async () => {
    // The optimistic clear stays, and it is only observable before the server
    // answers — so the answer is withheld until it has been looked at. Keeping
    // the text on failure must not be bought by emptying the composer once the
    // post comes back: that trades a lost sentence for a composer that lags
    // the room on every message anybody sends.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({ post: vi.fn(() => inFlight.promise) }) });
    el<HTMLInputElement>("input").value = "what did we agree about pricing?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalled();
    expect(el<HTMLInputElement>("input").value).toBe("");

    inFlight.answer({ id: 5 });
    await settle();

    expect(el<HTMLInputElement>("input").value).toBe("");
    expect(notices()).toBe("");
  });
});

describe("what the room says when something goes wrong", () => {
  test("a send that does not go through keeps what the person typed", async () => {
    // The composer clears optimistically, which is right — and until now the
    // failure took the sentence with it. Somebody who learns that lesson starts
    // copying every message before pressing Send.
    //
    // Both halves in one example, because the cheapest way to keep the text is
    // to stop clearing until the server answers, and that would read as green
    // in an example that only looks at the end.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({ post: vi.fn(() => inFlight.promise) }) });
    el<HTMLInputElement>("input").value = "what did we agree about pricing?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalled();
    expect(el<HTMLInputElement>("input").value).toBe("");

    inFlight.refuse(new Error("500 the server said no"));
    await settle();

    expect(el<HTMLInputElement>("input").value).toBe("what did we agree about pricing?");
    expect(notices()).toContain("the server said no");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a turn that fails after the message landed leaves the composer empty", async () => {
    // The other side of the line, and the reason the restore belongs to the
    // post rather than to the whole turn: everything after `api.post` happens
    // with the sentence already in the room. Putting it back would invite the
    // person to press Send on a message the channel already has, and they
    // would — the composer refilling itself reads as "that did not go".
    const { server } = await openTheClient({
      server: aServer({ startRun: vi.fn(async () => { throw new Error("500 the run never started"); }) }),
    });
    el<HTMLInputElement>("input").value = "@claude what did we agree?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalledWith("meetings", "what did we agree?");
    expect(server.startRun).toHaveBeenCalled();
    expect(el<HTMLInputElement>("input").value).toBe("");
    expect(notices()).toContain("the run never started");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a reply that does not go through keeps it too", async () => {
    // A reply is a send. The panel clears its box the same way the room does,
    // so it loses the same sentence, and fixing one of the two is fixing half
    // a defect — including the half that says the box empties on the press.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({ post: vi.fn(() => inFlight.promise) }) });
    document.querySelector<HTMLButtonElement>("#messages .reply-action")!.click();
    el<HTMLInputElement>("thread-input").value = "agreed, and I will write it up";

    submit("thread-composer");
    await settle();

    expect(server.post).toHaveBeenCalled();
    expect(el<HTMLInputElement>("thread-input").value).toBe("");

    inFlight.refuse(new Error("500 the thread is gone"));
    await settle();

    expect(el<HTMLInputElement>("thread-input").value).toBe("agreed, and I will write it up");
    expect(notices()).toContain("the thread is gone");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  /// Every other surface that can fail: the edge that refuses, the press a
  /// person makes, and what has to be readable in the room afterwards. Table
  /// rather than a test each, because the expectation is the same sentence
  /// sixteen times — and `attempted` is what keeps a green honest, since a
  /// drive that never reached the failing call would also leave the strip
  /// empty and no dialog behind.
  const operational: Array<{
    what: string;
    edges: () => Edges;
    drive: (edges: Edges) => Promise<void>;
    attempted: (edges: any) => unknown;
    said: string;
  }> = [
    {
      what: "an agent that will not start",
      edges: () => ({ bridge: aBridge({
        isRunning: () => false,
        start: vi.fn(async () => { throw new Error("claude exited 1"); }),
      }) }),
      // The row's second button is its one action, which for a ready agent
      // that is not running says Start.
      drive: async () => {
        [ ...document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button") ].pop()!.click();
        await settle();
      },
      attempted: (edges) => edges.bridge.start,
      said: "claude exited 1",
    },
    {
      what: "an agent that will not stop",
      // The same row, the other press. Starting fails inside `toggleAgent` and
      // stopping fails out of it, so they are two catches and one of them has
      // never been looked at.
      edges: () => ({ bridge: aBridge({
        stop: vi.fn(async () => { throw new Error("the process would not stop"); }),
      }) }),
      drive: async () => {
        [ ...document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button") ].pop()!.click();
        await settle();
      },
      attempted: (edges) => edges.bridge.stop,
      said: "the process would not stop",
    },
    {
      what: "an install the bridge never ran",
      // The other way an install fails: not npm saying no, but nothing on this
      // machine answering at all. It arrives as a rejection rather than a
      // result, at a different call site, and reads the same to the person.
      edges: () => ({ bridge: aBridge({
        definitions: () => [ { name: "codex", command: "codex-acp", args: [] } ],
        isRunning: () => false,
        stateOf: () => "missing",
        install: vi.fn(async () => { throw new Error("no answer from this machine"); }),
      }) }),
      drive: async () => {
        [ ...document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button") ].pop()!.click();
        await settle();
      },
      attempted: (edges) => edges.bridge.install,
      said: "no answer from this machine",
    },
    {
      what: "a skill the room did not accept",
      edges: () => ({ server: aServer({
        writeSkill: vi.fn(async () => { throw new Error("422 the title is taken"); }),
      }) }),
      drive: async () => {
        el("memory-toggle").click();
        await settle();
        el<HTMLInputElement>("skill-title").value = "Running a client call";
        el<HTMLTextAreaElement>("skill-body").value = "Agenda out the day before.";
        submit("skill-form");
        await settle();
      },
      attempted: (edges) => edges.server.writeSkill,
      said: "the title is taken",
    },
    {
      what: "a workspace that was not made",
      edges: () => ({ server: aServer({
        createWorkspace: vi.fn(async () => { throw new Error("409 that name is taken"); }),
      }) }),
      drive: async () => {
        el("workspace-new").click();
        await settle();
        el<HTMLInputElement>("make-name").value = "Globex";
        el<HTMLInputElement>("make-slug").value = "globex";
        el<HTMLDialogElement>("make").close("go");
        await settle();
      },
      attempted: (edges) => edges.server.createWorkspace,
      said: "that name is taken",
    },
    {
      what: "a channel that was not made",
      edges: () => ({ server: aServer({
        createChannel: vi.fn(async () => { throw new Error("422 that address is in use"); }),
      }) }),
      drive: async () => {
        el("channel-new").click();
        await settle();
        el<HTMLInputElement>("make-name").value = "Pricing";
        el<HTMLInputElement>("make-slug").value = "pricing";
        el<HTMLDialogElement>("make").close("go");
        await settle();
      },
      attempted: (edges) => edges.server.createChannel,
      said: "that address is in use",
    },
    {
      what: "an answer the agent would not take",
      edges: () => ({ bridge: aBridge({
        permit: vi.fn(async () => { throw new Error("the session is gone"); }),
      }) }),
      drive: async (edges: any) => {
        el<HTMLInputElement>("input").value = "@claude run the tests";
        submit("composer");
        await settle();
        // The ask, as the agent raises it mid-turn, through the callback the
        // client registered for exactly that.
        edges.bridge.onAsk.mock.calls[0][1]({
          id: 1, title: "Run the tests?", options: [ { id: "yes", name: "Yes" } ],
        });
        document.querySelector<HTMLButtonElement>("#messages .offer.ask button")!.click();
        await settle();
      },
      attempted: (edges) => edges.bridge.permit,
      said: "the session is gone",
    },
    {
      what: "a session option that would not change",
      edges: () => ({ bridge: aBridge({
        configFor: () => [ { id: "model", name: "Model", type: "select", currentValue: "haiku",
                             options: [ { value: "haiku", name: "Haiku" },
                                        { value: "opus", name: "Opus" } ] } ],
        setConfig: vi.fn(async () => { throw new Error("that option is gone"); }),
      }) }),
      drive: async () => {
        const select = document.querySelector<HTMLSelectElement>("#session-options select")!;
        select.value = "opus";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      },
      attempted: (edges) => edges.bridge.setConfig,
      said: "that option is gone",
    },
    {
      what: "an offer whose action fails",
      edges: () => ({ server: aServer({
        workspaceMembers: vi.fn(async () => [ { id: 2, name: "Bob", handle: "bob", role: "member" } ]),
        addMember: vi.fn(async () => { throw new Error("403 not yours to add"); }),
      }) }),
      // Every offer and every notice shares one button (`ghostButton`), so this
      // is all of them.
      drive: async () => {
        el<HTMLInputElement>("input").value = "@bob can you look at this";
        submit("composer");
        await settle();
        document.querySelector<HTMLButtonElement>("#notices button")!.click();
        await settle();
      },
      attempted: (edges) => edges.server.addMember,
      said: "not yours to add",
    },
  ];

  test.each(operational)("$what is said in the room, not in a dialog", async (one) => {
    const edges = await openTheClient(one.edges());

    await one.drive(edges);

    expect(one.attempted(edges)).toHaveBeenCalled();
    expect(notices()).toContain(one.said);
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a browser sign-in that fails is a notice, and the door is still open", async () => {
    // The one failure that happens with a modal already on screen — and the
    // notice strip is behind it, in a room this person cannot see yet. It goes
    // there anyway: a native dialog on top of a dialog is the worst of both,
    // and the strip is what they read the moment the sign-in closes.
    //
    // Two things, and neither of them is a sentence: it arrives as a notice
    // rather than as something that stops the window, and it carries what
    // failed. The way back is the button they already pressed, so what makes
    // the failure survivable is that pressing it again asks again.
    const shell = aShell({ invoke: vi.fn(async () => { throw new Error("the browser said no"); }) });
    await openTheClient(
      { server: aServer({ methods: vi.fn(async () => ({ development: true, provider: true, version: "0.1.0" })) }),
        shell },
      async () => {
        el("signin-provider").click();
        await settle();

        expect(shell.invoke).toHaveBeenCalledTimes(1);
        expect(notices()).toContain("the browser said no");
        expect(blockingDialog).not.toHaveBeenCalled();

        expect(el<HTMLButtonElement>("signin-provider").disabled).toBe(false);
        el("signin-provider").click();
        await settle();

        expect(shell.invoke).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("an agent nobody started is a notice that starts it", async () => {
    // The one failure here that is neither the server's nor the machine's: the
    // person addressed an agent that is not running. Their message went to the
    // room before the agent was ever asked, so the notice is about the agent
    // alone — it names which one, because "your agent" is three rows in a
    // panel, and it carries the way out rather than describing it. What the
    // remedy is worded as is the room's business; that pressing it starts the
    // agent that was addressed is not.
    const { server, bridge } = await openTheClient({ bridge: aBridge({ isRunning: () => false }) });
    el<HTMLInputElement>("input").value = "@claude what did we agree?";

    submit("composer");
    await settle();

    expect(server.post).toHaveBeenCalledWith("meetings", "what did we agree?");
    expect(server.startRun).not.toHaveBeenCalled();
    expect(bridge.sessionFor).not.toHaveBeenCalled();
    expect(notices()).toMatch(/claude/i);
    // Nothing to restore: this send is the one that worked.
    expect(el<HTMLInputElement>("input").value).toBe("");
    expect(blockingDialog).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>("#notices .notice button")!.click();
    await settle();

    expect(bridge.start).toHaveBeenCalledWith("claude");
  });

  test("an install npm refused says what npm said, and can be pressed again", async () => {
    // The answer to "what did that do to my machine" is npm's own, so it is
    // carried rather than summarised. And the offer survives the refusal: a row
    // that has gone quiet after a failed install is one somebody has to restart
    // the application to use, so the way to know it survived is to use it.
    const { bridge } = await openTheClient({ bridge: aBridge({
      definitions: () => [ { name: "codex", command: "codex-acp", args: [] } ],
      isRunning: () => false,
      stateOf: () => "missing",
      install: vi.fn(async () => ({ ok: false, code: 1, stdoutTail: "",
                                    stderrTail: "npm ERR! 404 not found" })),
    }) });
    const offer = () => [ ...document.querySelectorAll<HTMLButtonElement>("#agents .agent-row button") ].pop()!;

    offer().click();
    await settle();

    expect(bridge.install).toHaveBeenCalledTimes(1);
    expect(notices()).toContain("npm ERR! 404 not found");
    expect(blockingDialog).not.toHaveBeenCalled();

    expect(offer().disabled).toBe(false);
    offer().click();
    await settle();

    expect(bridge.install).toHaveBeenCalledTimes(2);
  });

  test("a code the server would not take is cleared on the press, and put back", async () => {
    // A code arrives out of band — from a message, a call, a piece of paper —
    // and is typed once. Losing it to a failed redemption costs the person the
    // invitation rather than the attempt, so what survives is the way back in:
    // the code returns to the field, and sending it again is one press.
    //
    // The sequence, not the end state, is what is pinned — through a join the
    // server has not answered yet. The field empties on the press (the same
    // optimistic clear every send here makes) and refills only because the
    // refusal put the code back: an implementation that never clears fails the
    // first half, and one that clears without restoring fails the second.
    const inFlight = heldOpen();
    const { server } = await openTheClient({ server: aServer({
      acceptInvitation: vi.fn(() => inFlight.promise),
    }) });
    el("workspace-join").click();
    await settle();
    el<HTMLInputElement>("join-code").value = "abc-123";

    el<HTMLDialogElement>("join").close("go");
    await settle();

    expect(server.acceptInvitation).toHaveBeenCalledWith("abc-123");
    expect(el<HTMLInputElement>("join-code").value).toBe("");

    inFlight.refuse(new Error("410 that code is spent"));
    await settle();

    expect(el<HTMLInputElement>("join-code").value).toBe("abc-123");
    expect(notices()).toContain("that code is spent");
    expect(blockingDialog).not.toHaveBeenCalled();
  });
});

describe("the start-up says which part of it failed", () => {
  /// Three stages, three messages, and each must name its own and only its
  /// own. One message listing all three would be true, useless, and exactly
  /// what `boot().catch(…)` says today: sign-in refused, a room that will not
  /// load and a bridge that is not answering are three different mornings, and
  /// only the person can act on the difference.
  ///
  /// Each pattern names a stage as the thing that failed, rather than a word
  /// that stage tends to use. That is what makes the exclusions safe: "your
  /// agents could not load" is a bridge message and matches nothing here but
  /// the bridge; "agents are unavailable in this channel" is one too, and the
  /// channels pattern does not read on it. What is forbidden of each message
  /// is only the other two stages claiming to be the one that failed.
  const STAGE = {
    signIn: /signing in/i,
    channels: /channels (did not|could not|would not|failed)|(load|loading) (the )?channels/i,
    bridge: /bridge/i,
  };

  test("a sign-in that is refused names signing in, and nothing else", async () => {
    const { server } = await openTheClient({
      server: aServer({ signIn: vi.fn(async () => { throw new Error("401 no account here"); }) }),
    });

    // The other two stages pin how far the boot got by what is on screen;
    // this one is the first thing that happens, so it says so directly.
    expect(server.signIn).toHaveBeenCalled();
    expect(notices()).toMatch(STAGE.signIn);
    expect(notices()).not.toMatch(STAGE.channels);
    expect(notices()).not.toMatch(STAGE.bridge);
    expect(notices()).toContain("401 no account here");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("channels that do not load name the channels, and nothing else", async () => {
    await openTheClient({
      server: aServer({ channels: vi.fn(async () => { throw new Error("503 nothing came back"); }) }),
    });

    // Signed in, and the window says so: the stage that failed is the next one.
    expect(el("who").textContent).toBe("Alice");
    expect(notices()).toMatch(STAGE.channels);
    expect(notices()).not.toMatch(STAGE.signIn);
    expect(notices()).not.toMatch(STAGE.bridge);
    expect(notices()).toContain("503 nothing came back");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a bridge that does not answer names the bridge, and costs the toolbar only", async () => {
    // The agents panel is a detail of the toolbar; the room is the product. A
    // silent native side used to take the whole window down with it and blame
    // the server for it.
    await openTheClient({
      shell: aShell({ appDataDir: vi.fn(async () => { throw new Error("no answer from this machine"); }) }),
    });

    expect(el("channel-name").textContent).toBe("# meetings");
    expect(document.querySelectorAll("#messages .msg").length).toBe(1);
    expect(notices()).toMatch(STAGE.bridge);
    expect(notices()).not.toMatch(STAGE.signIn);
    expect(notices()).not.toMatch(STAGE.channels);
    expect(notices()).toContain("no answer from this machine");
    expect(blockingDialog).not.toHaveBeenCalled();
  });
});

describe("a turn that fails at the end", () => {
  const ask = async () => {
    el<HTMLInputElement>("input").value = "@claude what did we agree?";
    submit("composer");
    await settle();
  };
  const saidByTheAgent = (server: { agentSay: { mock: { calls: unknown[][] } } }) =>
    server.agentSay.mock.calls.map((call) => String(call[1]));

  test("an agent that failed is the agent's failure, and the run failed", async () => {
    // The half that already reads true, kept as the control for the half that
    // does not: the distinction is only worth anything if this stays as it is.
    const { server } = await openTheClient({
      bridge: aBridge({ prompt: vi.fn(async () => { throw new Error("the model refused"); }) }),
    });

    await ask();

    expect(saidByTheAgent(server).join()).toContain("the model refused");
    expect(server.finishRun).toHaveBeenCalledWith(7, "failed");
  });

  test("a reply that could not be posted is ours, not the agent's error", async () => {
    // The agent answered. What failed was this client putting the answer into
    // the room — and writing that into the room as "Agent error" attributes our
    // failure to somebody else's run, which is the one thing the record must
    // not do (Article D3). The run finishes as what it was, and the person is
    // told, in the room, that the answer they are waiting for did not land.
    const { server } = await openTheClient({
      server: aServer({ agentSay: vi.fn(async () => { throw new Error("500 not written"); }) }),
    });

    await ask();

    expect(saidByTheAgent(server)).toContain("here you go");
    expect(saidByTheAgent(server).some((body) => /agent error/i.test(body))).toBe(false);
    // The third argument is the turn's own summary (#97) — none here, since
    // the scripted prompt answers without one.
    expect(server.finishRun).toHaveBeenCalledWith(7, "succeeded", undefined);
    // What the room says about it is the room's wording; that it says anything
    // at all, and says what failed, is not.
    expect(notices()).toContain("500 not written");
    expect(blockingDialog).not.toHaveBeenCalled();
  });

  test("a status this client could not record is not the agent's error either", async () => {
    // `agentSay` is not the only call in that try. Closing the run is in there
    // too, and a fix that special-cases the reply alone leaves the same
    // mis-attribution one step further down: the agent answered, the room has
    // the answer, and the record would still say the agent errored because
    // this client could not mark the run finished.
    const { server } = await openTheClient({
      server: aServer({ finishRun: vi.fn(async () => { throw new Error("500 status not recorded"); }) }),
    });

    await ask();

    expect(saidByTheAgent(server)).toContain("here you go");
    expect(saidByTheAgent(server).some((body) => /agent error/i.test(body))).toBe(false);
    // Not the agent's error, and not nobody's either: swallowing it leaves a
    // run that reads as still going to everybody looking at the room.
    expect(notices()).toContain("500 status not recorded");
    expect(blockingDialog).not.toHaveBeenCalled();
  });
});
