import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Api, type CableSocket } from "../src/api";

// The socket is the client's one true external boundary, so it is the one thing
// a test may stand in for. `live()` takes the constructor; everything else in
// the path — the subscribe payload, the backoff, the resync — is the real code.
class FakeSocket implements CableSocket {
  static opened: FakeSocket[] = [];

  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) { FakeSocket.opened.push(this); }

  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }

  // What the browser does to us, driven by hand.
  connected() { this.onopen?.({}); }
  dropped() { this.onclose?.({}); }
  delivers(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }

  get subscribed() { return this.sent.map((s) => JSON.parse(s).identifier); }
}

const opened = () => FakeSocket.opened.length;
const last = () => FakeSocket.opened[FakeSocket.opened.length - 1];

function start() {
  const events: any[] = [];
  const resync = vi.fn();
  const api = new Api("http://127.0.0.1:3000", "tok");
  const live = api.live("meetings", (e) => events.push(e), resync, FakeSocket);
  return { events, resync, live };
}

/// One drop and the wait that answers it, so a test can walk the backoff out to
/// wherever it wants to look at it.
function dropAndWait(ms: number) {
  last().dropped();
  vi.advanceTimersByTime(ms);
  last().connected();
}

beforeEach(() => {
  FakeSocket.opened = [];
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);   // no jitter, unless a test asks
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the live socket", () => {
  test("subscribes to the room and to its own user stream", () => {
    start();
    last().connected();

    expect(last().url).toBe("ws://127.0.0.1:3000/cable?token=tok");
    expect(last().subscribed.map((i: string) => JSON.parse(i))).toEqual([
      { channel: "RoomChannel", slug: "meetings" },
      { channel: "UserChannel" },
    ]);
  });

  test("passes what the room says to the caller", () => {
    const { events } = start();
    last().connected();

    last().delivers({ type: "welcome" });
    last().delivers({ identifier: "…", message: { type: "message", message: { id: 1 } } });

    expect(events).toEqual([{ type: "message", message: { id: 1 } }]);
  });
});

describe("a socket that drops", () => {
  test("is opened again, and subscribes as it did the first time", () => {
    start();
    last().connected();

    last().dropped();
    expect(opened()).toBe(1);          // not in the same tick — the server may still be down

    vi.advanceTimersByTime(1000);
    expect(opened()).toBe(2);

    last().connected();
    expect(last().subscribed.map((i: string) => JSON.parse(i))).toEqual([
      { channel: "RoomChannel", slug: "meetings" },
      { channel: "UserChannel" },
    ]);
  });

  test("carries the room's events again once it is back", () => {
    const { events } = start();
    last().connected();
    dropAndWait(1000);

    last().delivers({ message: { type: "message", message: { id: 7 } } });

    expect(events).toEqual([{ type: "message", message: { id: 7 } }]);
  });

  test("waits longer after every attempt that fails", () => {
    start();
    last().connected();

    for (const wait of [1000, 2000, 4000, 8000]) {
      last().dropped();
      const before = opened();
      vi.advanceTimersByTime(wait - 1);
      expect(opened()).toBe(before);
      vi.advanceTimersByTime(1);
      expect(opened()).toBe(before + 1);
    }
  });

  test("stops waiting longer at half a minute", () => {
    start();
    last().connected();

    for (let i = 0; i < 10; i++) { last().dropped(); vi.advanceTimersByTime(30_000); }

    last().dropped();
    const before = opened();
    vi.advanceTimersByTime(29_999);
    expect(opened()).toBe(before);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(before + 1);
  });

  test("spreads the attempts out, so a server coming back is not hit by everyone at once", () => {
    vi.mocked(Math.random).mockReturnValue(0);
    start();
    last().connected();

    last().dropped();
    vi.advanceTimersByTime(499);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
  });

  test("waits from the start again after a socket that lived", () => {
    start();
    last().connected();
    dropAndWait(1000);
    dropAndWait(2000);   // the second attempt would wait 2s if nothing had reset it

    last().dropped();
    vi.advanceTimersByTime(1000);
    expect(opened()).toBe(4);
  });
});

describe("catching up after an outage", () => {
  test("the caller is asked to resync when the socket comes back", () => {
    const { resync } = start();
    last().connected();
    expect(resync).not.toHaveBeenCalled();   // nothing was missed on the first open

    dropAndWait(1000);

    expect(resync).toHaveBeenCalledTimes(1);
  });

  test("is asked only once the socket is actually open again", () => {
    const { resync } = start();
    last().connected();

    last().dropped();
    vi.advanceTimersByTime(1000);
    expect(resync).not.toHaveBeenCalled();   // the socket exists, nothing is subscribed yet

    last().connected();
    expect(resync).toHaveBeenCalledTimes(1);
  });
});

describe("what the outage missed", () => {
  const message = (id: number) => ({ id, body: `#${id}`, parent_id: null, author: { kind: "user", name: "alice" } });

  /// The channel as the server answers it. `meanwhile` runs while the request is
  /// in flight, which is where the case worth testing lives.
  function serves(messages: unknown[], meanwhile: () => void = () => {}) {
    vi.stubGlobal("fetch", async () => {
      meanwhile();
      return { ok: true, status: 200, json: async () => ({ slug: "meetings", messages }) };
    });
  }

  test("is whatever the channel holds past the newest message on hand", async () => {
    serves([ message(1), message(2), message(3) ]);

    const missed = await new Api("http://127.0.0.1:3000", "tok").caughtUp("meetings", [ message(1) ]);

    expect(missed).toEqual([ message(2), message(3) ]);
  });

  test("is nothing at all when the room did not move", async () => {
    serves([ message(1), message(2) ]);

    const missed = await new Api("http://127.0.0.1:3000", "tok").caughtUp("meetings", [ message(1), message(2) ]);

    expect(missed).toEqual([]);
  });

  // The mark has to be read before the channel is asked, not after. #4 lands on
  // the socket while the request is in flight; measuring afterwards would call
  // the room caught up at #4 and throw away the two the outage actually ate.
  test("is measured before the refetch, so a live message mid-round-trip hides nothing", async () => {
    const held = [ message(1) ];
    serves([ message(1), message(2), message(3), message(4) ], () => held.push(message(4)));

    const missed = await new Api("http://127.0.0.1:3000", "tok").caughtUp("meetings", held);

    expect(missed).toEqual([ message(2), message(3), message(4) ]);
  });
});

describe("a socket the caller closes", () => {
  test("closes the socket it holds", () => {
    const { live } = start();
    live.close();

    expect(last().closed).toBe(true);
  });

  test("does not come back — leaving a room is not an outage", () => {
    const { live, resync } = start();
    last().connected();

    live.close();
    last().dropped();               // the browser reports the close we asked for
    vi.advanceTimersByTime(60_000);

    expect(opened()).toBe(1);
    expect(resync).not.toHaveBeenCalled();
  });

  test("does not come back while a retry is still pending", () => {
    const { live } = start();
    last().connected();
    last().dropped();

    live.close();
    vi.advanceTimersByTime(60_000);

    expect(opened()).toBe(1);
  });
});
