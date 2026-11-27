// E5-24 — the image and PNG half of the screen API, the last seven.
//
// `screen.display_png`, `screen.load_png`, `screen.create_image`,
// `screen.display_image`, `screen.display_image_region`,
// `screen.export_png` and `screen.export_screenshot`. Three bundled scripts
// display a PNG (mi-eng's waveform pictures, zxcvbn's renders) and three
// export one (cheat_codes_2, arcologies, dreamsequence), so this is not a
// completeness exercise -- it is a feature that was missing.
//
// WHY NONE OF IT IS IN THE WASM. Upstream does all of this in cairo:
// `cairo_image_surface_create_from_png`, a second surface per image, and
// `cairo_surface_write_to_png`. Our screen module is a fixed build and there
// is no emscripten here to add exports to it, so everything below is done on
// the JS side through the two doors the wasm already has: `screen_peek` reads
// the surface as 0-15 grey, `screen_poke` writes it back. That is enough,
// because an image on norns IS a grey surface.
//
// THE COLOUR CONVERSION IS NORNS'. `ssd1322.cc:289-296` weights a colour
// surface as R*64 + G*160 + B*32 >> 8 -- the integer approximation of BT.2020
// luma that the panel driver uses -- and takes the top nibble. A PNG goes
// through the same arithmetic here, at draw time rather than at panel time,
// which is why `screen_may_have_color` stays false: by the time the pixels
// reach the surface they already are grey, and R=G=B makes both of the
// driver's two paths agree.
//
// DECODING IS ASYNCHRONOUS AND DRAWING IS NOT. The browser decodes a PNG off
// the main thread and Lua's `redraw()` cannot await anything, so the first
// call for a file starts the decode, draws nothing, and asks for a redraw
// when the pixels land. Scripts redraw constantly, so the picture appears on
// the next frame; a script that drew it once in `init` gets its redraw from
// the `onChanged` callback. ENCODING is synchronous -- `canvas.toDataURL` is
// -- so an export writes its file before it returns, as upstream does.
//
// WHAT IS APPROXIMATE, said plainly: an image captured by `screen.draw_to` is
// read back through `screen_peek`, which returns grey and not alpha, so a
// pixel at level 0 comes back TRANSPARENT rather than opaque black. On a
// screen that is black anyway the two are indistinguishable until the image
// is composited over something, and `draw_to` on a cleared surface is the
// case this gets right. A loaded PNG keeps its real alpha, which is where it
// matters.

import type { NornsRegistry } from "../norns/registry.js";
import type { Screen } from "./screen.js";
import { SCREEN_H, SCREEN_W } from "./screen.js";
import type { Vfs } from "../fs/vfs.js";
import { lauxlib, lua, to_luastring, type LuaState } from "../lua/lua.js";
import { decodePngSync } from "./png-sync.js";

export interface ScreenImage {
  readonly id: number;
  readonly name: string;
  width: number;
  height: number;
  /** 0..15, one byte per pixel, row major, `width` stride. */
  grey: Uint8Array;
  /** 0..255 coverage, same shape. */
  alpha: Uint8Array;
  /** False while a PNG is still being decoded into it. */
  ready: boolean;
}

export interface ImageOptions {
  readonly screen: Screen;
  readonly vfs: Vfs;
  readonly log?: (line: string) => void;
  /** Something changed that was not drawn by Lua: ask for a redraw. */
  readonly onChanged?: () => void;
}

/** norns' own colour-to-grey weights, out of 256. `ssd1322.cc:291-293`. */
export function luma4(r: number, g: number, b: number): number {
  return ((r * 64 + g * 160 + b * 32) >> 8) >> 4;
}

/** Decode a PNG into the grey + alpha pair an image holds. */
export async function decodePng(
  bytes: Uint8Array,
): Promise<{ width: number; height: number; grey: Uint8Array; alpha: Uint8Array }> {
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  // Width and height are read BEFORE close(): a closed ImageBitmap reports
  // zero for both, and getImageData then refuses "source width is 0".
  const width = bmp.width;
  const height = bmp.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context for decoding");
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, width, height).data;
  const n = width * height;
  const grey = new Uint8Array(n);
  const alpha = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    grey[i] = luma4(data[p]!, data[p + 1]!, data[p + 2]!);
    alpha[i] = data[p + 3]!;
  }
  return { width, height, grey, alpha };
}

/**
 * The surface as a PNG, synchronously.
 *
 * `toDataURL` is the only image encoder in a browser that does not return a
 * promise, and an export has to finish before it returns: upstream's
 * `cairo_surface_write_to_png` does, and a script that exports a frame and
 * then renames the file would race anything else.
 */
export function encodePng(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for encoding");
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  const url = canvas.toDataURL("image/png");
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function registerScreenImages(registry: NornsRegistry, opts: ImageOptions): void {
  const { screen, vfs } = opts;
  const log = opts.log ?? ((): void => {});
  const images = new Map<number, ScreenImage>();
  /** Decoded PNGs, by path. A script redraws its picture sixty times a second. */
  const pngCache = new Map<string, ScreenImage>();
  /** Paths whose decode is in flight, so a redraw loop starts one fetch. */
  const pending = new Set<string>();
  let nextId = 1;

  const newImage = (name: string, width: number, height: number): ScreenImage => {
    const img: ScreenImage = {
      id: nextId++,
      name,
      width,
      height,
      grey: new Uint8Array(width * height),
      alpha: new Uint8Array(width * height),
      ready: false,
    };
    images.set(img.id, img);
    return img;
  };

  // --- reading a file, which may be local or may be a URL ----------------

  const bytesFor = async (path: string): Promise<Uint8Array | null> => {
    const local = vfs.read(path);
    if (local) return local;
    const remote = vfs.remoteAt(path);
    if (!remote) return null;
    const res = await fetch(remote.url);
    if (!res.ok) throw new Error(`${remote.url}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  const knows = (path: string): boolean =>
    vfs.read(path) !== null || vfs.remoteAt(path) !== null;

  /**
   * E9-264 — a PNG already in memory is decoded now, as cairo does: a
   * script that reads its picture back in `init` (esper) gets pixels, not
   * zeros. Past a million pixels the synchronous decode costs a visible
   * pause (3299x2662 took 226 ms), and those keep the browser's decoder.
   */
  const SYNC_MAX_PIXELS = 1 << 20;
  const fillNow = (img: ScreenImage, path: string): boolean => {
    const bytes = vfs.read(path);
    if (bytes === null || bytes.length < 24) return false;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(16) * v.getUint32(20) > SYNC_MAX_PIXELS) return false;
    let d: ReturnType<typeof decodePngSync>;
    try {
      d = decodePngSync(bytes);
    } catch {
      return false; // the browser's decoder gets its turn, and says what is wrong
    }
    if (d === null) return false;
    const n = d.width * d.height;
    const grey = new Uint8Array(n);
    const alpha = new Uint8Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      grey[i] = luma4(d.rgba[q]!, d.rgba[q + 1]!, d.rgba[q + 2]!);
      alpha[i] = d.rgba[q + 3]!;
    }
    img.width = d.width;
    img.height = d.height;
    img.grey = grey;
    img.alpha = alpha;
    img.ready = true;
    return true;
  };

  const fill = (img: ScreenImage, path: string): void => {
    if (fillNow(img, path)) return;
    if (pending.has(path)) return;
    pending.add(path);
    void (async () => {
      try {
        const bytes = await bytesFor(path);
        if (!bytes) throw new Error("no such file");
        const d = await decodePng(bytes);
        img.width = d.width;
        img.height = d.height;
        img.grey = d.grey;
        img.alpha = d.alpha;
        img.ready = true;
        // The pixels arrived after the frame that wanted them. Ask for
        // another, or a script that drew its picture once never shows it.
        opts.onChanged?.();
      } catch (err) {
        log(`screen: could not load ${path}: ${String((err as Error)?.message ?? err)}`);
      } finally {
        pending.delete(path);
      }
    })();
  };

  // --- compositing -------------------------------------------------------

  /**
   * Draw a region of an image onto the surface, OVER.
   *
   * Read, blend, write: `screen_poke` overwrites, and overwriting would
   * punch a transparent PNG's background through whatever is underneath.
   * cairo composites, so this does too.
   */
  const blit = (
    img: ScreenImage,
    left: number,
    top: number,
    w: number,
    h: number,
    x: number,
    y: number,
  ): void => {
    const dx = Math.round(x);
    const dy = Math.round(y);
    // Clip to both the image and the screen before touching anything.
    const sx = Math.max(0, Math.round(left));
    const sy = Math.max(0, Math.round(top));
    let cw = Math.min(Math.round(w), img.width - sx, SCREEN_W - dx);
    let ch = Math.min(Math.round(h), img.height - sy, SCREEN_H - dy);
    if (dx < 0) cw += dx;
    if (dy < 0) ch += dy;
    if (cw <= 0 || ch <= 0) return;
    const ox = Math.max(0, dx);
    const oy = Math.max(0, dy);
    const skipX = ox - dx;
    const skipY = oy - dy;

    // E9-280 — IN EIGHT BITS, ON THE SURFACE ITSELF, as matron's cairo
    // does (`cairo_set_source_surface` and a fill). This went through
    // `peek` and `poke`, and `screen_peek` is upstream's: it reads the low
    // nibble of a pixel, `& 0xF`, which is the level only when the byte is
    // a whole level times 17. A pixel left by antialiasing or by the ADD
    // operator is not, so it came back as some other level -- 0x2C as 12 --
    // and was written back as that, even under a fully TRANSPARENT part of
    // the image. fireflies drew a soft glow and then its meadow over it,
    // and the glow came out as a ring of bright dots. Now a transparent
    // pixel leaves the surface alone, an opaque one writes its level, and
    // one in between is composited OVER in premultiplied alpha.
    const data = screen.surface();
    if (data.length < SCREEN_W * SCREEN_H * 4) return;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const s = (sy + skipY + j) * img.width + (sx + skipX + i);
        const a = img.alpha[s]!;
        if (a === 0) continue;
        const v = img.grey[s]! * 17;
        const o = ((oy + j) * SCREEN_W + (ox + i)) * 4;
        if (a === 255) {
          data[o] = v;
          data[o + 1] = v;
          data[o + 2] = v;
          data[o + 3] = 255;
          continue;
        }
        const k = (255 - a) / 255;
        const sv = (v * a) / 255;
        data[o] = Math.round(sv + data[o]! * k);
        data[o + 1] = Math.round(sv + data[o + 1]! * k);
        data[o + 2] = Math.round(sv + data[o + 2]! * k);
        data[o + 3] = Math.round(a + data[o + 3]! * k);
      }
    }
    screen.touched();
  };

  // --- the image object, as Lua sees it ----------------------------------

  /**
   * The focus stack for `screen.draw_to`.
   *
   * Drawing into an image means drawing on the only surface there is and
   * taking the result away afterwards, so focusing SAVES the screen and
   * clears it, and defocusing reads the image back and puts the screen
   * where it was. It nests, because `draw_to` can.
   */
  const focused: Array<{ img: ScreenImage; saved: Uint8Array }> = [];

  const imageAt = (S: LuaState, idx: number): ScreenImage | null => {
    if (lua.lua_type(S, idx) !== lua.LUA_TTABLE) return null;
    lua.lua_getfield(S, idx, to_luastring("__id"));
    const id = lua.lua_tointeger(S, -1);
    lua.lua_pop(S, 1);
    return images.get(Number(id)) ?? null;
  };

  const pushImage = (S: LuaState, img: ScreenImage): number => {
    lua.lua_createtable(S, 0, 8);
    const setNum = (k: string, v: number): void => {
      lua.lua_pushinteger(S, v);
      lua.lua_setfield(S, -2, to_luastring(k));
    };
    const setFn = (k: string, fn: (s: LuaState) => number): void => {
      lua.lua_pushcfunction(S, fn);
      lua.lua_setfield(S, -2, to_luastring(k));
    };
    lua.lua_pushboolean(S, true);
    lua.lua_setfield(S, -2, to_luastring("__norns_image"));
    setNum("__id", img.id);
    setNum("__w", img.width);
    setNum("__h", img.height);
    lua.lua_pushstring(S, to_luastring(img.name));
    lua.lua_setfield(S, -2, to_luastring("__name"));

    // The four methods `screen.lua` calls, as fields: `image:extents()` is a
    // plain index, so a metatable is not needed for them to work.
    setFn("_context_focus", (s) => {
      const self = imageAt(s, 1);
      if (!self) return 0;
      focused.push({ img: self, saved: screen.peek(0, 0, SCREEN_W, SCREEN_H) });
      screen.poke(0, 0, SCREEN_W, SCREEN_H, new Uint8Array(SCREEN_W * SCREEN_H));
      return 0;
    });
    setFn("_context_defocus", (s) => {
      const top = focused.pop();
      if (!top) return 0;
      const w = Math.min(top.img.width, SCREEN_W);
      const h = Math.min(top.img.height, SCREEN_H);
      const got = screen.peek(0, 0, w, h);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const v = got[j * w + i]!;
          const t = j * top.img.width + i;
          top.img.grey[t] = v;
          // See the file comment: peek has no alpha, so level 0 is taken as
          // transparent. That is what a cleared surface drawn onto gives.
          top.img.alpha[t] = v === 0 ? 0 : 255;
        }
      }
      top.img.ready = true;
      screen.poke(0, 0, SCREEN_W, SCREEN_H, top.saved);
      void s;
      return 0;
    });
    setFn("extents", (s) => {
      const self = imageAt(s, 1);
      if (!self || !self.width || !self.height) return 0;
      lua.lua_pushinteger(s, self.width);
      lua.lua_pushinteger(s, self.height);
      return 2;
    });
    setFn("name", (s) => {
      const self = imageAt(s, 1);
      lua.lua_pushstring(s, to_luastring(self?.name ?? ""));
      return 1;
    });

    // `__tostring`, `__eq` and `__gc` are METAMETHODS and have to be on a
    // metatable to be reached, unlike the four above.
    lua.lua_createtable(S, 0, 3);
    const setMeta = (k: string, fn: (s: LuaState) => number): void => {
      lua.lua_pushcfunction(S, fn);
      lua.lua_setfield(S, -2, to_luastring(k));
    };
    setMeta("__tostring", (s) => {
      const self = imageAt(s, 1);
      lua.lua_pushstring(
        s,
        to_luastring(self ? `image(${self.name || "untitled"} ${self.width}x${self.height})` : "image()"),
      );
      return 1;
    });
    setMeta("__eq", (s) => {
      const a = imageAt(s, 1);
      const b = imageAt(s, 2);
      lua.lua_pushboolean(s, a !== null && a === b);
      return 1;
    });
    setMeta("__gc", (s) => {
      const self = imageAt(s, 1);
      // A cached PNG is shared, so only an image nobody can ask for again
      // goes. Dropping a cached one would make the next draw re-fetch it.
      if (self && ![...pngCache.values()].includes(self)) images.delete(self.id);
      return 0;
    });
    lua.lua_setmetatable(S, -2);
    return 1;
  };

  // --- the seven functions ------------------------------------------------

  registry.implementRaw("screen_create_image", (S) => {
    const w = Math.floor(lua.lua_tonumber(S, 1));
    const h = Math.floor(lua.lua_tonumber(S, 2));
    if (!(w >= 1) || !(h >= 1)) {
      return lauxlib.luaL_error(S, to_luastring("image dimensions too small; must be >= 1"));
    }
    const img = newImage("", w, h);
    img.ready = true;
    lua.lua_settop(S, 0);
    return pushImage(S, img);
  });

  registry.implementRaw("screen_load_png", (S) => {
    const path = lua.lua_tojsstring(S, 1);
    // Upstream raises when the file will not load, and a wrong path is the
    // failure that actually happens. What is checked here is that the file
    // EXISTS: one in memory is then decoded at once (E9-264), one that is
    // still to be fetched cannot be waited for.
    if (!path || !knows(path)) {
      return lauxlib.luaL_error(S, to_luastring("image loading failed"));
    }
    const cached = pngCache.get(path);
    if (cached) {
      lua.lua_settop(S, 0);
      return pushImage(S, cached);
    }
    const img = newImage(path, 1, 1);
    pngCache.set(path, img);
    fill(img, path);
    lua.lua_settop(S, 0);
    return pushImage(S, img);
  });

  registry.implementRaw("screen_display_image", (S) => {
    const img = imageAt(S, 1);
    const x = lua.lua_tonumber(S, 2);
    const y = lua.lua_tonumber(S, 3);
    if (img && img.ready) blit(img, 0, 0, img.width, img.height, Number(x), Number(y));
    lua.lua_settop(S, 0);
    return 0;
  });

  registry.implementRaw("screen_display_image_region", (S) => {
    const img = imageAt(S, 1);
    const left = Number(lua.lua_tonumber(S, 2));
    const top = Number(lua.lua_tonumber(S, 3));
    const w = Number(lua.lua_tonumber(S, 4));
    const h = Number(lua.lua_tonumber(S, 5));
    const x = Number(lua.lua_tonumber(S, 6));
    const y = Number(lua.lua_tonumber(S, 7));
    if (img && img.ready) blit(img, left, top, w, h, x, y);
    lua.lua_settop(S, 0);
    return 0;
  });

  registry.implement("screen_display_png", (path, x, y) => {
    const p = String(path ?? "");
    if (!p) return;
    const cached = pngCache.get(p);
    if (cached) {
      if (cached.ready) blit(cached, 0, 0, cached.width, cached.height, Number(x ?? 0), Number(y ?? 0));
      return;
    }
    if (!knows(p)) {
      // Upstream prints and returns rather than raising, for this one.
      log(`display_png: no such file: ${p}`);
      // Remembered as a miss so a redraw loop does not say it sixty times.
      pngCache.set(p, newImage(p, 1, 1));
      return;
    }
    const img = newImage(p, 1, 1);
    pngCache.set(p, img);
    fill(img, p);
    // Decoded on the spot (E9-264): drawn on this frame, not the next.
    if (img.ready) blit(img, 0, 0, img.width, img.height, Number(x ?? 0), Number(y ?? 0));
  });

  // --- exporting ----------------------------------------------------------

  /** The surface as RGBA, from cairo's ARGB32 (which is BGRA in memory). */
  const surfaceRgba = (): Uint8ClampedArray<ArrayBuffer> => {
    const src = screen.pixels();
    const out = new Uint8ClampedArray(new ArrayBuffer(SCREEN_W * SCREEN_H * 4));
    for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
      const p = i * 4;
      out[p] = src[p + 2]!;
      out[p + 1] = src[p + 1]!;
      out[p + 2] = src[p]!;
      out[p + 3] = 255;
    }
    return out;
  };

  const writePng = (path: string, bytes: Uint8Array, what: string): void => {
    try {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) vfs.mkdir(dir);
      vfs.write(path, bytes);
      log(`${what}: wrote ${path} (${bytes.length} bytes)`);
    } catch (err) {
      log(`${what}: ${path}: ${String((err as Error)?.message ?? err)}`);
    }
  };

  registry.implement("screen_export_png", (path) => {
    const p = String(path ?? "");
    if (!p) return;
    writePng(p, encodePng(surfaceRgba(), SCREEN_W, SCREEN_H), "export_png");
  });

  registry.implement("screen_export_screenshot", (path) => {
    const p = String(path ?? "");
    if (!p) return;
    // 640x384: the screen at 4x, on black, inside a 64-pixel border. The
    // numbers are upstream's, in `screen.cc:481-500`.
    const W = 640;
    const H = 384;
    const rgba = new Uint8ClampedArray(new ArrayBuffer(W * H * 4));
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const src = screen.pixels();
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const s = (y * SCREEN_W + x) * 4;
        const r = src[s + 2]!;
        const g = src[s + 1]!;
        const b = src[s]!;
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 4; i++) {
            const d = ((64 + y * 4 + j) * W + (64 + x * 4 + i)) * 4;
            rgba[d] = r;
            rgba[d + 1] = g;
            rgba[d + 2] = b;
          }
        }
      }
    }
    writePng(p, encodePng(rgba, W, H), "export_screenshot");
  });
}
