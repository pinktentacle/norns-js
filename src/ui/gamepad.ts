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
//   X  -> K2     beside it, as K2 is beside K3.
//   Y  -> K1     the shift key: held, not tapped, so it wants its own thumb
//                position rather than sharing with A and X.
//   left stick X  -> E2     E2 is the left-hand knob on a norns.
//   right stick X -> E3     E3 is the right-hand one.
//   L2 / R2       -> E1     and they are ANALOG, which is the point: a
//                           trigger reports 0 to 1, so it drives E1 through
//                           the same curve the sticks use. A trigger suits
//                           it better than a stick does, because a trigger
//                           has somewhere to rest.
//
// B, the d-pad, the bumpers and both trackpads are deliberately unmapped. B
// is "back" everywhere else on a Deck. The trackpads cannot be reached at
// all: the Standard Gamepad layout has no concept of a touch surface, so if
// they are ever wanted it is through a Steam Input layout that turns them
// into something else, not through this file.
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
// has met the hardware. `docs/14-STEAM-DECK.md` is what has to happen before
// it can — including the setting that decides whether any of these indices
// arrive at all: a non-Steam shortcut gets the DESKTOP layout by default,
// where the sticks are a mouse and `getGamepads()` returns nothing.

export interface PadFrame {
  readonly buttons: readonly boolean[];
  /**
   * The same buttons as 0..1, because two of them are not buttons.
   *
   * `GamepadButton.value` is the analog reading, and for L2 and R2 it is the
   * whole of what they are for. `pressed` is a threshold over it — true
   * past about half-way — so reading only `pressed` would throw away the
   * half of a trigger that makes it an encoder rather than a switch. Empty
   * on a pad that reports no values, and the trigger code falls back to
   * `pressed` then.
   */
  readonly values: readonly number[];
  readonly axes: readonly number[];
  /** The browser's own word for whether the indices below mean anything. */
  readonly standard: boolean;
}

export type PadAction =
  | { readonly a: "key"; readonly n: 1 | 2 | 3; readonly z: 0 | 1 }
  | { readonly a: "enc"; readonly n: 1 | 2 | 3; readonly delta: number };

/** Standard mapping indices, from the Gamepad API's own table. */
const BTN = { a: 0, x: 2, y: 3, l2: 6, r2: 7 } as const;
const AXIS = { leftX: 0, rightX: 2 } as const;

const BUTTON_KEYS: ReadonlyArray<readonly [number, 1 | 2 | 3]> = [
  [BTN.a, 3],
  [BTN.x, 2],
  [BTN.y, 1],
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

  const encFromRate = (n: 1 | 2 | 3, rate: number, dtMs: number, out: PadAction[]): void => {
    const acc = (carry.get(n) ?? 0) + (rate * dtMs) / 1000;
    const whole = Math.trunc(acc);
    carry.set(n, acc - whole);
    if (whole !== 0) out.push({ a: "enc", n, delta: whole });
  };

  return {
    frame(pad, dtMs) {
      const out: PadAction[] = [];

      if (pad === null || !pad.standard) {
        // Release anything still down, so a pad unplugged mid-press does not
        // leave norns believing a key is held for ever.
        for (const [index, key] of BUTTON_KEYS) {
          if (held.delete(index)) out.push({ a: "key", n: key, z: 0 });
        }
        held.clear();
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

      const s = sensitivity();

      // E1 on the triggers. R2 turns it one way and L2 the other, through
      // the same curve as a stick, so both of a norns' three encoders and
      // its odd one out behave alike under the thumb. Pulling both at once
      // cancels, which is what a knob turned two ways at once should do.
      const trigger = (index: number): number => {
        const v = pad.values[index];
        if (typeof v === "number") return v;
        // A pad that reports no analog values at all: fall back to the
        // threshold, so E1 still turns rather than being dead.
        return pad.buttons[index] === true ? 1 : 0;
      };
      const e1 = rateFor(trigger(BTN.r2), s) - rateFor(trigger(BTN.l2), s);
      encFromRate(1, e1, dtMs, out);

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
      values: p.buttons.map((b) => b.value),
      axes: Array.from(p.axes),
      standard: p.mapping === "standard",
    };
  }
  return null;
}
