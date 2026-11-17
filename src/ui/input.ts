// E2-05 / E2-08 — DOM events in, `_norns.key` and `_norns.enc` out.
//
// This file is a translator and nothing else: every decision about what an
// event MEANS lives in `input-core.ts`, where it can be tested. What is left
// here is the browser's share — preventDefault, pointer capture, touch-action
// — which is real work but has no state of its own.
//
// Pointer Events throughout rather than separate mouse and touch paths: one
// code path that a stylus and a trackpad also reach.

import {
  createInputCore,
  type CoreOptions,
  type InputAction,
  type InputEvent,
  type Side,
  type Target,
} from "./input-core.js";

export { KEYBOARD } from "./input-core.js";
export { DEFAULT_KEYMAP, type Keymap } from "./keymap.js";
export type { Side, Target, InputAction, InputEvent } from "./input-core.js";

export type KeyHandler = (n: Side, z: 0 | 1) => void;
export type EncHandler = (n: Side, delta: number) => void;

export interface InputOptions extends CoreOptions {
  readonly onKey: KeyHandler;
  readonly onEnc: EncHandler;
}

export interface Input {
  bindKeyboard(target: EventTarget): void;
  bindEncoder(el: HTMLElement, n: Side): void;
  bindKey(el: HTMLElement, n: Side): void;
  bindScreen(el: HTMLElement): void;
  readonly held: ReadonlySet<Side>;
  destroy(): void;
}

export function createInput(opts: InputOptions): Input {
  const core = createInputCore(opts);
  const cleanups: Array<() => void> = [];
  /** The same map the core reads, for deciding what to swallow. */
  const keymap = opts.keymap ?? ((): Keymap => KEY_CODES);

  const dispatch = (actions: InputAction[]): void => {
    for (const a of actions) {
      if (a.a === "key") opts.onKey(a.n, a.z);
      else opts.onEnc(a.n, a.delta);
    }
  };
  const send = (e: InputEvent): void => dispatch(core.handle(e));

  const on = (
    t: EventTarget,
    type: string,
    fn: (e: never) => void,
    o?: AddEventListenerOptions,
  ): void => {
    t.addEventListener(type, fn as EventListener, o);
    cleanups.push(() => t.removeEventListener(type, fn as EventListener, o));
  };

  function bindKeyboard(target: EventTarget): void {
    on(target, "keydown", (e: KeyboardEvent) => {
      const modifier = e.ctrlKey || e.metaKey || e.altKey;
      const before = core.held.size;
      send({ t: "keydown", code: e.code, repeat: e.repeat, modifier });
      // Only swallow the event if it was ours. A modifier combination or an
      // unbound key must stay the browser's.
      if (!modifier && e.code in keymap()) e.preventDefault();
      void before;
    });

    on(target, "keyup", (e: KeyboardEvent) => {
      send({ t: "keyup", code: e.code });
      if (e.code in keymap()) e.preventDefault();
    });

    on(window, "blur", () => send({ t: "blur" }));
  }

  /** Shared pointer plumbing for anything the core treats as a drag target. */
  function draggable(el: HTMLElement, on_: Target): void {
    // Without this the browser scrolls the page instead of giving us the drag.
    el.style.touchAction = "none";

    on(el, "pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      // Capture so a drag that leaves the element keeps arriving.
      el.setPointerCapture(e.pointerId);
      send({ t: "pointerdown", id: e.pointerId, on: on_, x: e.clientX, y: e.clientY });
    });

    on(el, "pointermove", (e: PointerEvent) =>
      send({ t: "pointermove", id: e.pointerId, x: e.clientX, y: e.clientY }),
    );

    const end = (t: "pointerup" | "pointercancel" | "pointerleave") => (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      send({ t, id: e.pointerId });
    };
    on(el, "pointerup", end("pointerup"));
    on(el, "pointercancel", end("pointercancel"));
    // Only keys need pointerleave: a captured drag does not fire it, but an
    // uncaptured press that slides off the button would otherwise stick.
    if (on_.kind === "key") on(el, "pointerleave", end("pointerleave"));

    on(
      el,
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        send({ t: "wheel", on: on_, delta, shift: e.shiftKey });
      },
      { passive: false },
    );
  }

  return {
    bindKeyboard,
    bindEncoder: (el, n) => draggable(el, { kind: "enc", n }),
    bindKey: (el, n) => draggable(el, { kind: "key", n }),
    bindScreen: (el) => draggable(el, { kind: "screen" }),
    get held() {
      return core.held;
    },
    destroy() {
      for (const c of cleanups.splice(0)) c();
    },
  };
}

// Imported here rather than at the top so the export list above reads first.
import { KEYBOARD as KEY_CODES } from "./input-core.js";
import type { Keymap } from "./keymap.js";
