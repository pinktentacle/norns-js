// E9-239 — osc.send to localhost reaches the programs on this norns.

import { describe, expect, it } from "vitest";
import { NornsRegistry } from "../src/norns/registry.js";
import { registerOsc } from "../src/osc/register.js";
import { decode, encodeMessage, OscFloat } from "../src/engine/osc.js";

/** The arguments with OscFloat unwrapped, to compare values. */
const plain = (args: unknown[]): unknown[] => args.map((a) => (a instanceof OscFloat ? a.value : a));

function setup(remoteSends: unknown[] | null = null) {
  const r = new NornsRegistry();
  const local: Array<[number, string, unknown[]]> = [];
  const logs: string[] = [];
  registerOsc(r, {
    remote: remoteSends === null ? null : ({ send: (...a: unknown[]) => remoteSends.push(a) } as never),
    local: (port, path, args) => {
      if (port !== 57120 && port !== 57110 && port !== 10111) return false;
      local.push([port, path, args]);
      return true;
    },
    log: (l) => logs.push(l),
  });
  const send = r.implementationFor("osc_send")!;
  return { send, local, logs };
}

describe("osc.send to localhost", () => {
  it("delivers to sclang, scsynth and matron without a relay", () => {
    const { send, local, logs } = setup();
    send(["localhost", "57120"], "/nb_smpkit/trig", [1, 0.8]);
    send(["127.0.0.1", 57110], "/n_set", [1000, "freq", 220]);
    send(["localhost", "10111"], "/self", ["hi"]);
    expect(local.map(([port, path, args]) => [port, path, plain(args)])).toEqual([
      [57120, "/nb_smpkit/trig", [1, 0.8]],
      [57110, "/n_set", [1000, "freq", 220]],
      [10111, "/self", ["hi"]],
    ]);
    expect(logs).toEqual([]);
  });

  // E9-274 — as weaver.cc's _osc_send types them.
  it("types the arguments as matron does: numbers as floats, booleans and nil kept", () => {
    const { send, local } = setup();
    send(["localhost", "57120"], "/hs010/note_on", [36, 0.875, false, true, null, "s"]);
    const args = local[0]![2];
    expect(args[0]).toBeInstanceOf(OscFloat);
    expect(args[1]).toBeInstanceOf(OscFloat);
    expect(plain(args)).toEqual([36, 0.875, false, true, null, "s"]);
    const bytes = encodeMessage("/hs010/note_on", args as never);
    expect((decode(bytes) as { args: unknown[] }).args).toEqual([36, 0.875, false, true, null, "s"]);
  });

  it("leaves out what matron refuses (a table, a function)", () => {
    const { send, local } = setup();
    send(["localhost", "57120"], "/x", [1, { a: 1 }, () => 0, "y"] as never);
    expect(plain(local[0]![2])).toEqual([1, "y"]);
  });

  it("still needs the relay for anything else, and says so once", () => {
    const { send, local, logs } = setup();
    send(["192.168.1.20", "9000"], "/x", [1]);
    send(["localhost", "7000"], "/y", [1]); // a port nothing here listens on
    expect(local).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/no relay/);
  });

  it("sends the rest through the relay when there is one", () => {
    const remote: unknown[] = [];
    const { send } = setup(remote);
    send(["192.168.1.20", "9000"], "/x", [1]);
    expect(remote).toEqual([["192.168.1.20", 9000, "/x", [1]]]);
  });
});
