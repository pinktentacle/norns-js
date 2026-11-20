/**
 * E9-164 — YIELD FOR A FRAME, BUT NOT FOR EVER.
 *
 * `startAudio()` begins by waiting for one `requestAnimationFrame`, and
 * the reason is sound: everything after it is a single unbroken run of
 * synchronous work — instantiating two wasm modules and compiling
 * sclang's class library, 373 files and 2434 classes — during which the
 * main thread never yields. Without the wait the menu is drawn into the
 * surface and never reaches the canvas, and the page sits black for as
 * long as that takes.
 *
 * BUT A FRAME IS NOT PROMISED. `requestAnimationFrame` fires when the
 * page is being PAINTED, which is not the same thing as being open:
 * Chrome stops producing frames for a tab that is occluded or
 * backgrounded, and a window can report `document.hidden === false` and
 * `visibilityState === "visible"` while its compositor produces nothing
 * at all. Observed exactly so in the Claude desktop app's browser pane
 * on 2026-11-20 — visible by both flags, no frame in two seconds.
 *
 * What that costs is everything. The await never resolves, so scsynth
 * and sclang are never loaded, so there is no engine, no server and no
 * sound — and nothing is logged, because the line that would have said
 * "loading scsynth.wasm" is on the other side of the wait. The page
 * boots, the menu works, the grid draws, and the thing is silent for
 * ever. A phone whose screen locks during the twenty seconds the boot
 * takes is the case that matters.
 *
 * So the frame is an OPTIMISATION and the timer is the guarantee.
 * Whichever comes first wins, and the one that loses is harmless: a
 * second resolve is dropped.
 */

export interface AfterPaintOptions {
  /** `requestAnimationFrame` unless a test supplies one. */
  readonly frame?: (fn: () => void) => void;
  /** `setTimeout` unless a test supplies one. */
  readonly timer?: (fn: () => void, ms: number) => void;
  /**
   * How long to wait for a frame before going on without one.
   *
   * A quarter of a second: fifteen frames at 60 Hz, so a machine that is
   * painting at all has had many chances, and a page that will never
   * paint is not held up long enough for anyone to notice.
   */
  readonly timeoutMs?: number;
}

/** Resolve on the next painted frame, or after the timeout — whichever is first. */
export function afterPaint(opts: AfterPaintOptions = {}): Promise<void> {
  const frame = opts.frame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const timer = opts.timer ?? ((fn, ms) => void setTimeout(fn, ms));
  const timeoutMs = opts.timeoutMs ?? 250;
  return new Promise<void>((resolve) => {
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    // No rAF at all — node, a worker — is not a reason to wait at all.
    if (frame === undefined) {
      go();
      return;
    }
    frame(go);
    timer(go, timeoutMs);
  });
}
