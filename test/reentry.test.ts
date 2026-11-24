// E9-212 — a server send that starts inside another one waits for it.
//
// The freeze it guards against needs scsynth's threads and a busy machine
// to happen for real, so it is modelled here: a native `sendOsc` that holds
// a lock (scsynth's mDriverLock) while it "waits" (emscripten's yield), and
// runs whatever has been queued for the main thread during that wait — the
// way the page ran `onOscReply -> pump -> forward -> sendOsc` in the
// debugger. The first test shows the model deadlocks without the guard;
// the rest show it does not with it.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { serialiseSend } from "../src/engine/reentry.js";

/** scsynth's `sendOsc`, as far as this bug is concerned. */
function fakeServer() {
  let locked = false;
  let depth = 0;
  let deepest = 0;
  const sent: string[] = [];
  /** Queued main-thread calls, run while a send is waiting on the allocator. */
  const queued: Array<() => void> = [];
  const native = (packet: string): void => {
    depth++;
    deepest = Math.max(deepest, depth);
    if (locked) {
      depth--;
      throw new Error(`self-deadlock: ${packet} waits for a lock its own caller holds`);
    }
    locked = true;
    try {
      sent.push(packet);
      // MsgFifo::Free -> free -> contended -> _emscripten_yield.
      while (queued.length > 0) queued.shift()!();
    } finally {
      depth--;
      locked = false;
    }
  };
  return { native, sent, queued, deepest: () => deepest };
}

describe("a server send inside a server send", () => {
  it("deadlocks in the model when nothing stops it", () => {
    const s = fakeServer();
    s.queued.push(() => s.native("/s_new"));
    expect(() => s.native("/b_setn")).toThrow(/self-deadlock/);
    expect(s.deepest()).toBe(2);
  });

  it("waits for the outer send, then goes, in order", () => {
    const s = fakeServer();
    const send = serialiseSend(s.native);
    s.queued.push(() => send("/s_new"));
    send("/b_setn");
    expect(s.sent).toEqual(["/b_setn", "/s_new"]);
    expect(send.deferred).toBe(1);
  });

  it("keeps the order through a chain of re-entries", () => {
    const s = fakeServer();
    const send = serialiseSend(s.native);
    // A reply that sends two packets, one of which is answered by a reply
    // that sends another — all while some send is inside the server.
    s.queued.push(() => {
      send("a");
      s.queued.push(() => send("c"));
      send("b");
    });
    send("outer");
    send("after");
    expect(s.sent).toEqual(["outer", "a", "b", "c", "after"]);
    expect(send.deferred).toBe(3);
  });

  it("never runs the native send twice at once", () => {
    const s = fakeServer();
    const send = serialiseSend(s.native);
    for (let i = 0; i < 50; i++) s.queued.push(() => send(`r${i}`));
    send("x");
    expect(s.sent).toEqual(["x", ...Array.from({ length: 50 }, (_, i) => `r${i}`)]);
    expect(s.deepest()).toBe(1);
  });

  it("is not left stuck, or out of order, by a send that throws", () => {
    const sent: string[] = [];
    let fail = true;
    let reenter: (() => void) | null = null;
    const send = serialiseSend((p: string) => {
      if (reenter) {
        const r = reenter;
        reenter = null;
        r();
      }
      if (p === "bad" && fail) throw new Error("embind threw");
      sent.push(p);
    });
    reenter = () => send("queued");
    expect(() => send("bad")).toThrow("embind threw");
    fail = false;
    send("next");
    expect(sent).toEqual(["queued", "next"]);
  });
});

describe("host.ts", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "engine", "host.ts"), "utf8");

  it("guards scsynth's sendOsc as soon as the module exists", () => {
    const made = src.indexOf("await ScSynth(");
    expect(made, "the module is no longer made with ScSynth").toBeGreaterThan(-1);
    const guarded = src.indexOf("scsynth.sendOsc = serverSend", made);
    expect(guarded, "scsynth.sendOsc is no longer replaced by the guard").toBeGreaterThan(-1);
    expect(src.slice(made, guarded)).toMatch(/serialiseSend<Uint8Array>\(scsynth\.sendOsc\.bind\(scsynth\)\)/);
    // Nothing touches the server between creating it and guarding it.
    const between = src
      .slice(src.indexOf("\n", made), guarded)
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(between).not.toMatch(/scsynth\.(sendOsc\(|onOscReply|boot)/);
  });
});
