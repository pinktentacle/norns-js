// E2-08 — the input edge cases, as logic rather than as event handlers.
//
// Every question worth getting right here is a question about STATE, not about
// the DOM: is this keydown a repeat, is this key already held by another
// binding, did the pointer that moved start this drag, has enough drag
// accumulated to be a tick. Buried in `addEventListener` callbacks none of it
// can be tested, and each one fails silently — a stuck key is a norns that
// believes K1 is held forever, and nobody notices until a script misbehaves.
//
// So this file is a pure function of (state, event) -> actions. `input.ts`
// translates DOM events into these and dispatches what comes back.

export type Side = 1 | 2 | 3;

import { DEFAULT_KEYMAP, type Keymap } from "./keymap.js";

/**
 * The default map, kept under its old name because it is still the answer to
 * "what does a fresh norns-js do". The session's map is in `settings.ts` and
 * reaches the core through `CoreOptions.keymap`.
 */
export const KEYBOARD: Keymap = DEFAULT_KEYMAP;

export type InputEvent =
  | { t: "keydown"; code: string; repeat: boolean; modifier: boolean }
  | { t: "keyup"; code: string }
  | { t: "blur" }
  | { t: "pointerdown"; id: number; on: Target; x: number; y: number }
  | { t: "pointermove"; id: number; x: number; y: number }
  | { t: "pointerup"; id: number }
  | { t: "pointercancel"; id: number }
  | { t: "pointerleave"; id: number }
  | { t: "wheel"; on: Target; delta: number; shift: boolean };

export type Target =
  | { kind: "key"; n: Side }
  | { kind: "enc"; n: Side }
  | { kind: "screen" };

export type InputAction = { a: "key"; n: Side; z: 0 | 1 } | { a: "enc"; n: Side; delta: number };

export interface CoreOptions {
  /**
   * The map to read, asked for on every keystroke.
   *
   * A FUNCTION, not a value: the user can rebind a key while a script is
   * running, and a core holding a snapshot would keep answering with the map
   * it was built with until something recreated it — which would mean
   * tearing down every pointer binding to change one key.
   */
  readonly keymap?: () => Keymap;
  /**
   * How far a gesture turns an encoder, as a multiplier. Asked for on every
   * event, like the keymap, so a change takes effect under the user's hand
   * rather than at the next page load.
   *
   * It scales BOTH ways round: a press or a wheel notch is worth more
   * ticks, and a drag needs fewer pixels per tick. Scaling only one would
   * make the mouse and the keyboard disagree about what the knob does.
   */
  readonly sensitivity?: () => number;
  /** Ticks per keyboard press or on-screen step. Default 2. */
  readonly ticksPerStep?: number;
  /** Pixels of drag per tick. Default 4. */
  readonly pixelsPerTick?: number;
  /** Pixels of movement before a screen drag commits to an axis. Default 2. */
  readonly axisLockPixels?: number;
}

interface Drag {
  readonly on: Target;
  x: number;
  y: number;
  /** Sub-tick movement kept rather than discarded, or a slow drag does nothing. */
  carry: number;
  /** Which axis a screen drag committed to, once it has moved far enough. */
  axis: "x" | "y" | null;
}

export interface InputCore {
  handle(e: InputEvent): InputAction[];
  /** Keys currently down, for showing state. */
  readonly held: ReadonlySet<Side>;
  /** Pointer ids currently dragging, for assertions and cleanup. */
  readonly dragging: ReadonlySet<number>;
}

export function createInputCore(opts: CoreOptions = {}): InputCore {
  const keymap = opts.keymap ?? ((): Keymap => KEYBOARD);
  const sens = opts.sensitivity ?? ((): number => 1);
  const baseTicks = opts.ticksPerStep ?? 2;
  const basePxPerTick = opts.pixelsPerTick ?? 4;
  /** A detent is never worth less than one tick, however fine the setting. */
  const ticksNow = (): number => Math.max(1, Math.round(baseTicks * sens()));
  /** ...and never fewer than one pixel, or a drag would be unusable. */
  const pxPerTickNow = (): number => Math.max(1, basePxPerTick / sens());
  const axisLock = opts.axisLockPixels ?? 2;

  /** Which key each holding source is holding. Sources are codes or "ptr:<id>". */
  const holders = new Map<string, Side>();
  const drags = new Map<number, Drag>();

  const heldKeys = (): Set<Side> => new Set(holders.values());

  /** A key is down while ANY source holds it. */
  function press(source: string, n: Side): InputAction[] {
    const wasDown = [...holders.values()].includes(n);
    holders.set(source, n);
    return wasDown ? [] : [{ a: "key", n, z: 1 }];
  }

  function release(source: string): InputAction[] {
    const n = holders.get(source);
    if (n === undefined) return [];
    holders.delete(source);
    const stillDown = [...holders.values()].includes(n);
    return stillDown ? [] : [{ a: "key", n, z: 0 }];
  }

  function handle(e: InputEvent): InputAction[] {
    switch (e.t) {
      case "keydown": {
        // A modifier means the user is talking to the browser, not to norns.
        if (e.modifier) return [];
        const m = keymap()[e.code];
        if (!m) return [];
        if (m.key !== undefined) {
          // norns' key handler is edge triggered: `_norns.key(n, 1)` means
          // "went down". An auto-repeat is not a second press.
          if (e.repeat) return [];
          return press(e.code, m.key);
        }
        if (m.enc !== undefined && m.dir !== undefined) {
          // Repeats DO pass through for an encoder: holding a key to scroll
          // is the obvious gesture, and `core/encoders.lua:63` turns a fast
          // repeat into a larger delta on its own. Nothing here accelerates,
          // or the two would multiply.
          return [{ a: "enc", n: m.enc, delta: m.dir * ticksNow() }];
        }
        return [];
      }

      case "keyup":
        return release(e.code);

      case "blur": {
        // A key held while the window loses focus never sends keyup, and norns
        // would believe it down forever. Pointers go too: a drag cannot
        // continue through a window that is not focused.
        const out: InputAction[] = [];
        for (const source of [...holders.keys()]) out.push(...release(source));
        drags.clear();
        return out;
      }

      case "pointerdown": {
        if (e.on.kind === "key") return press(`ptr:${e.id}`, e.on.n);
        drags.set(e.id, { on: e.on, x: e.x, y: e.y, carry: 0, axis: null });
        return [];
      }

      case "pointermove": {
        const d = drags.get(e.id);
        // A second finger must not drive the first finger's drag.
        if (!d) return [];
        const dx = e.x - d.x;
        const dy = e.y - d.y;
        d.x = e.x;
        d.y = e.y;

        let moved: number;
        let n: Side;
        if (d.on.kind === "enc") {
          // Horizontal on a knob, which is how a knob reads on a flat screen.
          moved = dx;
          n = d.on.n;
        } else {
          // On the screen itself: vertical is E2 and horizontal is E3,
          // matching what each does in the menu. The axis is locked once the
          // gesture commits, or a diagonal drag turns two encoders at once
          // and the menu moves in two dimensions.
          if (!d.axis) {
            if (Math.abs(dx) < axisLock && Math.abs(dy) < axisLock) return [];
            d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
          }
          moved = d.axis === "x" ? dx : dy;
          n = d.axis === "x" ? 3 : 2;
        }

        d.carry += moved / pxPerTickNow();
        const whole = Math.trunc(d.carry);
        if (whole === 0) return [];
        d.carry -= whole;
        return [{ a: "enc", n, delta: whole }];
      }

      case "pointerup":
      case "pointercancel":
      case "pointerleave": {
        // A pointer that leaves a key without lifting still has to release it,
        // or the key sticks down.
        drags.delete(e.id);
        return release(`ptr:${e.id}`);
      }

      case "wheel": {
        // A notch is a DETENT, like a key press, and worth the same
        // `ticksPerStep`. One tick looked like the finer choice and was simply
        // broken: `core/menu.lua:181-185` sets encoder sensitivity to 8, 2, 2
        // in menu mode, so a single tick is below the threshold and a wheel
        // notch did nothing at all. Fine control lives in the drag, which
        // accumulates sub-tick movement.
        const t = ticksNow();
        const dir = e.delta > 0 ? t : -t;
        if (e.on.kind === "enc") return [{ a: "enc", n: e.on.n, delta: dir }];
        if (e.on.kind === "screen") return [{ a: "enc", n: e.shift ? 3 : 2, delta: dir }];
        return [];
      }
    }
  }

  return {
    handle,
    get held() {
      return heldKeys();
    },
    get dragging() {
      return new Set(drags.keys());
    },
  };
}

