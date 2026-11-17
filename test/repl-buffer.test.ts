// One console's state: what it copies, what it remembers, what it drops.
//
// The DOM shell over this is tabs and a scroll position. Everything that
// can be WRONG about a console is here — a line copied twice, a line never
// copied at all, a history that forgets what you were typing, a cap that
// drops the newest instead of the oldest — and none of it needs a browser
// to find.

import { describe, expect, it } from "vitest";
import { ReplTab, type ReplSource } from "../src/editor/repl-buffer.js";

/** A source whose output grows the way matron's and sclang's do. */
function source(name = "matron"): ReplSource & { out: string[]; sent: string[]; fail: string | null } {
  const out: string[] = [];
  const sent: string[] = [];
  return {
    name,
    out,
    sent,
    fail: null,
    lines: () => out,
    send(code: string) {
      sent.push(code);
      return this.fail;
    },
  };
}

describe("reading the output", () => {
  it("copies what is new and nothing twice", () => {
    const s = source();
    const t = new ReplTab(s);
    s.out.push("one", "two");
    expect(t.pull()).toBe(true);
    expect(t.shown).toEqual(["one", "two"]);
    expect(t.pull(), "nothing new to say").toBe(false);
    s.out.push("three");
    t.pull();
    expect(t.shown).toEqual(["one", "two", "three"]);
  });

  it("shows a backlog printed before anyone was watching", () => {
    // The whole reason this reads a LENGTH rather than subscribing: a
    // console opened an hour into a session shows the hour.
    const s = source();
    for (let i = 0; i < 500; i++) s.out.push(`line ${i}`);
    const t = new ReplTab(s);
    t.pull();
    expect(t.shown).toHaveLength(500);
    expect(t.shown[0]).toBe("line 0");
  });

  it("drops the OLDEST when the scrollback fills", () => {
    const s = source();
    const t = new ReplTab(s, 10);
    for (let i = 0; i < 25; i++) s.out.push(`line ${i}`);
    t.pull();
    expect(t.shown).toHaveLength(10);
    expect(t.shown[0], "the newest ten survive").toBe("line 15");
    expect(t.shown[9]).toBe("line 24");
  });

  it("splits a multi-line print into lines, as the console shows it", () => {
    const t = new ReplTab(source());
    t.put("one\ntwo\r\nthree");
    expect(t.shown).toEqual(["one", "two", "three"]);
  });

  it("clears the view without touching the source", () => {
    const s = source();
    const t = new ReplTab(s);
    s.out.push("kept");
    t.pull();
    t.clear();
    expect(t.shown).toEqual([]);
    expect(s.out, "the page's own log is not ours to lose").toEqual(["kept"]);
    // And what arrives after a clear still arrives.
    s.out.push("after");
    t.pull();
    expect(t.shown).toEqual(["after"]);
  });
});

describe("sending", () => {
  it("echoes the line, sends it, and says nothing more when it worked", () => {
    const s = source();
    const t = new ReplTab(s);
    expect(t.send("print(1)", true)).toBeNull();
    expect(s.sent).toEqual(["print(1)"]);
    expect(t.shown).toEqual(["matron > print(1)"]);
  });

  it("echoes the error, because nothing else would", () => {
    // `host.run` RETURNS the message instead of printing it, so a console
    // that did not echo would swallow every mistake made in it.
    const s = source();
    s.fail = "(norns-js):1: attempt to index a nil value";
    const t = new ReplTab(s);
    expect(t.send("x.y = 1", true)).toContain("attempt to index");
    expect(t.shown[1]).toContain("attempt to index");
  });

  it("picks up what the send itself printed", () => {
    const s = source();
    const t = new ReplTab(s);
    s.send = (code) => {
      s.out.push("hello");
      s.sent.push(code);
      return null;
    };
    t.send('print("hello")', true);
    expect(t.shown).toEqual(['matron > print("hello")', "hello"]);
  });
});

describe("the history", () => {
  it("walks back and forward, and gives the draft back at the end", () => {
    const t = new ReplTab(source());
    t.send("first", true);
    t.send("second", true);
    expect(t.up("half typed")).toBe("second");
    expect(t.up("")).toBe("first");
    expect(t.up(""), "there is nothing before the first").toBeNull();
    expect(t.down()).toBe("second");
    expect(t.down(), "and the draft comes back").toBe("half typed");
    expect(t.down(), "past the end is nowhere").toBeNull();
  });

  it("does not remember the same line twice in a row", () => {
    const t = new ReplTab(source());
    t.send("again", true);
    t.send("again", true);
    t.send("different", true);
    expect(t.history).toEqual(["again", "different"]);
  });

  it("does not remember an eval from the editor", () => {
    // The history is what was typed HERE; an eval is already in the file
    // it came from, and filling the history with it would bury what you
    // actually typed.
    const t = new ReplTab(source());
    t.send("typed", true);
    t.send("evaluated", false);
    expect(t.history).toEqual(["typed"]);
    expect(t.shown[1], "it is still shown, though").toContain("evaluated");
  });
});
