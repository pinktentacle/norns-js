// E5-07 — MIDI, where the interesting cases are matron's shape rather than
// the MIDI specification's.

import { describe, expect, it } from "vitest";
import { MidiDevice, chunkForLua, isRealTime, type MidiPort } from "../src/midi/device.js";
import { MidiManager } from "../src/midi/manager.js";
import { createVirtualMidiPort } from "../src/midi/virtual.js";
import { registerMidi } from "../src/midi/register.js";
import { pairPorts, startWebMidi, type WebMidiAccessLike, type WebMidiPortLike } from "../src/midi/web.js";
import { NornsRegistry } from "../src/norns/registry.js";

function port(name = "Keystep", id = name): MidiPort & { sent: number[][] } {
  const sent: number[][] = [];
  return {
    descriptor: { id, name },
    send: (b) => sent.push([...b]),
    sent,
  };
}

function device(p = port()) {
  const events: number[][] = [];
  const clock: number[] = [];
  const d = new MidiDevice(0, p, {
    event: (b) => events.push([...b]),
    clockByte: (b) => clock.push(b),
  });
  return { d, p, events, clock };
}

describe("the shape Lua is handed", () => {
  it("passes an ordinary message through whole", () => {
    expect(chunkForLua([0x90, 60, 100])).toEqual([[0x90, 60, 100]]);
    expect(chunkForLua([0xc0, 7])).toEqual([[0xc0, 7]]);
    expect(chunkForLua([0xf8])).toEqual([[0xf8]]);
  });

  it("CUTS SYSEX INTO 3-BYTE CHUNKS, which is what device_midi.cc does", () => {
    // `midi_msg_len(0xF0)` returns 3 — "special case, deliver sysex to lua
    // in 3 byte chunks". A script reading sysex reassembles it from these.
    expect(chunkForLua([0xf0, 1, 2, 3, 4, 5, 0xf7])).toEqual([
      [0xf0, 1, 2],
      [3, 4, 5],
      [0xf7],
    ]);
  });

  it("lets the terminator land inside a chunk when the length works out", () => {
    expect(chunkForLua([0xf0, 1, 2, 3, 4, 0xf7])).toEqual([
      [0xf0, 1, 2],
      [3, 4, 0xf7],
    ]);
  });

  it("knows which bytes are real time", () => {
    expect([0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff].every(isRealTime)).toBe(true);
    expect([0x90, 0xf0, 0xf7, 0xf2].some(isRealTime)).toBe(false);
  });
});

describe("the device", () => {
  it("gives a real-time byte to BOTH the clock and Lua", () => {
    // `dev_midi_consume_buffer` does not route — it does both, in that order.
    const { d, events, clock } = device();
    d.receive([0xf8]);
    expect(clock).toEqual([0xf8]);
    expect(events).toEqual([[0xf8]]);
  });

  it("starts with clock reception ON, as device_midi.cc:108 does", () => {
    const { d } = device();
    expect(d.clockEnabledNow).toBe(true);
  });

  it("stops giving the clock bytes when a script opts out, but still tells Lua", () => {
    const { d, events, clock } = device();
    d.clockReceive(false);
    d.receive([0xfa]);
    expect(clock).toEqual([]);
    expect(events).toEqual([[0xfa]]);
  });

  it("sends what it is given, byte for byte", () => {
    const { d, p } = device();
    d.send([0x90, 60, 127]);
    expect(p.sent).toEqual([[0x90, 60, 127]]);
  });

  it("ignores an empty message rather than reporting one", () => {
    const { d, events } = device();
    d.receive([]);
    expect(events).toEqual([]);
  });
});

describe("the manager", () => {
  function bridge() {
    const added: Array<[number, string]> = [];
    const removed: number[] = [];
    const events: Array<[number, number[]]> = [];
    const m = new MidiManager({
      midiAdd: (id, name) => added.push([id, name]),
      midiRemove: (id) => removed.push(id),
      midiEvent: (id, b) => events.push([id, [...b]]),
    });
    return { m, added, removed, events };
  }

  it("never reuses an id", () => {
    const { m, added } = bridge();
    const a = m.add(port("A"));
    m.remove(a.id);
    const b = m.add(port("B"));
    expect(b.id).not.toBe(a.id);
    expect(added.map(([, n]) => n)).toEqual(["A", "B"]);
  });

  it("does not add the same port twice", () => {
    // Web MIDI fires statechange for both halves of one device.
    const { m, added } = bridge();
    const p = port("Keystep");
    const a = m.add(p);
    const b = m.add(p);
    expect(b.id).toBe(a.id);
    expect(added.length).toBe(1);
  });

  it("routes an event under the device's own id", () => {
    const { m, events } = bridge();
    const a = m.add(port("A"));
    m.add(port("B"));
    a.receive([0xb0, 1, 64]);
    expect(events).toEqual([[a.id, [0xb0, 1, 64]]]);
  });
});

describe("pairing the browser's two lists", () => {
  function access(ins: string[], outs: string[]): WebMidiAccessLike {
    const mk = (names: string[], tag: string): Map<string, WebMidiPortLike> => {
      const m = new Map<string, WebMidiPortLike>();
      names.forEach((n, i) => {
        m.set(`${tag}${i}`, { id: `${tag}${i}`, name: n, state: "connected", send: () => {} });
      });
      return m;
    };
    return { inputs: mk(ins, "i"), outputs: mk(outs, "o"), onstatechange: null };
  }

  it("joins the input and the output that share a name", () => {
    const p = pairPorts(access(["Keystep"], ["Keystep"]));
    expect(p.length).toBe(1);
    expect(p[0]!.name).toBe("Keystep");
    expect(p[0]!.input).toBeDefined();
    expect(p[0]!.output).toBeDefined();
  });

  it("keeps a one-directional device, as a device with one direction", () => {
    const p = pairPorts(access(["Faderfox"], []));
    expect(p.length).toBe(1);
    expect(p[0]!.output).toBeUndefined();
  });

  it("makes two devices out of two identical controllers", () => {
    const p = pairPorts(access(["Launchpad", "Launchpad"], ["Launchpad", "Launchpad"]));
    expect(p.length).toBe(2);
    // Distinct keys, same NAME — Lua's vport.get_unique_device_name is what
    // disambiguates the name, and doing it here too would rename it twice.
    expect(new Set(p.map((x) => x.key)).size).toBe(2);
    expect(p.every((x) => x.name === "Launchpad")).toBe(true);
  });

  it("ignores a disconnected port", () => {
    const a = access(["Keystep"], ["Keystep"]);
    (([...a.inputs.values()][0]) as { state: string }).state = "disconnected";
    const p = pairPorts(a);
    expect(p[0]!.input).toBeUndefined();
  });
});

describe("Web MIDI startup", () => {
  function fakeAccess(): WebMidiAccessLike & { fire: () => void } {
    const inputs = new Map<string, WebMidiPortLike>();
    const outputs = new Map<string, WebMidiPortLike>();
    const a = {
      inputs,
      outputs,
      onstatechange: null as ((e: { port: WebMidiPortLike }) => void) | null,
      fire(): void {
        a.onstatechange?.({ port: { id: "x", name: "x", state: "connected" } });
      },
    };
    return a;
  }

  it("falls back to a session without sysex rather than giving up", async () => {
    const asked: boolean[] = [];
    const a = fakeAccess();
    const m = new MidiManager({ midiAdd: () => {}, midiRemove: () => {}, midiEvent: () => {} });
    const w = await startWebMidi(m, {
      request: ({ sysex }) => {
        asked.push(sysex);
        return sysex ? Promise.reject(new Error("refused")) : Promise.resolve(a);
      },
    });
    expect(asked).toEqual([true, false]);
    expect(w?.sysex).toBe(false);
  });

  it("returns null when there is no Web MIDI at all", async () => {
    const m = new MidiManager({ midiAdd: () => {}, midiRemove: () => {}, midiEvent: () => {} });
    const w = await startWebMidi(m, { request: () => Promise.reject(new Error("nope")) });
    expect(w).toBeNull();
  });

  it("adds on connect and removes on disconnect, without duplicating", async () => {
    const a = fakeAccess();
    const added: string[] = [];
    const removed: number[] = [];
    const m = new MidiManager({
      midiAdd: (_id, name) => added.push(name),
      midiRemove: (id) => removed.push(id),
      midiEvent: () => {},
    });
    const w = await startWebMidi(m, { request: () => Promise.resolve(a) });
    expect(added).toEqual([]);

    a.inputs.set("i0", { id: "i0", name: "Keystep", state: "connected" });
    a.outputs.set("o0", { id: "o0", name: "Keystep", state: "connected", send: () => {} });
    a.fire();
    expect(added).toEqual(["Keystep"]);

    a.fire(); // a second statechange for the other half of the same device
    expect(added).toEqual(["Keystep"]);

    a.inputs.delete("i0");
    a.outputs.delete("o0");
    a.fire();
    expect(removed.length).toBe(1);
    expect(w).not.toBeNull();
  });

  it("carries a message from the browser through to the Lua bridge", async () => {
    const a = fakeAccess();
    const events: Array<[number, number[]]> = [];
    const m = new MidiManager({
      midiAdd: () => {},
      midiRemove: () => {},
      midiEvent: (id, b) => events.push([id, [...b]]),
    });
    const input: WebMidiPortLike = { id: "i0", name: "Keystep", state: "connected" };
    a.inputs.set("i0", input);
    await startWebMidi(m, { request: () => Promise.resolve(a) });
    input.onmidimessage?.({ data: new Uint8Array([0x90, 64, 100]) });
    expect(events).toEqual([[0, [0x90, 64, 100]]]);
  });
});

describe("the two _norns functions", () => {
  function wired() {
    const sent: number[][] = [];
    const m = new MidiManager({ midiAdd: () => {}, midiRemove: () => {}, midiEvent: () => {} });
    const d = m.add({
      descriptor: { id: "A", name: "A" },
      send: (b) => sent.push([...b]),
    });
    const registry = new NornsRegistry();
    registerMidi(registry, m);
    const call = (name: string, args: unknown[]): void => {
      registry.implementationFor(name)!(...(args as never[]));
    };
    return { call, d, sent };
  }

  it("sends the table Lua built", () => {
    const { call, d, sent } = wired();
    call("midi_send", [d.id, [0x90, 60, 100]]);
    expect(sent).toEqual([[0x90, 60, 100]]);
  });

  it("masks to a byte rather than letting a bad value reach the browser", () => {
    const { call, d, sent } = wired();
    call("midi_send", [d.id, [0x190, 60, 100]]);
    expect(sent).toEqual([[0x90, 60, 100]]);
  });

  it("is a no-op for a device that has gone", () => {
    const { call, sent } = wired();
    call("midi_send", [999, [0x90, 60, 100]]);
    expect(sent).toEqual([]);
  });

  it("reads clock_receive as an INTEGER, so 0 disables", () => {
    // weaver.cc:1786 is `lua_tointeger` then `> 0`, not lua_toboolean —
    // the opposite of the grid's `rel`, and what Midi.update_clock_receive
    // relies on when it passes 1 and 0.
    const { call, d } = wired();
    call("midi_clock_receive", [d.id, 0]);
    expect(d.clockEnabledNow).toBe(false);
    call("midi_clock_receive", [d.id, 1]);
    expect(d.clockEnabledNow).toBe(true);
  });

  it("disables on a BOOLEAN, because lua_tointeger of a boolean is 0", () => {
    // core/midi.lua documents the argument as a boolean and passes 1 and 0.
    // A script that believes the documentation turns its own clock off, on
    // hardware as well as here.
    const { call, d } = wired();
    call("midi_clock_receive", [d.id, true]);
    expect(d.clockEnabledNow).toBe(false);
  });
});

describe("the virtual loopback", () => {
  it("returns what was sent, and not before the send has returned", async () => {
    const got: number[][] = [];
    const m = new MidiManager({
      midiAdd: () => {},
      midiRemove: () => {},
      midiEvent: (_id, b) => got.push([...b]),
    });
    const p = createVirtualMidiPort();
    const d = m.add(p);
    p.attach(d);
    d.send([0x90, 60, 100]);
    // Synchronous echo would re-enter the script's own handler from inside
    // its send, which no cable does.
    expect(got).toEqual([]);
    await Promise.resolve();
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(got).toEqual([[0x90, 60, 100]]);
  });

  it("chunks sysex on the way back, like any other device", async () => {
    const got: number[][] = [];
    const m = new MidiManager({
      midiAdd: () => {},
      midiRemove: () => {},
      midiEvent: (_id, b) => got.push([...b]),
    });
    const p = createVirtualMidiPort();
    const d = m.add(p);
    p.attach(d);
    d.send([0xf0, 1, 2, 3, 0xf7]);
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(got).toEqual([
      [0xf0, 1, 2],
      [3, 0xf7],
    ]);
  });

  it("stops echoing once detached", async () => {
    const got: number[][] = [];
    const m = new MidiManager({
      midiAdd: () => {},
      midiRemove: () => {},
      midiEvent: (_id, b) => got.push([...b]),
    });
    const p = createVirtualMidiPort();
    const d = m.add(p);
    p.attach(d);
    m.remove(d.id);
    d.send([0x90, 60, 100]);
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(got).toEqual([]);
  });
});
