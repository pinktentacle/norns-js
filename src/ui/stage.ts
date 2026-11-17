// E6-10 — the devices as things you can move and resize.
//
// A norns on a desk is not stacked above its grid in a column, and two people
// do not want the same arrangement: one wants the grid enormous and the norns
// small because the script lives on the grid, the next wants the opposite.
// So the three devices get a position and a width, and the page remembers
// them.
//
// ARRANGE MODE IS A MODE, and that is not laziness. The whole surface of a
// norns is controls: a drag that moved the box would be a drag that also
// turned E3, and there is no corner of the device that is safely "not a
// control" to grab instead. The settings panel turns arranging ON, the
// devices go inert while it is on, and turning it off hands the surface back.
// A mode you can see and leave beats a modifier key nobody discovers.
//
// WIDTHS ARE STORED RAW AND CLAMPED WHEN APPLIED. A device wider than the
// window is clamped to fit rather than shrunk in storage, so a layout made on
// a wide screen comes back whole on the wide screen after a visit on a narrow
// one. The alternative -- writing the clamp back -- quietly destroys the
// arrangement the moment someone opens the page on a laptop.

import type { DeviceId, Placement, SettingsStore } from "./settings.js";
import type { MachineKind } from "./machine.js";

export interface StageDevice {
  readonly id: DeviceId;
  /** The positioned box. Its contents are the device. */
  readonly el: HTMLElement;
}

export interface StageOptions {
  readonly stage: HTMLElement;
  readonly devices: readonly StageDevice[];
  readonly settings: SettingsStore;
  /**
   * The device's box changed size, so anything inside it that measured itself
   * has to measure again — the grid and arc canvases both do.
   */
  readonly onResized: (id: DeviceId) => void;
  /**
   * Which machine to lay out for, read fresh so the gear can change it.
   *
   * It only ever decides the DEFAULTS. A placement the user has made is
   * theirs on every machine, which is why this is consulted where the
   * fallback is computed and nowhere else.
   */
  readonly kind?: () => MachineKind;
}

export interface Stage {
  readonly arranging: boolean;
  setArranging(on: boolean): void;
  /** Re-apply the stored layout, placing anything that has none. */
  refresh(): void;
  /** Forget every placement and stack them again. */
  reset(): void;
  destroy(): void;
}

/** Vertical space between stacked devices, in CSS pixels. */
const GAP = 22;

/**
 * The default width of a device, as a fraction of the stage.
 *
 * A DESK has room to spare, so 640 px is a comfortable norns and the rest of
 * the window is left alone. A PHONE has no room at all, so everything takes
 * the full width. A STEAM DECK is the interesting one: 1280x800 is wide and
 * SHORT, so stacking a norns above a grid runs out of height before it runs
 * out of width — the two go side by side instead, and each gets a share.
 */
const SHARE: Record<MachineKind, { first: number; rest: number }> = {
  normal: { first: 1, rest: 1 },
  phone: { first: 1, rest: 1 },
  steamdeck: { first: 0.57, rest: 0.39 },
};
/** A desk is the only profile that stops growing. */
const DESK_W = 640;
/** Nothing may be made smaller than this: a device you cannot grab is lost. */
const MIN_W = 140;
const MAX_W = 3000;

export function createStage(opts: StageOptions): Stage {
  const { stage, devices, settings } = opts;
  const ac = new AbortController();
  const signal = ac.signal;
  let arranging = false;

  const visible = (d: StageDevice): boolean => !d.el.hidden;
  const stageWidth = (): number => Math.max(MIN_W, stage.clientWidth);

  const kindNow = (): MachineKind => opts.kind?.() ?? "normal";

  /**
   * E9-61 — THE ZOOM IS NOT APPLIED HERE ANY MORE, and that is the point.
   *
   * It used to multiply every device's width, which made the norns bigger
   * and left the rail, the panels and maiden exactly as they were. A zoom
   * that stops at the edge of the stage is a second, smaller zoom to find.
   * It is the page's zoom now — `document.documentElement.style.zoom` in
   * main.ts — so everything scales together, and this file works in layout
   * pixels at every zoom, as it did before there was one.
   *
   * Multiplying here as well would square it.
   */

  /**
   * How much height the stage can use without the page having to scroll.
   *
   * Only the handheld profiles care. A desk has a window of any shape and
   * scrolling there is normal; a Deck has one screen, in one orientation,
   * and anything below the fold may as well not exist.
   */
  const availableHeight = (): number => {
    const top = stage.getBoundingClientRect().top;
    return Math.max(MIN_W, (globalThis.innerHeight || 0) - top - 12);
  };

  /** What a device would be, on this machine, if nobody had arranged it. */
  const defaultWidth = (id: DeviceId): number => {
    const sw = stageWidth();
    const kind = kindNow();
    if (kind === "normal") return Math.min(DESK_W, sw);
    const shown = devices.filter(visible);
    // ALONE MEANS ALL OF IT. The shares below exist to make room for a
    // second device; with nothing to make room for, a norns that takes 57%
    // of a Steam Deck and leaves the rest black is just small.
    if (shown.length <= 1) return sw;
    const share = id === shown[0]?.id ? SHARE[kind].first : SHARE[kind].rest;
    return Math.round(sw * share);
  };

  /**
   * Narrow a device until it fits a height, once its shape is known.
   *
   * Called after the first measuring pass, because the aspect ratio has to
   * be measured rather than assumed: the norns is 437:285 and the grid is
   * whatever its current size is, which changes with 64, 128 and 256 — and
   * with rotation, which inverts it.
   */
  const heightCapped = (el: HTMLElement, w: number, budget: number): number => {
    const h = el.offsetHeight;
    if (h <= 0 || w <= 0) return w;
    const aspect = w / h;
    return Math.max(MIN_W, Math.min(w, Math.round(budget * aspect)));
  };

  /** The stored width for a device, clamped to what the stage shows. */
  const widthFor = (id: DeviceId): number => {
    const stored = settings.layout[id]?.w;
    const want = stored ?? defaultWidth(id);
    return Math.max(MIN_W, Math.min(want, stageWidth()));
  };

  const apply = (el: HTMLElement, x: number, y: number, w: number): void => {
    el.style.width = `${w}px`;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  };

  /** Fit the stage around whatever is in it, so the page can scroll to it. */
  const fitStage = (): void => {
    let bottom = 0;
    for (const d of devices) {
      if (!visible(d)) continue;
      bottom = Math.max(bottom, d.el.offsetTop + d.el.offsetHeight);
    }
    stage.style.height = `${Math.ceil(bottom)}px`;
  };

  /**
   * Put every visible device where the settings say, and stack the rest.
   *
   * THE DEFAULT STACK IS COMPUTED FROM THE DEFAULTS, not from where things
   * currently are. The first version stacked unplaced devices under whatever
   * had already been placed, and moving the grid therefore teleported the
   * norns below it -- a device the user never touched, moved by a drag on
   * another one. Here the untouched devices sit where an untouched page
   * would put them, and a stored placement only ever moves its own device.
   *
   * It still uses each device's stored WIDTH, because a wider grid is a
   * taller grid and the stack has to leave room for it.
   */
  function refresh(): void {
    const sw = stageWidth();

    // Widths first, in one pass, so every height measured below is the
    // height the device will actually have.
    for (const d of devices) {
      if (visible(d)) d.el.style.width = `${widthFor(d.id)}px`;
    }

    // Then a second pass that trades width for height, with a budget that
    // depends on the machine. Only ever applied to a device nobody has
    // arranged -- an arrangement the user made is theirs, on any screen.
    //
    // ON A HANDHELD the budget is the screen: a device whose default would
    // run past the bottom is narrowed until it does not.
    //
    // EVERYWHERE ELSE the budget is the device's OWN width, which is what
    // stops a PORTRAIT device being drawn as a tower. A rotated monome is
    // the same slab turned on its side, and 16×8 and 8×16 are the same
    // object — but the width is what the layout stores, so a rotation kept
    // the width and doubled the height instead of swapping the two. A 640
    // wide grid became 1242 tall, which is twice the page, and everything
    // below it was left where the old height had put it: the keyboard was
    // underneath the grid, and the stage was still sized for the short one.
    // Capping the height at the width turns it back into a turned slab —
    // 640×339 becomes 330×640 — and the stack that follows is computed from
    // the real new height. It changes nothing for a landscape device, which
    // every one of them is until it is turned.
    {
      const deck = kindNow() === "steamdeck";
      const budget = availableHeight();
      const shown = devices.filter(visible);
      // The left column is one device and gets the whole height. The right
      // column stacks, so its devices share the height between them.
      const rest = Math.max(1, shown.length - 1);
      const eachRight = (budget - GAP * (rest - 1)) / rest;
      for (const [i, d] of shown.entries()) {
        if (settings.layout[d.id]) continue;
        const cap = deck ? (i === 0 ? budget : eachRight) : d.el.offsetWidth;
        const w = heightCapped(d.el, d.el.offsetWidth, cap);
        if (w !== d.el.offsetWidth) d.el.style.width = `${w}px`;
      }
    }

    // On a Steam Deck the first device takes the left column and everything
    // else stacks in the right one, because 800 px of height does not hold a
    // norns above a grid at any useful size. Everywhere else they stack
    // down the middle, which is what a page with room looks like.
    const stacked = new Map<DeviceId, { x: number; y: number }>();
    const twoColumns = kindNow() === "steamdeck";
    let y = 0;
    let first = true;
    for (const d of devices) {
      if (!visible(d)) continue;
      if (twoColumns && first) {
        stacked.set(d.id, { x: 0, y: 0 });
        first = false;
        continue;
      }
      const x = twoColumns ? sw - d.el.offsetWidth : (sw - d.el.offsetWidth) / 2;
      stacked.set(d.id, { x, y });
      y += d.el.offsetHeight + GAP;
    }

    for (const d of devices) {
      if (!visible(d)) continue;
      const w = d.el.offsetWidth;
      const p = settings.layout[d.id];
      const fallback = stacked.get(d.id) ?? { x: 0, y: 0 };
      // A stored x is clamped into the stage so nothing can be parked where
      // it cannot be reached again. This is NOT written back: see the file
      // comment.
      const x = p ? Math.max(0, Math.min(p.x, sw - w)) : fallback.x;
      apply(d.el, x, p ? Math.max(0, p.y) : fallback.y, w);
    }

    fitStage();
  }

  function reset(): void {
    for (const d of devices) {
      d.el.style.removeProperty("width");
      d.el.style.removeProperty("left");
      d.el.style.removeProperty("top");
    }
    settings.clearLayout();
    refresh();
    for (const d of devices) opts.onResized(d.id);
  }

  // --- arranging --------------------------------------------------------

  interface Drag {
    readonly d: StageDevice;
    readonly mode: "move" | "size";
    /** Pointer position when the drag began, in stage coordinates. */
    readonly px: number;
    readonly py: number;
    readonly x0: number;
    readonly y0: number;
    readonly w0: number;
  }
  let drag: Drag | null = null;

  const stagePoint = (e: PointerEvent): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const deviceAt = (target: EventTarget | null): StageDevice | null => {
    if (!(target instanceof Element)) return null;
    for (const d of devices) if (d.el.contains(target)) return d;
    return null;
  };

  stage.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (!arranging) return;
      const d = deviceAt(e.target);
      if (!d) return;
      const sizing = e.target instanceof Element && e.target.classList.contains("size");
      e.preventDefault();
      const p = stagePoint(e);
      drag = {
        d,
        mode: sizing ? "size" : "move",
        px: p.x,
        py: p.y,
        x0: d.el.offsetLeft,
        y0: d.el.offsetTop,
        w0: d.el.offsetWidth,
      };
      d.el.setPointerCapture?.(e.pointerId);
      d.el.classList.add("dragging");
    },
    { signal },
  );

  stage.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!drag) return;
      const p = stagePoint(e);
      if (drag.mode === "move") {
        apply(drag.d.el, drag.x0 + (p.x - drag.px), drag.y0 + (p.y - drag.py), drag.w0);
      } else {
        const w = Math.max(MIN_W, Math.min(MAX_W, drag.w0 + (p.x - drag.px)));
        apply(drag.d.el, drag.x0, drag.y0, w);
        // Live, not on release: a grid whose canvas only re-measured at the
        // end would stretch and snap, and the size you were aiming for is the
        // one you can see while aiming.
        opts.onResized(drag.d.id);
      }
      fitStage();
    },
    { signal },
  );

  /**
   * Write a placement back.
   *
   * No zoom to undo any more (see the note where `zoom` used to be): the
   * page scales as a whole, so an offset in layout pixels means the same
   * thing at every zoom and what is stored is what was arranged.
   */
  const store = (d: StageDevice): void => {
    settings.setPlacement(d.id, {
      x: d.el.offsetLeft,
      y: d.el.offsetTop,
      w: d.el.offsetWidth,
    });
  };

  const endDrag = (): void => {
    if (!drag) return;
    const d = drag.d;
    drag = null;
    d.el.classList.remove("dragging");
    store(d);
    opts.onResized(d.id);
    fitStage();
  };
  stage.addEventListener("pointerup", endDrag, { signal });
  stage.addEventListener("pointercancel", endDrag, { signal });

  /**
   * Arrow keys nudge the focused device.
   *
   * Pointer dragging is not available to everyone, and a layout that can only
   * be made with a mouse is a layout some people cannot make. One pixel a
   * press, ten with shift.
   */
  stage.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!arranging) return;
      const d = deviceAt(e.target);
      if (!d) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.code === "ArrowLeft" ? -step : e.code === "ArrowRight" ? step : 0;
      const dy = e.code === "ArrowUp" ? -step : e.code === "ArrowDown" ? step : 0;
      const dw = e.code === "BracketLeft" ? -step : e.code === "BracketRight" ? step : 0;
      if (dx === 0 && dy === 0 && dw === 0) return;
      e.preventDefault();
      const w = Math.max(MIN_W, Math.min(MAX_W, d.el.offsetWidth + dw));
      apply(d.el, d.el.offsetLeft + dx, Math.max(0, d.el.offsetTop + dy), w);
      store(d);
      if (dw !== 0) opts.onResized(d.id);
      fitStage();
    },
    { signal },
  );

  // The stage is a percentage of the window, so a narrower window has to
  // re-clamp. Positions are untouched; only what is shown moves.
  globalThis.addEventListener("resize", () => refresh(), { signal });

  function setArranging(on: boolean): void {
    arranging = on;
    stage.dataset["arrange"] = String(on);
    for (const d of devices) {
      if (on) d.el.setAttribute("tabindex", "0");
      else d.el.removeAttribute("tabindex");
    }
    if (!on) endDrag();
  }

  refresh();

  return {
    get arranging(): boolean {
      return arranging;
    },
    setArranging,
    refresh,
    reset,
    destroy(): void {
      ac.abort();
    },
  };
}
