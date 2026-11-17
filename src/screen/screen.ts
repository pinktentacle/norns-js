// E2-01 — bind the wasm screen to the `_norns` boundary.
//
// 45 of the 178 functions are `screen_*` and they are 36 of the 128 calls norns
// makes while booting, so this is the first subsystem that turns loud stubs
// into real behaviour. Each name registered here disappears from the
// compatibility page on its own (E1-06), with nothing to delete from a list.
//
// Nine of the 45 are deliberately NOT implemented here and stay stubbed; the
// reason is on each one in `UNIMPLEMENTED` below. Claiming a function and then
// doing nothing is worse than leaving it stubbed, because the registry stops
// reporting it.

import type { NornsRegistry } from "../norns/registry.js";
import type { LuaValue } from "../lua/lua.js";

/** The subset of the emscripten Module surface this file uses. */
interface ScreenModule {
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  _malloc(n: number): number;
  _free(p: number): void;
  stringToUTF8(s: string, ptr: number, max: number): void;
  lengthBytesUTF8(s: string): number;
  ccall(name: string, ret: string | null, args: string[], values: unknown[]): unknown;
  cwrap(name: string, ret: string | null, args: string[]): (...a: unknown[]) => unknown;
}

export interface Screen {
  readonly module: ScreenModule;
  /** ARGB32, 128*64*4 bytes, flushed. A view into wasm memory, not a copy. */
  pixels(): Uint8Array;
  /** 4-bit grey, one byte per pixel, 128*64. What the panel would receive. */
  greyscale(out?: Uint8Array): Uint8Array;
  /** Panel state a script set: brightness 0-15, contrast 0-255, gamma, invert. */
  panel(): { brightness: number; contrast: number; gamma: number; inverted: boolean };
  /**
   * Read a region of the surface as 0..15 grey, one byte per pixel.
   *
   * The same call `screen_peek` makes, exposed because the image family
   * (`src/screen/images.ts`) is built on it: with no way to add exports to
   * the wasm, an image is a JS-side buffer that peek fills and poke draws.
   */
  peek(x: number, y: number, w: number, h: number): Uint8Array;
  /** Write a region of 0..15 grey. The inverse of `peek`. */
  poke(x: number, y: number, w: number, h: number, bytes: Uint8Array): void;
  /** Install a font that was not preloaded. Returns false if FreeType refused. */
  installFont(index: number, bytes: Uint8Array): boolean;
  fontName(index: number): string;
  fontAvailable(index: number): boolean;
  /** Register every implemented `screen_*` on the registry. */
  register(registry: NornsRegistry): void;
}

export const SCREEN_W = 128;
export const SCREEN_H = 64;

/**
 * The nine that stay stubbed after this file, and why.
 *
 * Kept as data rather than as absence so the reason is visible next to the
 * name, and so a test can assert that the set of implemented plus the set of
 * deliberately-skipped is exactly the 45.
 */
export const UNIMPLEMENTED: Readonly<Record<string, string>> = {
  screen_load_png: "needs the image object of p1-api-plan §4.3 and a fetch; later in E2-01",
  screen_create_image: "same image object",
  screen_display_image: "same image object",
  screen_display_image_region: "same image object",
  screen_display_png: "needs a virtual filesystem to read the png from (E6-01)",
  screen_export_png: "needs somewhere to write; E6-01",
  screen_export_screenshot: "needs somewhere to write; E6-01",
  screen_update: "implemented, but as a JS-side callback rather than a wasm call — see below",
};

/**
 * Is this a wasm trap rather than a bug in our own code?
 *
 * `instanceof WebAssembly.RuntimeError` is the right test and not a
 * sufficient one: the error can arrive from another realm — a worker, a
 * test runner's sandbox — where `WebAssembly` is a different object and the
 * prototype chain does not match. Measured: the same trap that `instanceof`
 * recognised in the page escaped it under vitest, as
 * "RuntimeError: null function or function signature mismatch". So the
 * message is checked too, for the four shapes a trap actually takes.
 */
function isWasmTrap(err: unknown): boolean {
  if (err instanceof WebAssembly.RuntimeError) return true;
  if (!(err instanceof Error)) return false;
  return (
    err.name === "RuntimeError" &&
    /signature mismatch|unreachable|out of bounds|null function/i.test(err.message)
  );
}

export async function createScreen(
  factory: () => Promise<ScreenModule>,
  opts: {
    onUpdate?: () => void;
    /** A cairo call trapped and the context was rebuilt. See `guard`. */
    onTrap?: (name: string, count: number) => void;
    /**
     * The drawing module is past saving and will not be called again. The
     * page keeps running; the screen does not come back without a reload.
     */
    onGone?: (traps: number) => void;
  } = {},
): Promise<Screen> {
  const module = await factory();

  const call = {
    init: module.cwrap("screen_init", null, []),
    fontsLoaded: module.cwrap("screen_fonts_loaded", "number", []),
    fontCount: module.cwrap("screen_font_count", "number", []),
    fontAvailable: module.cwrap("screen_font_available", "number", ["number"]),
    // cwrap with a "string" return converts the char* for us, which is why
    // UTF8ToString is not in the module's exported runtime methods.
    fontName: module.cwrap("screen_font_name", "string", ["number"]),
    installFont: module.cwrap("screen_install_font", "number", ["number", "number", "number"]),
    buffer: module.cwrap("screen_buffer", "number", []),
    mayHaveColor: module.cwrap("screen_may_have_color", "number", []),
    textExtents: module.cwrap("screen_text_extents", null, ["string", "number"]),
    currentPoint: module.cwrap("screen_current_point", null, ["number", "number"]),
    peek: module.cwrap("screen_peek", null, ["number", "number", "number", "number", "number"]),
    poke: module.cwrap("screen_poke", null, ["number", "number", "number", "number", "number"]),
    textTrim: module.cwrap("screen_text_trim", null, ["number", "number"]),
    getBrightness: module.cwrap("screen_get_brightness", "number", []),
    getContrast: module.cwrap("screen_get_contrast", "number", []),
    getGamma: module.cwrap("screen_get_gamma", "number", []),
    getInverted: module.cwrap("screen_get_inverted", "number", []),
  };

  call.init();

  /**
   * EVERY CALL INTO THE WASM IS GUARDED, AT THE ONE DOOR THERE IS.
   *
   * Measured, with a one-line reproduction:
   *
   *     screen.move(-20, -5)
   *     screen.arc(44, 25, 18, 0, 6.3)
   *     screen.fill()
   *
   * raises `RuntimeError: function signature mismatch` from inside
   * screen.wasm, several frames deep in one recursive function — the shape
   * of a WASM STACK OVERFLOW: cairo's tessellator recurses past the stack,
   * the indirect call at the bottom lands on a bogus table index, and the
   * module traps. `mi-eng/resonate-r.lua` draws that path in its `init`,
   * which once left the screen black for the rest of the session.
   *
   * The proper fix is a bigger stack at link time (`-sSTACK_SIZE`) and it is
   * not available: this is a fixed build with no emscripten here. So the
   * trap is caught and the context rebuilt — `screen_init()` was measured to
   * restore drawing completely from the dead state. A frame is lost; the
   * session is not.
   *
   * WRAPPED HERE AND NOT AT THE REGISTRY, because the registry is not the
   * only caller: `pixels`, `greyscale`, `peek` and `poke` reach the module
   * directly, and `src/screen/images.ts` reaches them in turn. A guard on
   * the Lua-facing functions left those open, and a trap escaped through
   * one — observed as an uncaught `RuntimeError` with no Lua frame in it.
   * One door means there is nowhere left to add an unguarded path.
   *
   * Two things this does not pretend to be: a trap can leave the module's
   * heap half-updated, so a rebuilt context is a recovery and not a
   * guarantee; and `screen_init` re-creates the surface and the font faces
   * without destroying the old ones, so each recovery leaks a little. Both
   * beat a screen that never comes back.
   */
  let traps = 0;
  let trapping = false;
  let gone = false;
  const rawInit = call.init;

  /**
   * How many times the context may be rebuilt before we stop trying.
   *
   * `screen_init` LEAKS: it creates a new surface, a new context and a new
   * FreeType library with sixteen faces, and destroys none of the old ones.
   * Twice is a bad frame survived; fifty times is a corrupted heap, and
   * that is not a guess — rebuilding through a long run ended in
   * `RuntimeError: memory access out of bounds` from inside `screen_init`
   * itself, which is the allocator, not cairo.
   *
   * So recovery is bounded, and past the bound the module is declared GONE:
   * further calls return without touching it, so the rest of the page keeps
   * running, and the one thing that helps is said out loud.
   */
  const MAX_RECOVERIES = 2;

  /** Wrap one wasm entry point. Used for `call` and for `register`'s cwraps. */
  const guard = <A extends unknown[], R>(
    name: string,
    fn: (...args: A) => R,
  ): ((...args: A) => R | undefined) => {
    return (...args: A): R | undefined => {
      // Past the bound, the module is not touched at all. A call into a
      // corrupted heap is how "the screen is black" becomes "the tab is".
      if (gone) return undefined;
      try {
        return fn(...args);
      } catch (err) {
        if (!isWasmTrap(err)) throw err;
        // A trap while recovering would recurse for ever. One attempt.
        if (trapping) throw err;
        trapping = true;
        try {
          traps++;
          if (traps <= MAX_RECOVERIES) {
            rawInit();
            opts.onTrap?.(name, traps);
          } else if (!gone) {
            gone = true;
            opts.onGone?.(traps);
          }
        } catch {
          // The rebuild trapped too: the module is past saving.
          gone = true;
          opts.onGone?.(traps);
        } finally {
          trapping = false;
        }
        return undefined;
      }
    };
  };

  for (const key of Object.keys(call) as Array<keyof typeof call>) {
    const fn = call[key] as (...a: unknown[]) => unknown;
    (call as Record<string, unknown>)[key] = guard(String(key), fn);
  }

  /** Scratch for the 6 doubles screen_text_extents writes. */
  const extentsBuf = module._malloc(6 * 8);
  const pointBuf = module._malloc(2 * 8);

  const peek = (x: number, y: number, w: number, h: number): Uint8Array => {
    const cw = Math.min(w, SCREEN_W - x);
    const ch = Math.min(h, SCREEN_H - y);
    if (cw <= 0 || ch <= 0) return new Uint8Array(0);
    const p = module._malloc(cw * ch);
    call.peek(x, y, w, h, p);
    const bytes = module.HEAPU8.slice(p, p + cw * ch);
    module._free(p);
    return bytes;
  };

  const poke = (x: number, y: number, w: number, h: number, bytes: Uint8Array): void => {
    if (!bytes.length) return;
    const p = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, p);
    call.poke(x, y, w, h, p);
    module._free(p);
  };

  const pixels = (): Uint8Array => {
    const ptr = call.buffer() as number;
    return module.HEAPU8.subarray(ptr, ptr + SCREEN_W * SCREEN_H * 4);
  };

  const greyscale = (out?: Uint8Array): Uint8Array => {
    // E2-07. `ssd1322.cc:283-305` has two paths and picks by a flag: when
    // nothing that could carry colour has been drawn, it takes the GREEN
    // channel alone, justified by "RGB are all equal"; otherwise it applies
    // a luminance weighting with the integer coefficients below. Doing only
    // the first would mangle a displayed PNG; doing only the second would be
    // slower and, for text, identical.
    const src = pixels();
    const dst = out ?? new Uint8Array(SCREEN_W * SCREEN_H);
    const colour = (call.mayHaveColor() as number) !== 0;
    for (let i = 0, p = 0; p < dst.length; i += 4, p++) {
      // Little-endian ARGB32 in memory is B, G, R, A.
      const b = src[i]!, g = src[i + 1]!, r = src[i + 2]!;
      // The panel takes the UPPER nibble; a value is 0-255 here and 0-15 there.
      dst[p] = colour ? (r * 64 + g * 160 + b * 32) >> 13 : g >> 4;
    }
    return dst;
  };

  const screen: Screen = {
    module,
    pixels,
    peek,
    poke,
    greyscale,
    panel: () => ({
      brightness: call.getBrightness() as number,
      contrast: call.getContrast() as number,
      gamma: call.getGamma() as number,
      inverted: (call.getInverted() as number) !== 0,
    }),
    fontName: (i) => call.fontName(i) as string,
    fontAvailable: (i) => (call.fontAvailable(i) as number) !== 0,
    installFont: (index, bytes) => {
      const p = module._malloc(bytes.length);
      module.HEAPU8.set(bytes, p);
      const ok = (call.installFont(index, p, bytes.length) as number) !== 0;
      module._free(p); // screen_install_font copies; this buffer is ours
      return ok;
    },

    register(registry: NornsRegistry): void {
      // The hand-written ones below reach the wasm through `call`, which is
      // guarded. The `direct` table makes its OWN cwraps, so those are
      // guarded where they are made — measured, after a guard that covered
      // only `call` let `screen_fill` trap straight through it.
      const implement = (
        name: string,
        fn: (...args: LuaValue[]) => LuaValue[] | void,
      ): void => registry.implement(name, fn);

      const direct: Record<string, [string, string[]]> = {
        screen_aa: ["screen_aa", ["number"]],
        screen_brightness: ["screen_brightness", ["number"]],
        screen_clear: ["screen_clear", []],
        // Lua calls it `screen_close`; matron routes it to close_path.
        screen_close: ["screen_close_path", []],
        screen_contrast: ["screen_contrast", ["number"]],
        screen_fill: ["screen_fill", []],
        screen_font_face: ["screen_font_face", ["number"]],
        screen_font_size: ["screen_font_size", ["number"]],
        screen_gamma: ["screen_gamma", ["number"]],
        screen_invert: ["screen_invert", ["number"]],
        screen_level: ["screen_level", ["number"]],
        screen_line: ["screen_line", ["number", "number"]],
        screen_line_cap: ["screen_line_cap", ["string"]],
        screen_line_join: ["screen_line_join", ["string"]],
        screen_line_rel: ["screen_line_rel", ["number", "number"]],
        screen_line_width: ["screen_line_width", ["number"]],
        screen_miter_limit: ["screen_miter_limit", ["number"]],
        screen_move: ["screen_move", ["number", "number"]],
        screen_move_rel: ["screen_move_rel", ["number", "number"]],
        screen_rect: ["screen_rect", ["number", "number", "number", "number"]],
        screen_restore: ["screen_restore", []],
        screen_rotate: ["screen_rotate", ["number"]],
        screen_save: ["screen_save", []],
        screen_set_operator: ["screen_set_operator", ["number"]],
        screen_stroke: ["screen_stroke", []],
        screen_text: ["screen_text", ["string"]],
        screen_text_center: ["screen_text_center", ["string"]],
        screen_text_right: ["screen_text_right", ["string"]],
        screen_translate: ["screen_translate", ["number", "number"]],
      };

      for (const [luaName, [cName, argTypes]] of Object.entries(direct)) {
        const fn = guard(cName, module.cwrap(cName, null, argTypes));
        implement(luaName, (...args: LuaValue[]) => {
          fn(...(args.slice(0, argTypes.length) as unknown[]));
        });
      }

      // --- CURVES ARE FLATTENED BEFORE THEY REACH CAIRO -------------------
      //
      // Measured, and it is the worst defect this project has found in its
      // own build: **filling a path that contains a curve traps**. Not a
      // large one, not a degenerate one — `arc(44, 25, 2, 0, 6.28)` and a
      // `fill` is enough, and so is a single bezier. The module raises
      // `RuntimeError: function signature mismatch` from inside cairo, and
      // after it EVERY later call into the module traps too: the screen is
      // gone for the rest of the session.
      //
      // What works, measured alongside it on the same page:
      //
      //     arc + stroke          ok, 151 pixels
      //     polygon + fill        ok, 1020 pixels (a 64-segment circle)
      //     arc + fill            TRAP
      //     bezier + fill         TRAP
      //
      // So cairo's fill is fine and its CURVE fill is not — a link-time
      // problem in this build, which cannot be rebuilt here. Flattening is
      // the fix that is available: an arc becomes line segments, a bezier
      // becomes line segments, and nothing curved ever reaches the
      // tessellator. At 128x64 with antialiasing off, one segment per pixel
      // of arc length is indistinguishable from the curve.
      //
      // It costs the CURRENT POINT, which has to be tracked here because
      // cairo's arc draws a line from it when a subpath is open and starts
      // a new one when it is not. Everything that moves the point updates
      // these three.
      let hasPoint = false;
      let px = 0;
      let py = 0;

      /** The path primitives, guarded like everything else. */
      const path = {
        move: guard("screen_move", module.cwrap("screen_move", null, ["number", "number"])),
        line: guard("screen_line", module.cwrap("screen_line", null, ["number", "number"])),
        moveRel: guard("screen_move_rel", module.cwrap("screen_move_rel", null, ["number", "number"])),
        lineRel: guard("screen_line_rel", module.cwrap("screen_line_rel", null, ["number", "number"])),
        rect: guard(
          "screen_rect",
          module.cwrap("screen_rect", null, ["number", "number", "number", "number"]),
        ),
        fill: guard("screen_fill", module.cwrap("screen_fill", null, [])),
        stroke: guard("screen_stroke", module.cwrap("screen_stroke", null, [])),
        clear: guard("screen_clear", module.cwrap("screen_clear", null, [])),
      };

      const movePoint = (x: number, y: number): void => {
        px = x;
        py = y;
        hasPoint = true;
      };

      /** Join to the arc's start the way `cairo_arc` would. */
      const beginAt = (x: number, y: number): void => {
        if (hasPoint) path.line(x, y);
        else path.move(x, y);
        movePoint(x, y);
      };

      implement("screen_arc", (x, y, r, a1, a2) => {
        const cx = Number(x ?? 0);
        const cy = Number(y ?? 0);
        const rad = Number(r ?? 0);
        const from = Number(a1 ?? 0);
        const to = Number(a2 ?? 0);
        // cairo sweeps FORWARDS from a1 to a2, adding 2pi until a2 >= a1.
        let sweep = to - from;
        while (sweep < 0) sweep += Math.PI * 2;
        // One segment per pixel of arc length, within reason. A radius of
        // zero still has to move the point, as cairo does.
        const steps = Math.max(8, Math.min(512, Math.ceil(Math.abs(sweep) * Math.max(1, rad))));
        beginAt(cx + Math.cos(from) * rad, cy + Math.sin(from) * rad);
        for (let i = 1; i <= steps; i++) {
          const a = from + (sweep * i) / steps;
          const ax = cx + Math.cos(a) * rad;
          const ay = cy + Math.sin(a) * rad;
          path.line(ax, ay);
          movePoint(ax, ay);
        }
      });

      /** A cubic bezier as line segments, from the current point. */
      const bezier = (
        x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
      ): void => {
        const x0 = px;
        const y0 = py;
        if (!hasPoint) {
          path.move(x0, y0);
          hasPoint = true;
        }
        // Steps from the control polygon's length: long curves get more.
        const len =
          Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
        const steps = Math.max(8, Math.min(256, Math.ceil(len)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          const bx = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const by = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          path.line(bx, by);
          movePoint(bx, by);
        }
      };

      implement("screen_curve", (x1, y1, x2, y2, x3, y3) =>
        bezier(Number(x1 ?? 0), Number(y1 ?? 0), Number(x2 ?? 0), Number(y2 ?? 0), Number(x3 ?? 0), Number(y3 ?? 0)),
      );
      implement("screen_curve_rel", (dx1, dy1, dx2, dy2, dx3, dy3) =>
        bezier(
          px + Number(dx1 ?? 0), py + Number(dy1 ?? 0),
          px + Number(dx2 ?? 0), py + Number(dy2 ?? 0),
          px + Number(dx3 ?? 0), py + Number(dy3 ?? 0),
        ),
      );

      // The rest of the path machinery, wrapped only to keep the current
      // point honest. Each still calls exactly what it called before.
      implement("screen_move", (x, y) => {
        path.move(Number(x ?? 0), Number(y ?? 0));
        movePoint(Number(x ?? 0), Number(y ?? 0));
      });
      implement("screen_line", (x, y) => {
        path.line(Number(x ?? 0), Number(y ?? 0));
        movePoint(Number(x ?? 0), Number(y ?? 0));
      });
      implement("screen_move_rel", (x, y) => {
        path.moveRel(Number(x ?? 0), Number(y ?? 0));
        movePoint(px + Number(x ?? 0), py + Number(y ?? 0));
      });
      implement("screen_line_rel", (x, y) => {
        path.lineRel(Number(x ?? 0), Number(y ?? 0));
        movePoint(px + Number(x ?? 0), py + Number(y ?? 0));
      });
      implement("screen_rect", (x, y, w, h) => {
        path.rect(Number(x ?? 0), Number(y ?? 0), Number(w ?? 0), Number(h ?? 0));
        // `cairo_rectangle` ends with a close, leaving the point at x,y.
        movePoint(Number(x ?? 0), Number(y ?? 0));
      });
      // A consumed path has no current point, which is what makes the next
      // arc start a subpath instead of drawing a line across the screen.
      implement("screen_fill", () => {
        path.fill();
        hasPoint = false;
      });
      implement("screen_stroke", () => {
        path.stroke();
        hasPoint = false;
      });
      implement("screen_clear", () => {
        path.clear();
        hasPoint = false;
      });

      // The ones whose shape is not a straight forward.
      implement("screen_text_extents", (s) => {
        call.textExtents(String(s ?? ""), extentsBuf);
        const i = extentsBuf / 8;
        // Two values, not six. weaver.cc:1142 returns 2; the 6-value branch
        // is dead upstream (p1-api-plan §4.1).
        return [module.HEAPF64[i]!, module.HEAPF64[i + 1]!];
      });

      implement("screen_current_point", () => {
        call.currentPoint(pointBuf, pointBuf + 8);
        const i = pointBuf / 8;
        return [module.HEAPF64[i]!, module.HEAPF64[i + 1]!];
      });

      implement("screen_text_trim", (s, w) => {
        // Upstream truncates the caller's buffer IN PLACE. Give it a scratch
        // copy: mutating a Lua string's bytes from here would corrupt a value
        // Lua believes is immutable and shares between variables.
        const text = String(s ?? "");
        const n = module.lengthBytesUTF8(text) + 1;
        const p = module._malloc(n);
        module.stringToUTF8(text, p, n);
        call.textTrim(p, Number(w ?? 0));
        module._free(p);
      });

      implement("screen_peek", (x, y, w, h) => {
        // A BINARY string of exactly w*h bytes valued 0-15. Not a table, not
        // hex: screen_poke consumes the same bytes back.
        const bytes = peek(Number(x ?? 0), Number(y ?? 0), Number(w ?? 0), Number(h ?? 0));
        return bytes.length ? [bytes] : [""];
      });

      implement("screen_poke", (x, y, w, h, data) => {
        const bytes =
          data instanceof Uint8Array
            ? data
            : new Uint8Array(typeof data === "string" ? [...data].map((c) => c.charCodeAt(0)) : []);
        poke(Number(x ?? 0), Number(y ?? 0), Number(w ?? 0), Number(h ?? 0), bytes);
      });

      // `screen_update` has no wasm side: the surface is already drawn, and
      // what upstream does next is push it over SPI. Here the host decides
      // (canvas, test harness, nothing at all), so it is a callback.
      implement("screen_update", () => {
        opts.onUpdate?.();
      });
    },
  };

  return screen;
}
