// E9-199 — where a packet from sclang goes, read rather than decoded.
//
// The fast path is only allowed to exist if it is the old path. So the old
// path is still in the tree as `routeByDecoding`, and nearly everything here
// is one assertion: for this packet, both functions say the same thing.

import { describe, expect, it } from "vitest";
import { encodeMessage } from "../src/engine/osc.js";
import { onlyDefsAndSync, routeByDecoding, routeLangPacket, toMatron } from "../src/engine/lang-route.js";

type Arg = number | string | Uint8Array;

const msg = (address: string, args: Arg[] = []): Uint8Array => encodeMessage(address, args) as Uint8Array;

/** scsynth takes a command NUMBER where the address would be: four bytes. */
const numbered = (command: number, args: Arg[] = []): Uint8Array => {
  // An empty address encodes as one NUL padded to four, which is exactly
  // the shape; the number goes in the last of them.
  const out = msg("", args);
  out[3] = command;
  return out;
};

const bundle = (...parts: Uint8Array[]): Uint8Array => {
  const size = 16 + parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode("#bundle"), 0);
  const view = new DataView(out.buffer);
  view.setUint32(12, 1); // "immediately"
  let o = 16;
  for (const p of parts) {
    view.setInt32(o, p.length);
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
};

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** What a PolyPerc note is when it leaves sclang: `server.sendMsg(9, ...)`. */
const note = numbered(9, [
  "PolyPerc", 1013, 0, 1012, "out", 0, "freq", 220, "pw", 0.5, "amp", 0.3,
  "cutoff", 849, "gain", 2, "release", 0.5, "pan", 0,
]);

const real: Array<[string, Uint8Array]> = [
  ["a note, by command number", note],
  ["n_set by command number", numbered(15, [1013, "cutoff", 1200.5])],
  ["n_free by command number", numbered(11, [1013])],
  ["a plain /n_set", msg("/n_set", [1013, "cutoff", 900])],
  ["a plain /s_new", msg("/s_new", ["PolyPerc", 1014, 0, 1])],
  ["sclang asking after the server", msg("/status")],
  ["/sync", msg("/sync", [7])],
  ["/d_recv", msg("/d_recv", [bytes(83, 67, 103, 102, 0, 0, 0, 2)])],
  ["/d_recv with nothing in it", msg("/d_recv")],
  ["a crone command", msg("/crone/level/adc", [0.5])],
  ["a report", msg("/report/engines/entry", [3, "PolyPerc"])],
  ["a poll value", msg("/poll/value", [2, 0.25])],
  ["the data of a poll", msg("/poll/data", [2, bytes(1, 2, 3, 4)])],
  ["an address this port added", msg("/norns-js/osc", ["/hello", 10111, 1.5])],
  ["a bundle carrying the work and its /sync", bundle(msg("/b_alloc", [0, 44100, 2]), msg("/sync", [9]))],
  ["a bundle of two SynthDefs", bundle(msg("/d_recv", [bytes(1, 2)]), msg("/d_recv", [bytes(3)]))],
  ["a bundle that begins with matron", bundle(msg("/poll/value", [1, 2]), msg("/n_set", [1, "a", 2]))],
  ["a bundle of numbered commands", bundle(numbered(9, ["x", 1, 0, 1]), numbered(15, [1, "a", 2]))],
  ["a bundle inside a bundle", bundle(bundle(msg("/sync", [1])), msg("/d_recv", [bytes(9)]))],
  ["an empty bundle", bundle()],
];

// Addresses one character away from the ones that matter, which is where a
// prefix test and an equality test come apart if either is written wrong.
const nearly: Array<[string, Uint8Array]> = [
  "/", "/s", "/syn", "/sync", "/sync2", "/synced", "/d_rec", "/d_recv", "/d_recvx", "/d_recv/",
  "/crone", "/crone/", "/cron/x", "/crones/x", "/report", "/report/", "/reports/x",
  "/poll/data", "/poll/dat", "/poll/datax", "/poll/data/x", "/poll/value", "/poll/values",
  "/norns-js", "/norns-js/", "/norns-jsx/y", "/Crone/x", "/SYNC",
].map((a) => [`the address ${a}`, msg(a, [1, "two", 3.5])]);

const awkward: Array<[string, Uint8Array]> = [
  ["nothing at all", bytes()],
  ["one zero", bytes(0)],
  ["one slash", bytes(0x2f)],
  ["an address that runs to the end with no NUL", bytes(...ascii("/sync"))],
  ["a matron address with no NUL", bytes(...ascii("/crone/x"))],
  ["a byte-order mark before /sync", bytes(0xef, 0xbb, 0xbf, ...ascii("/sync"), 0, 0, 0, 0)],
  ["an overlong slash before crone", bytes(0xc0, 0xaf, ...ascii("crone/x"), 0, 0, 0, 0)],
  ["an overlong slash inside the prefix", bytes(0x2f, ...ascii("crone"), 0xc0, 0xaf, ...ascii("x"), 0, 0, 0)],
  ["two bytes of UTF-8 in a matron address", bytes(...ascii("/crone/"), 0xc3, 0xa9, 0, 0, 0)],
  ["two bytes of UTF-8 where the prefix would be", bytes(...ascii("/cr"), 0xc3, 0xb8, ...ascii("ne/x"), 0, 0)],
  ["a lone continuation byte after /sync", bytes(...ascii("/sync"), 0x80, 0, 0)],
  ["a high byte that is not UTF-8 at all", bytes(...ascii("/d_recv"), 0xff, 0, 0, 0, 0)],
  ["type tags that promise more than is there", bytes(...ascii("/n_set"), 0, 0, ...ascii(",iiii"), 0, 0, 0, 0, 0, 1)],
  ["a numbered command whose tags run off the end", bytes(0, 0, 0, 9, ...ascii(",fff"), 0, 0, 0, 0)],
  ["a bundle cut off inside its header", bytes(...ascii("#bundle"), 0, 0, 0)],
  ["a bundle whose element claims too much", bytes(...ascii("#bundle"), 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0)],
  ["the word bundle without the hash", bytes(...ascii("bundle"), 0, 0)],
];

const same = (p: Uint8Array, what: string): void => {
  expect(routeLangPacket(p), what).toEqual(routeByDecoding(p));
};

/** Deterministic, so a failure names a packet that can be made again. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the fast route is the old route", () => {
  for (const [what, p] of [...real, ...nearly, ...awkward]) {
    it(what, () => same(p, what));
  }

  it("for every packet above, cut off at every length", () => {
    // A truncated packet is where `decode` throws, and a throw is one of
    // the two ways the old logic reached its answer.
    let tried = 0;
    for (const [what, p] of [...real, ...nearly, ...awkward]) {
      for (let n = 0; n <= p.length; n++) {
        same(p.subarray(0, n), `${what}, first ${n} of ${p.length} bytes`);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(1500);
  });

  it("for every packet above, with any one byte of its head changed", () => {
    // The head is where the decision is made, so that is where a wrong
    // byte has to be shown to change both answers together.
    const values = [0, 0x2f, 0x23, 0x2c, 0x80, 0xff, 0x41];
    let tried = 0;
    for (const [what, p] of [...real, ...nearly]) {
      for (let at = 0; at < Math.min(p.length, 16); at++) {
        for (const v of values) {
          const q = Uint8Array.from(p);
          q[at] = v;
          same(q, `${what}, byte ${at} set to ${v}`);
          tried++;
        }
      }
    }
    expect(tried).toBeGreaterThan(4000);
  });

  it("for twenty thousand packets of noise", () => {
    const next = rng(199);
    const firsts = [0, 0x2f, 0x23];
    // Bytes weighted towards the ones an address is made of, or noise
    // would almost never spell a prefix and the test would prove nothing.
    const alphabet = ascii("/crone/report/poll/data/value/norns-js/sync/d_recv#bundle,ifs");
    for (let i = 0; i < 20000; i++) {
      const n = Math.floor(next() * 48);
      const p = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const r = next();
        p[k] = r < 0.6 ? alphabet[Math.floor(next() * alphabet.length)]! : r < 0.8 ? 0 : Math.floor(next() * 256);
      }
      if (n > 0 && next() < 0.7) p[0] = firsts[Math.floor(next() * firsts.length)]!;
      same(p, `noise #${i}: [${Array.from(p).join(",")}]`);
    }
  });

  it("for noise built out of the addresses that matter", () => {
    // Real prefixes with real bodies after them, then damaged.
    const next = rng(4242);
    const heads = ["/sync", "/d_recv", "/crone/a", "/report/b", "/poll/data", "/poll/value", "/norns-js/c", "/n_set"];
    for (let i = 0; i < 5000; i++) {
      const p = Uint8Array.from(msg(heads[Math.floor(next() * heads.length)]!, [1, "x", 2.5]));
      const hits = 1 + Math.floor(next() * 3);
      for (let h = 0; h < hits; h++) p[Math.floor(next() * p.length)] = Math.floor(next() * 256);
      same(p.subarray(0, 1 + Math.floor(next() * p.length)), `damaged #${i}: [${Array.from(p).join(",")}]`);
    }
  });
});

describe("what the route says, so the comparison is not two wrongs agreeing", () => {
  const server = { matron: null, hasSync: false, defs: 0 };

  it("sends a note to the server with nothing to wait for", () => {
    expect(routeLangPacket(note)).toEqual(server);
  });

  it("does not throw on a numbered command it could not have decoded", () => {
    const broken = bytes(0, 0, 0, 9, ...ascii(",fff"), 0, 0, 0, 0);
    expect(() => routeLangPacket(broken)).not.toThrow();
    expect(routeLangPacket(broken)).toEqual(server);
  });

  it("hands matron its message with the arguments decoded", () => {
    expect(routeLangPacket(msg("/poll/value", [2, 0.25]))).toEqual({
      matron: { address: "/poll/value", args: [2, 0.25] },
      hasSync: false,
      defs: 0,
    });
  });

  it("sees a /sync on its own and inside a bundle", () => {
    expect(routeLangPacket(msg("/sync", [7])).hasSync).toBe(true);
    expect(routeLangPacket(bundle(msg("/b_alloc", [0, 1, 2]), msg("/sync", [9]))).hasSync).toBe(true);
    expect(routeLangPacket(msg("/synced", [7])).hasSync).toBe(false);
  });

  it("counts every /d_recv, wherever it sits in a bundle", () => {
    expect(routeLangPacket(msg("/d_recv", [bytes(1)])).defs).toBe(1);
    expect(
      routeLangPacket(bundle(msg("/d_recv", [bytes(1)]), msg("/n_set", [1]), msg("/d_recv", [bytes(2)]))).defs,
    ).toBe(2);
    expect(routeLangPacket(msg("/d_recvx", [bytes(1)])).defs).toBe(0);
  });

  it("counts a /d_recv sent by number, as JITLib sends it (E9-246)", () => {
    expect(routeLangPacket(numbered(5, [bytes(1, 2)])).defs).toBe(1);
    expect(routeLangPacket(numbered(9, ["x", 1, 0, 1])).defs).toBe(0);
    // An Ndef: its def, its group and a /sync, in one bundle.
    const ndef = bundle(numbered(5, [bytes(1)]), numbered(21, [1100, 0, 1]), msg("/sync", [3]));
    expect(routeLangPacket(ndef)).toEqual({ matron: null, hasSync: true, defs: 1 });
    expect(routeLangPacket(bundle(bundle(numbered(5, [bytes(1)])), msg("/d_recv", [bytes(2)]))).defs).toBe(2);
  });

  it("knows what may follow a def straight into the server's own queue (E9-246)", () => {
    for (const p of [
      msg("/d_recv", [bytes(1)]),
      numbered(5, [bytes(1)]),
      msg("/sync", [4]),
      numbered(52, [4]),
      bundle(msg("/d_recv", [bytes(1)]), msg("/sync", [9])),
      bundle(bundle(numbered(5, [bytes(1)])), msg("/sync", [2])),
    ]) {
      expect(onlyDefsAndSync(p)).toBe(true);
    }
    for (const p of [
      note,
      msg("/s_new", ["x", 1, 0, 1]),
      msg("/synced", [1]),
      msg("/d_recvx", [bytes(1)]),
      bundle(numbered(5, [bytes(1)]), numbered(21, [1100, 0, 1]), msg("/sync", [3])),
      bundle(),
      bytes(),
      bytes(...ascii("#bundle"), 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0),
    ]) {
      expect(onlyDefsAndSync(p)).toBe(false);
    }
  });

  it("keeps the matron set closed", () => {
    for (const a of ["/crone/x", "/report/x", "/poll/data", "/poll/value", "/norns-js/x"]) {
      expect(toMatron(a), a).toBe(true);
    }
    for (const a of ["/crone", "/poll/values", "/poll/data/x", "/norns-js", "/n_set", "/sync", ""]) {
      expect(toMatron(a), a).toBe(false);
    }
  });
});
