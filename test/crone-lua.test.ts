// E4-07/08/09 — the Lua boundary of crone.
//
// The question a test can answer here is coverage, and it is worth answering
// because the alternative is counting by hand: `src/crone/lua-surface.json`
// is derived from weaver.cc, oracle.cc and crone.h, so if upstream adds a
// `level_*` the manifest grows and this fails until someone decides what to
// do about it. The failure mode without it is a `_norns` function that
// silently stays a stub.
//
// The second question is the id mapping, which is derived but worth pinning
// at three places where the names deliberately disagree.

import { describe, expect, it, vi } from "vitest";
import { NornsRegistry } from "../src/norns/registry.js";
import { registerCrone, croneEvents, CRONE_DEFERRED, CRONE_NEEDS_FILES } from "../src/crone/register.js";
import type { Crone } from "../src/crone/crone.js";
import type { Callbacks } from "../src/norns/callbacks.js";
import surface from "../src/crone/lua-surface.json" with { type: "json" };

/** A decoder that needs no browser: one second of a ramp, at 44.1 kHz. */
function fakeDecoder(channels = 1, frames = 44100, rate = 44100) {
  return async (_bytes: Uint8Array) => ({
    numberOfChannels: channels,
    length: frames,
    sampleRate: rate,
    getChannelData: (c: number) => Float32Array.from({ length: frames }, (_v, i) => (i % 100) / 100 + c),
  });
}

function harness(withFiles = true) {
  const commands: Array<{ name: string; args: number[] }> = [];
  const params: Array<{ name: string; args: number[] }> = [];
  const polls: Array<{ name: string; on: boolean }> = [];
  const posted: unknown[] = [];
  const logs: string[] = [];

  const crone = {
    node: { port: { postMessage: (m: unknown) => posted.push(m) } },
    command: (name: string, ...args: number[]) => commands.push({ name, args }),
    param: (name: string, ...args: number[]) => {
      // The real one refuses an unknown name before it crosses, because
      // crone aborts on one. The fake refuses the same way.
      if (!KNOWN_PARAMS.has(name)) throw new Error(`crone: no parameter "${name}"`);
      params.push({ name, args });
    },
    poll: async (name: string, on: boolean) => {
      polls.push({ name, on });
      return name !== "nope";
    },
  } as unknown as Crone;

  const calls: Array<{ entry: string; args: unknown[] }> = [];
  (crone as unknown as Record<string, unknown>)["call"] = (
    entry: string,
    _types: string[],
    args: unknown[],
  ) => calls.push({ entry, args });
  const preloads: unknown[] = [];
  (crone as unknown as Record<string, unknown>)["preloadFile"] = async (spec: unknown) => {
    preloads.push(spec);
    return true;
  };
  (crone as unknown as Record<string, unknown>)["dropFile"] = () => {};
  (crone as unknown as Record<string, unknown>)["feedTape"] = () => {};
  (crone as unknown as Record<string, unknown>)["resetTape"] = () => {};

  const written: Array<{ path: string; bytes: Uint8Array }> = [];
  const vfs = {
    read: (path: string) => (path.includes("missing") ? null : new Uint8Array([1, 2, 3])),
    write: (path: string, bytes: Uint8Array) => written.push({ path, bytes }),
  } as unknown as import("../src/fs/vfs.js").Vfs;

  const stubs: Array<{ name: string; why: string }> = [];
  const registry = new NornsRegistry();
  // `exactOptionalPropertyTypes` is on, so an absent `files` has to be an
  // absent KEY, not a key set to undefined. That is the point of the flag
  // and the reason this is spelled out rather than ternaried in place.
  registerCrone(registry, crone, {
    log: (l: string) => void logs.push(l),
    onStub: (name: string, why: string) => void stubs.push({ name, why }),
    ...(withFiles ? { files: { vfs, decode: fakeDecoder() } } : {}),
  });
  const call = (name: string, ...args: unknown[]): unknown =>
    registry.implementationFor(name)!(...(args as never[]));
  return { commands, params, polls, posted, logs, registry, call, calls, preloads, written, stubs, vfs };
}

const KNOWN_PARAMS = new Set(["rate", "buffer", "voice_sync", "hf_damp", "ratio", "position"]);

const NAMES = (surface.functions as Array<{ name: string }>).map((f) => f.name);

describe("coverage against the derived surface", () => {
  it("the manifest is the 62 of p1-api-plan §0.3", () => {
    // Two independent counts agreeing is the only reason to trust either.
    expect(NAMES).toHaveLength(62);
  });

  it("every crone-bound _norns function is implemented or deferred by name", () => {
    const h = harness();
    const missing = NAMES.filter(
      (n) => !h.registry.implementationFor(n) && !(n in CRONE_DEFERRED),
    );
    expect(missing).toEqual([]);
  });

  it("nothing is deferred that is not in the surface", () => {
    const stray = Object.keys(CRONE_DEFERRED).filter((n) => !NAMES.includes(n));
    expect(stray).toEqual([]);
  });

  it("nothing is both implemented and deferred", () => {
    const h = harness();
    const both = Object.keys(CRONE_DEFERRED).filter((n) => h.registry.implementationFor(n));
    expect(both).toEqual([]);
  });

  it("all 62 are live when a filesystem is supplied", () => {
    const h = harness(true);
    const live = NAMES.filter((n) => h.registry.implementationFor(n));
    expect(live).toHaveLength(62);
    expect(Object.keys(CRONE_DEFERRED)).toHaveLength(0);
  });

  it("without one, the sixteen that need it stay stubs and say so", () => {
    // A page can wire crone with no filesystem — both spike pages do — and
    // the sixteen must not half-exist. A stub is visible; a function that
    // throws on call takes a script down at load.
    const h = harness(false);
    const live = NAMES.filter((n) => h.registry.implementationFor(n));
    expect(live).toHaveLength(62 - CRONE_NEEDS_FILES.length);
    expect(h.stubs.map((s) => s.name).sort()).toEqual([...CRONE_NEEDS_FILES].sort());
  });
});

describe("the three places the names deliberately disagree", () => {
  // Each of these is a Lua name whose command is called something else. A
  // hand-written table would plausibly have reached for a name that exists
  // and means something different.
  it("level_cut_rev is SET_LEVEL_CUT_AUX, not SET_LEVEL_CUT", () => {
    const h = harness();
    h.call("level_cut_rev", 0.7);
    expect(h.commands.at(-1)).toEqual({ name: "SET_LEVEL_CUT_AUX", args: [0.7] });
  });

  it("level_monitor_rev is SET_LEVEL_MONITOR_AUX", () => {
    const h = harness();
    h.call("level_monitor_rev", 0.3);
    expect(h.commands.at(-1)).toEqual({ name: "SET_LEVEL_MONITOR_AUX", args: [0.3] });
  });

  it("comp_mix is SET_LEVEL_INS_MIX — the compressor is an insert", () => {
    const h = harness();
    h.call("comp_mix", 1);
    expect(h.commands.at(-1)).toEqual({ name: "SET_LEVEL_INS_MIX", args: [1] });
  });
});

describe("arity and argument order", () => {
  it("level_input_cut passes three, in order", () => {
    const h = harness();
    h.call("level_input_cut", 1, 2, 0.5);
    expect(h.commands.at(-1)).toEqual({ name: "SET_LEVEL_IN_CUT", args: [1, 2, 0.5] });
  });

  it("cut_enable is (voice, value)", () => {
    const h = harness();
    h.call("cut_enable", 3, 1);
    expect(h.commands.at(-1)).toEqual({ name: "SET_ENABLED_CUT", args: [3, 1] });
  });

  it("rev_on and rev_off are the same command with 1 and 0", () => {
    const h = harness();
    h.call("rev_on");
    h.call("rev_off");
    expect(h.commands.slice(-2)).toEqual([
      { name: "SET_ENABLED_REVERB", args: [1] },
      { name: "SET_ENABLED_REVERB", args: [0] },
    ]);
  });

  it("monitor_mix_mono is four entries at 0.5, stereo is the diagonal", () => {
    const h = harness();
    h.call("monitor_mix_mono");
    expect(h.commands.slice(-4).map((c) => c.args)).toEqual([
      [0, 0.5],
      [1, 0.5],
      [2, 0.5],
      [3, 0.5],
    ]);
    h.call("monitor_mix_stereo");
    expect(h.commands.slice(-4).map((c) => c.args)).toEqual([
      [0, 1],
      [1, 0],
      [2, 0],
      [3, 1],
    ]);
  });
});

describe("named parameters", () => {
  it("cut_param forwards the name and both numbers", () => {
    const h = harness();
    h.call("cut_param", "rate", 0, 1.5);
    expect(h.params.at(-1)).toEqual({ name: "rate", args: [0, 1.5] });
  });

  it("cut_param_iif takes four", () => {
    const h = harness();
    h.call("cut_param_iif", "voice_sync", 0, 1, 0.25);
    expect(h.params.at(-1)).toEqual({ name: "voice_sync", args: [0, 1, 0.25] });
  });

  it("an unknown name is logged, not thrown", () => {
    // crone resolves names with `std::map::at` inside a try, and this build
    // has exceptions off — so an unknown name aborts the module. It is
    // refused before it crosses; and refusing must not take the script down
    // either, because a script asking for a parameter that does not exist is
    // a script bug, not an audio failure.
    const h = harness();
    expect(() => h.call("cut_param", "no_such_param", 0, 1)).not.toThrow();
    expect(h.params).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("no_such_param"))).toBe(true);
  });
});

describe("polls", () => {
  it("the six map onto three names and a direction", () => {
    const h = harness();
    h.call("poll_start_vu");
    h.call("poll_stop_vu");
    h.call("poll_start_cut_phase");
    h.call("poll_stop_tape");
    expect(h.polls).toEqual([
      { name: "vu", on: true },
      { name: "vu", on: false },
      { name: "softcut/phase", on: true },
      { name: "tape", on: false },
    ]);
  });

  it("cut_query_position asks and returns nothing", () => {
    // The answer comes back later as `_norns.softcut_position`, through the
    // ring. Returning a value here would be inventing one.
    const h = harness();
    expect(h.call("cut_query_position", 2)).toBeUndefined();
    expect(h.posted.at(-1)).toMatchObject({ entry: "cronejs_cut_query_position", args: [2] });
  });
});

describe("the events going the other way", () => {
  function cbSpy() {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const cb = new Proxy(
      {},
      {
        get: (_t, name: string) =>
          (...args: unknown[]) => {
            calls.push({ name, args });
            return null;
          },
      },
    ) as unknown as Callbacks;
    return { cb, calls };
  }

  it("softcut_render is (voice, START, sec_per_sample, samples)", () => {
    // `w_handle_softcut_render` takes sec_per_sample BEFORE start and pushes
    // start BEFORE sec_per_sample. Following the signature instead of the
    // pushes draws the waveform at the wrong scale, which looks like a
    // rendering bug rather than an argument order.
    const { cb, calls } = cbSpy();
    croneEvents(cb).softcutRender!({
      channel: 1,
      secPerSample: 0.01,
      start: 2.5,
      count: 2,
      samples: new Float32Array([0.1, 0.2]),
    });
    expect(calls.at(-1)!.name).toBe("softcutRender");
    expect(calls.at(-1)!.args.slice(0, 3)).toEqual([1, 2.5, 0.01]);
  });

  it("tape_status keeps all six fields in upstream's order", () => {
    const { cb, calls } = cbSpy();
    croneEvents(cb).tapeStatus!({
      playState: 1,
      playPos: 2,
      playLen: 3,
      recState: 4,
      recPos: 5,
      loop: 6,
    });
    expect(calls.at(-1)!.args).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a vu frame that is not twelve levels is reported, not sent", () => {
    const log = vi.fn();
    const { cb, calls } = cbSpy();
    // `makeCallbacks` is the one that refuses; here the point is that the
    // refusal is logged rather than swallowed on the way back from the
    // audio thread.
    croneEvents(cb, log).vu!([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(calls.at(-1)!.name).toBe("vu");
  });
});
