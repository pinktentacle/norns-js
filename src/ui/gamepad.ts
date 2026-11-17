// A Steam Deck's own controls, as norns keys and encoders.
//
// A Deck has no keyboard. It has two sticks, a d-pad, four face buttons, two
// bumpers, two triggers and two trackpads -- and Steam Input presents all of
// it to a browser as ONE standard gamepad, which is why this reads the
// standard mapping's indices rather than any device's own.
//
// THE MAPPING, and why each one:
//
//   A  -> K3     the norns button you press most. The pad's primary button.
//   B  -> K2     beside it, as K2 is beside K3.
//   X  -> K1     the shift key: held, not tapped, so it wants its own thumb
//                position rather than sharing with A and B.
//   left stick X  -> E2     E2 is the left-hand knob on a norns.
//   right stick X -> E3     E3 is the right-hand one.
//   d-pad < >     -> E1     E1 changes page, which is a discrete thing, and
//   L1 / R1       -> E1     a d-pad press is discrete. The bumpers do the
//                           same because "page back, page forward" is what
//                           a bumper means on everything else.
//
// WHY A STICK IS A RATE AND NOT A POSITION. An encoder has no end stops: it
// reports movement, not where it is. A stick does the opposite -- it springs
// back to centre. Mapping deflection to position would make a knob that
// snaps back to zero when you let go, which is not a knob. So deflection is
// a SPEED: push a little and the value creeps, push fully and it runs. The
// curve is deliberately not linear, because the whole difficulty with a
// stick is getting one tick at a time out of it.
//
// Ticks are accumulated as fractions and emitted whole, so a slow push still
// produces exactly one tick rather than a stream of rounded-up ones.
//
// NOT RUN ON A STEAM DECK. The indices are the W3C standard mapping and the
// behaviour is covered by tests over synthetic frames, but no part of this
// has met the hardware.

export interface PadFrame {
  readonly buttons: readonly boolean[];
  readonly axes: readonly number[];
  /** The browser's own word for whether the indices below mean anything. */
  readonly standard: boolean;
}

export type PadAction =
  | { readonly a: "key"; readonly n: 1 | 2 | 3; readonly z: 0 | 1 }
  | { readonly a: "enc"; readonly n: 1 | 2 | 3; readonly delta: number };

/** Standard mapping indices, from the Gamepad API's own table. */
const BTN = { a: 0, b: 1, x: 2, l1: 4, r1: 5, dpadLeft: 14, dpadRight: 15 } as const;
const AXIS = { leftX: 0, rightX: 2 } as const;

const BUTTON_KEYS: ReadonlyArray<readonly [number, 1 | 2 | 3]> = [
  [BTN.a, 3],
  [BTN.b, 2],
  [BTN.x, 1],
];

/** Below this a stick is at rest. Sticks drift, and a drifting knob is a bug. */
const DEAD_ZONE = 0.15;
/** Ticks per second at full deflection. A fast hand on a real encoder. */
const MAX_RATE = 34;
/**
 * Above 1 this gives fine control near the centre, and the exact value
 * matters more than it looks. The first try paired a 0.22 dead zone with a
 * curve of 2.2, which put a third of the stick's travel at 0.2 ticks per
 * SECOND — a push that visibly moves the stick and does nothing at all.
 * 0.15 and 1.6 give about two ticks a second there, which is the "one at a
 * time" a page-sized list wants, and still 34 at the stop.
 */
const CURVE = 1.6;
/** A held d-pad repeats, like a key. First after this, then every REPEAT_MS. */
const REPEAT_DELAY_MS = 380;
const REPEAT_MS = 90;

/** Deflection to ticks per second, with the dead zone removed. */
export function rateFor(axis: number, sensitivity = 1): number {
  const mag = Math.abs(axis);
  if (mag <= DEAD_ZONE) return 0;
  const scaled = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
  return Math.sign(axis) * MAX_RATE * sensitivity * Math.pow(scaled, CURVE);
}

export interface PadCoreOptions {
  /** The gear's encoder sensitivity, so a pad and a keyboard agree. */
  readonly sensitivity?: () => number;
}

export interface PadCore {
  /** One frame of one pad. `dtMs` is the time since the previous frame. */
  frame(pad: PadFrame | null, dtMs: number): PadAction[];
}

export function createPadCore(opts: PadCoreOptions = {}): PadCore {
  const sensitivity = opts.sensitivity ?? ((): number => 1);
  const held = new Set<number>();
  const carry = new Map<1 | 2 | 3, number>();
  /** When each repeating button is next due to fire. */
  const nextRepeat = new Map<number, number>();
  let clock = 0;

  const encFromRate = (n: 1 | 2 | 3, rate: number, dtMs: number, out: PadAction[]): void => {
    const acc = (carry.get(n) ?? 0) + (rate * dtMs) / 1000;
    const whole = Math.trunc(acc);
    carry.set(n, acc - whole);
    if (whole !== 0) out.push({ a: "enc", n, delta: whole });
  };

  return {
    frame(pad, dtMs) {
      const out: PadAction[] = [];
      clock += dtMs;

      if (pad === null || !pad.standard) {
        // Release anything still down, so a pad unplugged mid-press does not
        // leave norns believing a key is held for ever.
        for (const [index, key] of BUTTON_KEYS) {
          if (held.delete(index)) out.push({ a: "key", n: key, z: 0 });
        }
        held.clear();
        nextRepeat.clear();
        carry.clear();
        return out;
      }

      for (const [index, key] of BUTTON_KEYS) {
        const down = pad.buttons[index] === true;
        if (down && !held.has(index)) {
          held.add(index);
          out.push({ a: "key", n: key, z: 1 });
        } else if (!down && held.has(index)) {
          held.delete(index);
          out.push({ a: "key", n: key, z: 0 });
        }
      }

      // E1 steps: the d-pad and the bumpers, each repeating while held.
      for (const [index, delta] of [
        [BTN.dpadLeft, -1],
        [BTN.l1, -1],
        [BTN.dpadRight, 1],
        [BTN.r1, 1],
      ] as const) {
        const down = pad.buttons[index] === true;
        if (!down) {
          held.delete(index);
          nextRepeat.delete(index);
          continue;
        }
        if (!held.has(index)) {
          held.add(index);
          nextRepeat.set(index, clock + REPEAT_DELAY_MS);
          out.push({ a: "enc", n: 1, delta });
          continue;
        }
        const due = nextRepeat.get(index) ?? Infinity;
        if (clock >= due) {
          nextRepeat.set(index, clock + REPEAT_MS);
          out.push({ a: "enc", n: 1, delta });
        }
      }

      const s = sensitivity();
      encFromRate(2, rateFor(pad.axes[AXIS.leftX] ?? 0, s), dtMs, out);
      encFromRate(3, rateFor(pad.axes[AXIS.rightX] ?? 0, s), dtMs, out);
      return out;
    },
  };
}

/** The first connected pad, or null. */
export function readPad(): PadFrame | null {
  let pads: (Gamepad | null)[] = [];
  try {
    pads = Array.from(globalThis.navigator?.getGamepads?.() ?? []);
  } catch {
    return null;
  }
  for (const p of pads) {
    if (p === null || !p.connected) continue;
    return {
      buttons: p.buttons.map((b) => b.pressed),
      axes: Array.from(p.axes),
      standard: p.mapping === "standard",
    };
  }
  return null;
}
