// Two octaves of keys, and the octave selector above them.
//
// DOM, NOT CANVAS, unlike the grid and the arc. Those are square lattices
// where hit-testing is arithmetic; a keyboard is not. A black key overlaps
// two white ones and must win, and getting that right in canvas means
// writing the overlap test by hand and then writing it again for touch. In
// the DOM the stacking order IS the hit test, and `pointer-events` on the
// black keys does the rest.
//
// POINTER CAPTURE IS WHAT MAKES IT PLAYABLE. Without it, dragging off a key
// leaves the note sounding for ever, and a pointerup outside the page never
// arrives at all. With it, one pointer owns one note from press to release
// wherever the release happens, and sliding across keys retriggers — which
// is a glissando, and what a finger on a real keyboard does.

import {
  baseNoteFor,
  noteName,
  KEYBOARD_SEMITONES,
  OCTAVE_MAX,
  OCTAVE_MIN,
} from "../midi/keyboard.js";

export interface KeyboardViewOptions {
  /** An empty container. Everything inside it is built here. */
  readonly host: HTMLElement;
  readonly onNoteOn: (note: number, velocity: number) => void;
  readonly onNoteOff: (note: number) => void;
  /** Called when the octave changes, so anything held can be released. */
  readonly onOctave?: (octave: number) => void;
  readonly octave?: number;
  readonly velocity?: number;
}

export interface KeyboardView {
  readonly octave: number;
  setOctave(octave: number): void;
  readonly velocity: number;
  setVelocity(velocity: number): void;
  /** Lift every key, visually and as notes. */
  releaseAll(): void;
  dispose(): void;
}

/** Which semitones are black, within an octave. */
const BLACK = new Set([1, 3, 6, 8, 10]);

/**
 * Velocity is a number you set, and the steppers move it by this much.
 *
 * It used to come from how far down the key you pressed, which is more
 * expressive and became a lie the moment there was a control saying what
 * the velocity is: you would set 100 and the wire would carry 84. One
 * source of truth beats two, and the touch behaviour is a few lines away
 * if it is ever wanted back as a named mode rather than as a surprise.
 *
 * NEVER ZERO. A velocity of 0 is a note OFF on the wire, so a keyboard
 * that could be set to it would have a silent setting that also broke
 * every note it sent.
 */
const VELOCITY_STEP = 10;
const VELOCITY_MIN = 1;
const VELOCITY_MAX = 127;

export function createKeyboardView(opts: KeyboardViewOptions): KeyboardView {
  const { host } = opts;
  let octave = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, opts.octave ?? 4));
  let velocity = Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, Math.round(opts.velocity ?? 100)));
  const ac = new AbortController();
  const signal = ac.signal;

  host.textContent = "";
  host.classList.add("kb");

  // A READ-OUT, NOT A CONTROL. The octave and the velocity are set in the
  // gear now; a device whose face is half instrument and half control
  // panel is two things. This says where you are, which you want while
  // playing and cannot read from a panel you have closed.
  const bar = document.createElement("div");
  bar.className = "kb-bar";
  const label = document.createElement("span");
  label.className = "kb-label";
  bar.append(label);

  const keys = document.createElement("div");
  keys.className = "kb-keys";

  /** One element per semitone, indexed by offset from the base note. */
  const elements: HTMLElement[] = [];
  // The white keys lay out in flow; the black ones are positioned over the
  // boundary between their neighbours, which is why they are built second
  // and why their left edge is a percentage of the whole keyboard.
  const whiteCount = Array.from({ length: KEYBOARD_SEMITONES }, (_, i) => i).filter(
    (i) => !BLACK.has(i % 12),
  ).length;
  let whiteSeen = 0;
  for (let i = 0; i < KEYBOARD_SEMITONES; i++) {
    const el = document.createElement("div");
    el.dataset["semitone"] = String(i);
    if (BLACK.has(i % 12)) {
      el.className = "kb-key kb-black";
      // Centred on the gap after the white key just placed.
      el.style.left = `${(whiteSeen / whiteCount) * 100}%`;
      el.style.width = `${(1 / whiteCount) * 100 * 0.62}%`;
      el.style.marginLeft = `${(1 / whiteCount) * 100 * -0.31}%`;
    } else {
      el.className = "kb-key kb-white";
      el.style.width = `${(1 / whiteCount) * 100}%`;
      whiteSeen++;
    }
    elements.push(el);
    keys.append(el);
  }
  host.append(bar, keys);

  /** Which note each live pointer is currently sounding. */
  const sounding = new Map<number, number>();

  const paint = (): void => {
    label.textContent = `${noteName(baseNoteFor(octave))} · vel ${velocity}`;
  };

  const semitoneAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y);
    if (!(el instanceof HTMLElement)) return null;
    const s = el.dataset["semitone"];
    return s === undefined ? null : Number(s);
  };

  const press = (pointer: number, semitone: number): void => {
    const was = sounding.get(pointer);
    if (was === semitone) return;
    if (was !== undefined) {
      opts.onNoteOff(baseNoteFor(octave) + was);
      elements[was]?.classList.remove("down");
    }
    sounding.set(pointer, semitone);
    elements[semitone]?.classList.add("down");
    opts.onNoteOn(baseNoteFor(octave) + semitone, velocity);
  };

  const release = (pointer: number): void => {
    const semitone = sounding.get(pointer);
    if (semitone === undefined) return;
    sounding.delete(pointer);
    elements[semitone]?.classList.remove("down");
    opts.onNoteOff(baseNoteFor(octave) + semitone);
  };

  keys.addEventListener(
    "pointerdown",
    (e) => {
      const semitone = semitoneAt(e.clientX, e.clientY);
      if (semitone === null) return;
      e.preventDefault();
      // The capture is on the KEYS, not on the key: a slide to the next note
      // has to keep delivering to the same handler.
      keys.setPointerCapture(e.pointerId);
      press(e.pointerId, semitone);
    },
    { signal },
  );
  keys.addEventListener(
    "pointermove",
    (e) => {
      if (!sounding.has(e.pointerId)) return;
      const semitone = semitoneAt(e.clientX, e.clientY);
      if (semitone === null) release(e.pointerId);
      else press(e.pointerId, semitone);
    },
    { signal },
  );
  for (const type of ["pointerup", "pointercancel"] as const) {
    keys.addEventListener(type, (e) => release(e.pointerId), { signal });
  }

  const shift = (by: number): void => {
    const next = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, octave + by));
    if (next === octave) return;
    // Everything held goes off at the OLD pitch first. Changing the base
    // under a held note would send its note-off at a pitch that was never
    // turned on, and the voice would hang.
    releaseAll();
    octave = next;
    paint();
    opts.onOctave?.(octave);
  };
  const nudge = (by: number): void => {
    const next = Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, velocity + by));
    if (next === velocity) return;
    // Notes already sounding keep the velocity they were struck with, which
    // is what a wire does: velocity rides on the note on and nothing
    // changes it afterwards.
    velocity = next;
    paint();
  };

  function releaseAll(): void {
    for (const pointer of [...sounding.keys()]) release(pointer);
  }

  paint();

  return {
    get octave() {
      return octave;
    },
    setOctave(n) {
      shift(Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(n))) - octave);
    },
    get velocity() {
      return velocity;
    },
    setVelocity(n) {
      nudge(Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, Math.round(n))) - velocity);
    },
    releaseAll,
    dispose() {
      releaseAll();
      ac.abort();
      host.textContent = "";
      host.classList.remove("kb");
    },
  };
}
