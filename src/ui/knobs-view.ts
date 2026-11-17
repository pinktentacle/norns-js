// Four by four knurled knobs, their rings, and the four bank buttons.
//
// A TURN IS A DRAG AND A PUSH IS A CLICK. On the hardware they are the same
// object: you twist the knob and you press the same knob down. A pointer
// cannot do both at once, so the gesture decides — move more than a few
// pixels and it was a turn, release without having moved and it was a push.
// The threshold is in pixels rather than in value steps so that a shaky
// finger on a phone still reads as a press.
//
// THE RING IS THE VALUE, not a second display of it. The host can set the
// ring, and that IS the knob's position afterwards — which is how a script
// snaps a control to where the parameter really is. One number per knob.
//
// VERTICAL, NOT ROTARY. Dragging in a circle around a thirty-pixel knob is
// a gesture nobody lands; every plug-in in the world settled on up and
// down, and so does this.

import { KNOBS_BANKS, KNOBS_COUNT } from "../midi/knobs.js";

export interface KnobsViewOptions {
  /** An empty container. Everything inside it is built here. */
  readonly host: HTMLElement;
  /** 0-based knob of the current bank, 0..127. */
  readonly onTurn: (knob: number, value: number) => void;
  readonly onPress: (knob: number, down: boolean) => void;
  readonly onBank: (bank: number) => void;
  readonly values?: readonly number[];
  readonly bank?: number;
}

export interface KnobsView {
  /** Redraw from the port: a bank change, or the host painting the face. */
  refresh(values: readonly number[], colours: readonly (number | null)[], bank: number): void;
  dispose(): void;
}

/** How far a pointer may travel and still count as a push. */
const PUSH_SLOP = 4;
/** Pixels of drag for the full 0..127 sweep. */
const DRAG_RANGE = 160;

/**
 * A colour index as a hue.
 *
 * The palette runs cold to warm the long way round the wheel, so index 1 is
 * blue and the high end comes back to it. 0 means the host has said
 * nothing, and that is the unlit metal of the case.
 */
function hueOf(colour: number): number {
  return Math.round((((colour - 1) / 125) * 300 + 240) % 360);
}

export function createKnobsView(opts: KnobsViewOptions): KnobsView {
  const { host } = opts;
  const ac = new AbortController();
  const signal = ac.signal;

  host.textContent = "";
  host.classList.add("kn");

  const banks = document.createElement("div");
  banks.className = "kn-banks";
  const bankButtons: HTMLButtonElement[] = [];
  for (let b = 0; b < KNOBS_BANKS; b++) {
    const btn = document.createElement("button");
    btn.className = "kn-bank";
    btn.type = "button";
    btn.textContent = String(b + 1);
    btn.addEventListener("click", () => opts.onBank(b), { signal });
    banks.append(btn);
    bankButtons.push(btn);
  }

  const grid = document.createElement("div");
  grid.className = "kn-grid";
  const knobs: HTMLElement[] = [];
  const rings: HTMLElement[] = [];
  for (let i = 0; i < KNOBS_COUNT; i++) {
    const knob = document.createElement("div");
    knob.className = "kn-knob";
    knob.dataset["knob"] = String(i);
    const ring = document.createElement("div");
    ring.className = "kn-ring";
    const cap = document.createElement("div");
    cap.className = "kn-cap";
    const mark = document.createElement("i");
    mark.className = "kn-mark";
    cap.append(mark);
    knob.append(ring, cap);
    grid.append(knob);
    knobs.push(knob);
    rings.push(ring);
  }
  host.append(banks, grid);

  const at = new Array<number>(KNOBS_COUNT).fill(0);
  const colours = new Array<number | null>(KNOBS_COUNT).fill(null);
  let bank = Math.max(0, Math.min(KNOBS_BANKS - 1, opts.bank ?? 0));

  const paint = (i: number): void => {
    const ring = rings[i];
    const knob = knobs[i];
    if (ring === undefined || knob === undefined) return;
    const v = (at[i] ?? 0) / 127;
    ring.style.setProperty("--kn-v", String(v));
    // The cap's engraved mark turns with the value, across the same 280
    // degrees the ring sweeps, so the knob and its ring agree.
    knob.style.setProperty("--kn-angle", `${-140 + v * 280}deg`);
    // 0 and "never painted" are the same thing: the palette starts at 1.
    const c = colours[i] ?? 0;
    ring.style.setProperty("--kn-hue", c === 0 ? "0" : String(hueOf(c)));
    ring.style.setProperty("--kn-sat", c === 0 ? "0%" : "72%");
  };

  const paintBanks = (): void => {
    bankButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === bank)));
  };

  if (opts.values) for (let i = 0; i < KNOBS_COUNT; i++) at[i] = opts.values[i] ?? 0;
  for (let i = 0; i < KNOBS_COUNT; i++) paint(i);
  paintBanks();

  /** A live pointer: which knob, where it started, and how far it went. */
  interface Drag {
    readonly knob: number;
    readonly y: number;
    readonly from: number;
    moved: number;
  }
  const drags = new Map<number, Drag>();

  grid.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".kn-knob");
      const n = el?.dataset["knob"];
      if (n === undefined) return;
      e.preventDefault();
      const knob = Number(n);
      grid.setPointerCapture(e.pointerId);
      drags.set(e.pointerId, { knob, y: e.clientY, from: at[knob] ?? 0, moved: 0 });
      knobs[knob]?.classList.add("down");
    },
    { signal },
  );
  grid.addEventListener(
    "pointermove",
    (e) => {
      const d = drags.get(e.pointerId);
      if (d === undefined) return;
      const dy = d.y - e.clientY;
      d.moved = Math.max(d.moved, Math.abs(dy));
      if (d.moved <= PUSH_SLOP) return;
      const v = Math.max(0, Math.min(127, Math.round(d.from + (dy / DRAG_RANGE) * 127)));
      if (at[d.knob] === v) return;
      at[d.knob] = v;
      paint(d.knob);
      opts.onTurn(d.knob, v);
    },
    { signal },
  );
  for (const type of ["pointerup", "pointercancel"] as const) {
    grid.addEventListener(
      type,
      (e) => {
        const d = drags.get(e.pointerId);
        if (d === undefined) return;
        drags.delete(e.pointerId);
        knobs[d.knob]?.classList.remove("down");
        // Never moved, so it was a push — and a push is a press and a
        // release, because a pointer that has already gone up cannot hold
        // a switch down.
        if (d.moved <= PUSH_SLOP && type === "pointerup") {
          opts.onPress(d.knob, true);
          opts.onPress(d.knob, false);
        }
      },
      { signal },
    );
  }

  return {
    refresh(values, cols, b) {
      bank = Math.max(0, Math.min(KNOBS_BANKS - 1, b));
      for (let i = 0; i < KNOBS_COUNT; i++) {
        at[i] = values[i] ?? 0;
        colours[i] = cols[i] ?? null;
        paint(i);
      }
      paintBanks();
    },
    dispose() {
      ac.abort();
      drags.clear();
      host.textContent = "";
      host.classList.remove("kn");
    },
  };
}
