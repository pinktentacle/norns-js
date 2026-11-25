// E9-239 — osc.send to localhost reaches the programs on this norns.

import { describe, expect, it } from "vitest";
import { NornsRegistry } from "../src/norns/registry.js";
import { registerOsc } from "../src/osc/register.js";

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
    expect(local).toEqual([
      [57120, "/nb_smpkit/trig", [1, 0.8]],
      [57110, "/n_set", [1000, "freq", 220]],
      [10111, "/self", ["hi"]],
    ]);
    expect(logs).toEqual([]);
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
