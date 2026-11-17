// E5-07 — Web MIDI, and the one thing it does not give you.
//
// PAIRING. ALSA gives matron one rawmidi device per piece of hardware, with
// both directions on it, so `dev_midi` has a read end and a write end and
// `Midi.devices[id]` is one object with `send` and `event`. Web MIDI gives
// two SEPARATE lists, `inputs` and `outputs`, with different `id`s and no
// statement anywhere that a given input and a given output are the same
// cable. The only thing they share is the name.
//
// So the pairing rule here is: group by name, and within a name pair the nth
// input with the nth output. It is right for every ordinary case (one device,
// one name, both directions) and it degrades sensibly for the two awkward
// ones -- a device with only one direction becomes a device with only that
// direction, and two identical controllers become two devices rather than one
// with a confused pair of ports.
//
// IDENTITY IS THE NAME, not the browser's port id, and that is not a
// shortcut. `core/state.lua:163` persists `midi.vports[i].name`, so a script
// that remembers "port 2 is my Keystep" remembers it BY NAME. Keying on
// `MIDIPort.id` -- which is per-origin and changes if the user clears site
// data -- would lose that binding for a reason the user cannot see.
//
// SYSEX IS ASKED FOR. Several bundled scripts read it (cheat_codes_2's Midi
// Fighter Twister and Faderfox EC4 handlers, zxcvbn's DX7 patches), and
// Chrome treats sysex as a stronger permission than plain MIDI. If it is
// refused, this falls back to a non-sysex session and SAYS so, because a
// script reading sysex will then see nothing at all and the reason should be
// in the log rather than inferred.

import { MidiManager } from "./manager.js";
import type { MidiDescriptor, MidiPort } from "./device.js";

/** Only what is used, so a test can supply it without a browser. */
export interface WebMidiPortLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  onmidimessage?: ((e: { data: Uint8Array; timeStamp?: number }) => void) | null;
  send?(data: number[] | Uint8Array): void;
  open?(): Promise<unknown>;
}

export interface WebMidiAccessLike {
  readonly inputs: Map<string, WebMidiPortLike>;
  readonly outputs: Map<string, WebMidiPortLike>;
  onstatechange: ((e: { port: WebMidiPortLike }) => void) | null;
  readonly sysexEnabled?: boolean;
}

export interface WebMidiOptions {
  readonly log?: (line: string) => void;
  /** Supplied by tests; the browser's `navigator.requestMIDIAccess` otherwise. */
  readonly request?: (opts: { sysex: boolean }) => Promise<WebMidiAccessLike>;
}

/** A device built from one input, one output, or both. */
interface Pair {
  readonly key: string;
  readonly name: string;
  input: WebMidiPortLike | undefined;
  output: WebMidiPortLike | undefined;
}

function portName(p: WebMidiPortLike): string {
  const n = (p.name ?? "").trim();
  return n === "" ? "unnamed" : n;
}

/**
 * Group both lists into devices.
 *
 * Insertion order is the browser's enumeration order, which is stable within
 * a session, so "the nth input with the nth output" is a consistent pairing
 * rather than an arbitrary one.
 */
export function pairPorts(access: WebMidiAccessLike): Pair[] {
  const byName = new Map<string, { ins: WebMidiPortLike[]; outs: WebMidiPortLike[] }>();
  const slot = (name: string) => {
    let s = byName.get(name);
    if (s === undefined) {
      s = { ins: [], outs: [] };
      byName.set(name, s);
    }
    return s;
  };
  for (const p of access.inputs.values()) {
    if (p.state === "disconnected") continue;
    slot(portName(p)).ins.push(p);
  }
  for (const p of access.outputs.values()) {
    if (p.state === "disconnected") continue;
    slot(portName(p)).outs.push(p);
  }

  const out: Pair[] = [];
  for (const [name, s] of byName) {
    const n = Math.max(s.ins.length, s.outs.length);
    for (let i = 0; i < n; i++) {
      out.push({
        key: i === 0 ? name : `${name}::${i}`,
        name,
        input: s.ins[i],
        output: s.outs[i],
      });
    }
  }
  return out;
}

/** The `MidiPort` a `MidiDevice` writes through. */
function makePort(pair: Pair, log: (l: string) => void): MidiPort {
  const descriptor: MidiDescriptor = { id: pair.key, name: pair.name };
  return {
    descriptor,
    send(bytes) {
      const out = pair.output;
      if (out?.send === undefined) {
        // An input-only device IS a device, and a script that sends to it
        // should not crash -- but silence would be a lie about where the
        // notes went.
        log(`midi: ${pair.name} has no output; ${bytes.length} bytes dropped`);
        return;
      }
      try {
        out.send([...bytes]);
      } catch (e) {
        // Web MIDI throws TypeError on a malformed message. The throw would
        // otherwise come out of the middle of a script's own code.
        log(`midi: ${pair.name} refused a message: ${(e as Error).message}`);
      }
    },
    close() {
      if (pair.input !== undefined) pair.input.onmidimessage = null;
    },
  };
}

export interface WebMidi {
  /** What the browser granted. False means sysex messages will not arrive. */
  readonly sysex: boolean;
  /** Re-scan and reconcile. Called on `statechange`; safe to call again. */
  rescan(): void;
  /**
   * Every port the browser can see, in and out, for the gear to show.
   *
   * READ LIVE from the access rather than returned as a snapshot: its
   * `inputs` and `outputs` are maps the browser keeps up to date, so a
   * device plugged in while a panel is open appears without anything
   * having to be told. The DEVICE list norns keeps is a different thing —
   * bidirectional vports paired by name — and the question a settings
   * panel is opened for is this one: is my interface detected, which way,
   * and under what name.
   */
  ports(): { name: string; direction: "in" | "out" }[];
  stop(): void;
}

/**
 * Connect the manager to the browser's MIDI ports.
 *
 * Resolves to `null` when there is no Web MIDI or the user refused it --
 * both of which are ordinary, and neither of which should stop the page.
 */
export async function startWebMidi(
  manager: MidiManager,
  opts: WebMidiOptions = {},
): Promise<WebMidi | null> {
  const log = opts.log ?? (() => {});
  const request =
    opts.request ??
    ((o: { sysex: boolean }) => {
      const nav = globalThis.navigator as unknown as {
        requestMIDIAccess?: (x: { sysex: boolean }) => Promise<WebMidiAccessLike>;
      };
      if (nav?.requestMIDIAccess === undefined) {
        return Promise.reject(new Error("no Web MIDI in this browser"));
      }
      return nav.requestMIDIAccess(o);
    });

  let access: WebMidiAccessLike;
  let sysex = true;
  try {
    access = await request({ sysex: true });
  } catch (e) {
    log(`midi: sysex refused (${(e as Error).message}); asking without it`);
    try {
      access = await request({ sysex: false });
      sysex = false;
    } catch (e2) {
      log(`midi: unavailable — ${(e2 as Error).message}`);
      return null;
    }
  }
  if (access.sysexEnabled === false) sysex = false;

  const attached = new Map<string, Pair>();

  const rescan = (): void => {
    const pairs = pairPorts(access);
    const seen = new Set<string>();
    for (const pair of pairs) {
      seen.add(pair.key);
      if (attached.has(pair.key)) continue;
      attached.set(pair.key, pair);
      const device = manager.add(makePort(pair, log));
      if (pair.input !== undefined) {
        // `open()` is implicit once a handler is attached, but calling it
        // makes a refusal visible instead of silent.
        void pair.input.open?.().catch((e: Error) => {
          log(`midi: could not open ${pair.name} for input: ${e.message}`);
        });
        // `e.timeStamp` is when the message ARRIVED, in performance.now()
        // milliseconds. The MIDI clock measures tempo from the gaps between
        // ticks, so this is the number that matters.
        pair.input.onmidimessage = (e) =>
          device.receive(
            [...e.data],
            e.timeStamp === undefined ? undefined : e.timeStamp / 1000,
          );
      }
      log(
        `midi: + ${pair.name}` +
          (pair.input === undefined ? " (out only)" : "") +
          (pair.output === undefined ? " (in only)" : ""),
      );
    }
    for (const key of [...attached.keys()]) {
      if (seen.has(key)) continue;
      attached.delete(key);
      manager.removeByPortId(key);
      log(`midi: - ${key}`);
    }
  };

  access.onstatechange = () => rescan();
  rescan();
  log(`midi: ${attached.size} device(s), sysex ${sysex ? "on" : "OFF"}`);

  return {
    sysex,
    rescan,
    ports() {
      const out: { name: string; direction: "in" | "out" }[] = [];
      for (const p of access.inputs.values()) out.push({ name: p.name ?? "(unnamed)", direction: "in" });
      for (const p of access.outputs.values()) out.push({ name: p.name ?? "(unnamed)", direction: "out" });
      return out;
    },
    stop() {
      access.onstatechange = null;
      for (const key of [...attached.keys()]) {
        attached.delete(key);
        manager.removeByPortId(key);
      }
    },
  };
}
