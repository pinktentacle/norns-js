// Sixteen faders, machined into the same aluminium as the rest.
//
// DOM RATHER THAN CANVAS, like the keyboard and unlike the grid: sixteen
// vertical slots are sixteen elements, and the stacking order is the hit
// test. There is nothing here a canvas would make easier.
//
// ONE POINTER OWNS ONE FADER, from press to release. A keyboard slides —
// dragging across it is a glissando — and a fader bank does not: a finger
// that wanders sideways while pulling fader 3 is still pulling fader 3, and
// handing it fader 4 halfway down would move a control nobody touched.
// Pointer capture on the row is what keeps the release, wherever it lands.

import { FADERS_COUNT } from "../midi/faders.js";

export interface FadersViewOptions {
  /** An empty container. Everything inside it is built here. */
  readonly host: HTMLElement;
  /** 0-based fader, 0..127 value. */
  readonly onMove: (fader: number, value: number) => void;
  /** Where the faders start, which is where the port already has them. */
  readonly values?: readonly number[];
}

export interface FadersView {
  /** Redraw from the port, after something other than a drag moved a fader. */
  refresh(values: readonly number[]): void;
  dispose(): void;
}

export function createFadersView(opts: FadersViewOptions): FadersView {
  const { host } = opts;
  const ac = new AbortController();
  const signal = ac.signal;

  host.textContent = "";
  host.classList.add("fb");

  const bar = document.createElement("div");
  bar.className = "fb-bar";
  const label = document.createElement("span");
  label.className = "fb-label";
  // What it IS, standing still: the mapping is the whole specification of
  // this device, and a script's PMAP has to agree with it.
  label.textContent = "cc 32–47 · ch 1";
  bar.append(label);

  const row = document.createElement("div");
  row.className = "fb-row";

  const caps: HTMLElement[] = [];
  const tracks: HTMLElement[] = [];
  for (let i = 0; i < FADERS_COUNT; i++) {
    const slot = document.createElement("div");
    slot.className = "fb-slot";
    slot.dataset["fader"] = String(i);
    const track = document.createElement("div");
    track.className = "fb-track";
    const cap = document.createElement("div");
    cap.className = "fb-cap";
    track.append(cap);
    slot.append(track);
    row.append(slot);
    caps.push(cap);
    tracks.push(track);
  }
  host.append(bar, row);

  const at = new Array<number>(FADERS_COUNT).fill(0);
  if (opts.values) for (let i = 0; i < FADERS_COUNT; i++) at[i] = opts.values[i] ?? 0;

  const paint = (i: number): void => {
    const cap = caps[i];
    if (cap === undefined) return;
    // The cap's own height comes out of the travel, or 0 would hang half
    // the cap off the bottom of the slot and 127 half of it off the top.
    cap.style.bottom = `calc((100% - var(--fb-cap)) * ${(at[i] ?? 0) / 127})`;
  };
  for (let i = 0; i < FADERS_COUNT; i++) paint(i);

  /** Which fader each live pointer owns. */
  const held = new Map<number, number>();

  const valueAt = (fader: number, clientY: number): number => {
    const track = tracks[fader];
    if (track === undefined) return 0;
    const r = track.getBoundingClientRect();
    if (r.height <= 0) return 0;
    return Math.max(0, Math.min(127, Math.round(((r.bottom - clientY) / r.height) * 127)));
  };

  const moveTo = (fader: number, value: number): void => {
    if (at[fader] === value) return;
    at[fader] = value;
    paint(fader);
    opts.onMove(fader, value);
  };

  row.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fb-slot");
      const f = el?.dataset["fader"];
      if (f === undefined) return;
      e.preventDefault();
      const fader = Number(f);
      row.setPointerCapture(e.pointerId);
      held.set(e.pointerId, fader);
      caps[fader]?.classList.add("down");
      // A tap jumps the cap to where it was tapped, which is what a touch
      // screen makes of a fader — and here the mouse IS the finger.
      moveTo(fader, valueAt(fader, e.clientY));
    },
    { signal },
  );
  row.addEventListener(
    "pointermove",
    (e) => {
      const fader = held.get(e.pointerId);
      if (fader === undefined) return;
      moveTo(fader, valueAt(fader, e.clientY));
    },
    { signal },
  );
  for (const type of ["pointerup", "pointercancel"] as const) {
    row.addEventListener(
      type,
      (e) => {
        const fader = held.get(e.pointerId);
        if (fader === undefined) return;
        held.delete(e.pointerId);
        caps[fader]?.classList.remove("down");
      },
      { signal },
    );
  }

  return {
    refresh(values) {
      for (let i = 0; i < FADERS_COUNT; i++) {
        const v = values[i] ?? 0;
        if (at[i] === v) continue;
        at[i] = v;
        paint(i);
      }
    },
    dispose() {
      ac.abort();
      held.clear();
      host.textContent = "";
      host.classList.remove("fb");
    },
  };
}
