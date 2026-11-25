// E5-23 — prove a script WORKS, not that it loaded.
//
// The Node sweep (`test/community.test.ts`) answers one question: does the
// Lua run? It is fast, it names a file and a line, and it is the right first
// question — but it has no scsynth, so it cannot ask the second one. This
// asks the second one, in the page, where the engine is real.
//
// WHAT "WORKS" MEANS HERE, as six measurements rather than a verdict:
//
//   1. it loads, and `init()` returns;
//   2. it DRAWS — the screen is not blank after a redraw. A script whose
//      init threw half way often still loads "successfully" and then shows
//      nothing, which is the failure a user actually sees;
//   3. it RESPONDS — K2, K3 and the three encoders each change the screen,
//      or do not. Both are legitimate (a script with one page ignores E1),
//      so this is recorded and not judged;
//   4. it takes a grid press without erroring, and whether the grid lit up;
//   5. it makes a SOUND, measured as the peak at the master meter — which
//      sits before the mute, so none of this has to be audible;
//   6. it leaves no errors behind, from `norns.scripterror` or from Lua.
//
// REUSABLE IS THE POINT, and the thing that makes it reusable is that it
// enumerates the dust tree rather than holding a list: a script added
// tomorrow is exercised tomorrow with no edit here. `only` narrows it when
// you are working on one.
//
// WHY IT IS NOT A TEST FILE. It needs a browser with an AudioWorklet, a
// cross-origin-isolated origin and a real scsynth; vitest under Node has
// none of those. It runs in the page and hands back JSON, so a headless
// Chromium can call it unchanged the day one is wired up — that is the
// shape, deliberately.

import type { Host } from "../lua/host.js";
import type { Screen } from "../screen/screen.js";
import type { Vfs } from "../fs/vfs.js";
import { lua, to_luastring } from "../lua/lua.js";

export interface ExerciseContext {
  readonly host: Host;
  readonly vfs: Vfs;
  readonly screen: Screen;
  /** Peak at the master meter, 0..1, or null if there is no audio graph. */
  readonly peak: () => number | null;
  /** What the grid is presenting, or null if none is plugged in. */
  readonly grid: () => Uint8Array | null;
  /** Press or release a grid key, 1-based as Lua sees them. */
  readonly gridKey: (x: number, y: number, z: 0 | 1) => void;
  readonly key: (n: 1 | 2 | 3, z: 0 | 1) => void;
  readonly enc: (n: 1 | 2 | 3, delta: number) => void;
  /**
   * A note from the virtual MIDI keyboard, when one is attached.
   *
   * Half of these scripts are instruments: they draw a steady screen, they
   * respond to nothing on the panel, and they are entirely correct. The only
   * input that asks them a question is a note, so without this the sweep
   * reports "no sound" about a synth it never played.
   */
  readonly note?: ((n: number, velocity: number) => void) | undefined;
  readonly noteOff?: ((n: number) => void) | undefined;
  readonly log?: (line: string) => void;
}

export interface ExerciseOptions {
  /** Script paths to run. Defaults to every `<dir>/<name>.lua` in the tree. */
  readonly only?: readonly string[];
  /** Substrings to leave out. */
  readonly skip?: readonly string[];
  /** How long to wait for `init()` to return. Default 20 s. */
  readonly initTimeoutMs?: number;
  /** How long to listen for a sound after the inputs. Default 1500 ms. */
  readonly listenMs?: number;
  /** Called after each script, so a long run can be watched. */
  readonly onResult?: (row: ExerciseRow) => void;
  /**
   * Leave the last script loaded rather than clear it. The catalogue sweep
   * feeds a looper the audio input AFTER this has pressed its keys; cleared,
   * the input went into an empty page and every looper measured silent.
   */
  readonly keep?: boolean;
}

export interface ExerciseRow {
  readonly script: string;
  /** All six measurements agreed. */
  readonly ok: boolean;
  readonly engine: string | null;
  readonly loadMs: number;
  /** `init()` returned within the timeout. */
  readonly initDone: boolean;
  /** Lit pixels after the first redraw. Zero is a blank screen. */
  readonly pixels: number;
  /** Which inputs changed the screen. */
  readonly responds: string[];
  /** How many pixels each input changed, including the ones that changed none. */
  readonly deltas: Record<string, number>;
  /**
   * Peak while a MIDI note was held, or null when no keyboard is attached.
   *
   * Kept apart from `peak`, which is whatever the script did on its own.
   * An instrument that is silent until played is not a broken instrument,
   * and the two numbers are the difference between those two readings.
   */
  readonly notePeak: number | null;
  /** Lit pixels on the grid after the presses, or null if there is no grid. */
  readonly gridLit: number | null;
  /** Peak at the master meter, 0..1. */
  readonly peak: number;
  readonly errors: string[];
  /**
   * A Lua error raised by `norns.script.load` itself, kept apart from what
   * the script REPORTED. The two fail differently and the difference is the
   * first thing you want: a load that raised never ran the script at all.
   */
  readonly loadError: string | null;
}

export interface ExerciseReport {
  readonly when: string;
  readonly total: number;
  readonly ok: number;
  readonly rows: ExerciseRow[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every `<script>/<script>.lua`, which is what SELECT lists. */
export function scriptsIn(vfs: Vfs): string[] {
  const root = "/home/we/dust/code";
  const out: string[] = [];
  for (const dir of vfs.list(root)) {
    if (!dir.isDir) continue;
    for (const f of vfs.list(`${root}/${dir.name}`)) {
      if (!f.isDir && f.name.endsWith(".lua")) out.push(`${root}/${dir.name}/${f.name}`);
    }
  }
  return out.sort();
}

export async function exercise(
  ctx: ExerciseContext,
  opts: ExerciseOptions = {},
): Promise<ExerciseReport> {
  const log = ctx.log ?? ((): void => {});
  const initTimeout = opts.initTimeoutMs ?? 20_000;
  const listenMs = opts.listenMs ?? 1500;

  let paths = opts.only ? [...opts.only] : scriptsIn(ctx.vfs);
  if (opts.skip?.length) {
    paths = paths.filter((p) => !opts.skip!.some((s) => p.includes(s)));
  }

  // `_EX` is `rawset` into `_G`, and the raw matters.
  //
  // `Script.clear` (script.lua:43) puts a metatable on `_G` whose
  // `__newindex` sends every NEW global into a script-local table — that is
  // how norns gives each script a clean slate without a fresh Lua state. A
  // plain `_EX = {}` therefore lands in whatever script is running and
  // VANISHES the next time one is cleared, which is once per iteration of
  // this loop. Measured as a 20-second wait for an `init_done` that had
  // already happened, into a table nobody could read any more. `rawset`
  // bypasses the metatable and puts it in `_G` itself, where `__index` never
  // fires for it either, because it is no longer nil.
  ctx.host.run('rawset(_G, "_EX", rawget(_G, "_EX") or { errs = {}, done = false, ok = false })');

  const litPixels = (): number => {
    const g = ctx.screen.greyscale();
    let n = 0;
    for (const v of g) if (v > 0) n++;
    return n;
  };

  /**
   * Draw whatever is on the screen right now — and in play mode that is the
   * SCRIPT, not `_menu.redraw`.
   *
   * This read `_menu.redraw` for its whole life, and `_menu.redraw` is set
   * by `_menu.set_page` to the current MENU PAGE's redraw (menu.lua:196).
   * `set_mode(false)` does not repoint it; it points the GLOBAL `redraw` at
   * `norns.script.redraw` instead (menu.lua:164). So every "does it respond"
   * comparison in play mode redrew a deinitialised menu page, got the same
   * pixels back twice, and concluded that nothing had responded — for all
   * forty scripts, in every sweep, while the inputs themselves were arriving
   * perfectly well. Measured: `_norns.enc(1,1)` takes macro-b's `model` from
   * 1 to 4 and changes 238 pixels, and the sweep called it unresponsive.
   *
   * The column was not wrong, it was blank: a measurement that did not
   * happen is not a pass.
   */
  const redraw = (): void => {
    ctx.host.run(
      [
        "if _menu and _menu.mode == false then",
        "  if type(redraw) == 'function' then pcall(redraw) end",
        "elseif _menu and _menu.redraw then",
        "  pcall(_menu.redraw)",
        "end",
      ].join("\n"),
    );
  };

  const field = (name: string): string => readField(ctx.host, name);

  const rows: ExerciseRow[] = [];

  for (const path of paths) {
    const short = path.replace("/home/we/dust/code/", "");
    const errors: string[] = [];
    const t0 = performance.now();

    // Hooks go in BEFORE the load: `init_done` can fire inside it.
    ctx.host.run([
      "_EX.errs = {}",
      "_EX.done = false",
      "_EX.ok = false",
      "if not _EX.hooked then",
      "  _EX.hooked = true",
      "  local realInit = norns.init_done",
      "  norns.init_done = function(s)",
      "    _EX.done = true",
      "    _EX.ok = s and true or false",
      "    if realInit then realInit(s) end",
      "  end",
      "  local realErr = norns.scripterror",
      "  norns.scripterror = function(m)",
      "    _EX.errs[#_EX.errs + 1] = tostring(m)",
      "    if realErr then realErr(m) end",
      "  end",
      "end",
    ].join("\n"));

    // THROUGH THE MENU, as a person loads a script, and not only for
    // fidelity. `Script.init` ends in an unconditional `_norns.screen_save()`
    // and the matching `screen_restore` in `Script.run` only happens when the
    // menu is showing — so loading straight from play mode pushes one cairo
    // gstate per script and never pops it. Measured: after about twenty
    // loads, the deeper stack leaves cairo's tessellator too little wasm
    // stack, a `fill` over a self-intersecting arc overflows it, and the
    // module traps (E5-27). Going through the menu keeps the stack balanced,
    // which is why the hardware never sees this.
    ctx.host.run('if _menu and _menu.set_mode then pcall(_menu.set_mode, true) end');

    // Through `xpcall` with a traceback, not bare: when a load raises, the
    // message alone can be useless — the first long run of this produced an
    // error whose entire text was "15", and a bare error has no stack by the
    // time it reaches JS. The traceback is the difference between a bug
    // report and a shrug.
    ctx.host.run(
      [
        `local ok, err = xpcall(function() norns.script.load(${JSON.stringify(path)}) end,`,
        '  function(m) return tostring(m) .. "\\n" .. debug.traceback("", 2) end)',
        '_EX.loaderr = ok and "" or err',
      ].join("\n"),
    );
    const hostError = field("loaderr") || null;
    if (hostError) errors.push(`load raised: ${hostError.split("\n")[0]}`);

    // Wait for `init()`. The engine load is a round trip to sclang and back,
    // so this is the slow part and the one worth a generous budget.
    const deadline = performance.now() + initTimeout;
    while (field("done") !== "true" && performance.now() < deadline) await sleep(50);
    const initDone = field("done") === "true";
    const loadMs = Math.round(performance.now() - t0);
    ctx.host.run("_EX.engine = tostring(engine.name)");
    const engine = field("engine");

    // Back to play mode, which is where a script draws — and which pops the
    // gstate the menu pushed.
    ctx.host.run('if _menu and _menu.set_mode then pcall(_menu.set_mode, false) end');

    // 2. does it draw? GIVE IT A MOMENT FIRST.
    //
    // Not every script draws from a global `redraw`. `flora` has none: it
    // draws from a metro of its own, gated on the menu being down — so
    // asking for a redraw calls nothing, and the only honest way to find out
    // whether it draws is to let it run and look. Then, and only if the
    // screen is still empty, ask: a script that draws on demand deserves to
    // be asked.
    //
    // AND THEN WAIT AGAIN, which flora is the reason for. Its metro is
    // gated on `initializing`, and `initializing` is cleared at the end of
    // `init_done` — a coroutine `clock.run` starts at the END of `init`,
    // whose first statement is `clock.sleep(0.5)`. So flora draws nothing
    // for at least half a second AFTER `norns.init_done` has fired, and
    // 500 ms was sitting exactly on that boundary: it passed until the page
    // grew a third device and a console, and then it did not. A blank screen
    // is now given a second chance a full second later, which costs nothing
    // on the 36 scripts that have already drawn.
    await sleep(500);
    let pixels = litPixels();
    if (pixels === 0) {
      redraw();
      await sleep(150);
      redraw();
      pixels = litPixels();
    }
    if (pixels === 0) {
      await sleep(1000);
      pixels = litPixels();
      if (pixels === 0) {
        redraw();
        await sleep(150);
        redraw();
        pixels = litPixels();
      }
    }

    // 3. does it respond? Each input gets its own redraw and comparison,
    // and the COUNT of changed pixels is kept rather than a yes/no: one
    // pixel is a cursor moving and three hundred is a page turning, and the
    // difference says whether the script understood the input or merely
    // blinked.
    const responds: string[] = [];
    const deltas: Record<string, number> = {};
    const tryInput = async (name: string, act: () => Promise<void> | void): Promise<number> => {
      const before = ctx.screen.greyscale().slice();
      await act();
      await sleep(60);
      redraw();
      const after = ctx.screen.greyscale();
      let n = 0;
      for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) n++;
      deltas[name] = Math.max(deltas[name] ?? 0, n);
      if (n > 0 && !responds.includes(name)) responds.push(name);
      return n;
    };

    /**
     * A TURN, not a tick. Six detents, spaced like a hand.
     *
     * One tick was not a gesture, it was a twitch, and most scripts answer
     * it with nothing — truthfully. `params:delta(name, 1)` on a control
     * parameter moves by one QUANTUM of the range, not by one unit:
     * macro-b's `model` spans 48 values at 0.01, so a single detent moves it
     * 0.47 and the displayed integer does not change at all. Measured, with
     * the model read back: tick, tick → still 1; a turn of eight → 3. The
     * sweep was turning the knob a sixteenth of a notch and reporting that
     * the script did not respond.
     *
     * 40 ms apart, which is wider than every acceleration band in
     * `encoders.process_with_accel`: this should measure the script, not
     * norns' flick detection.
     */
    const turn = async (n: 1 | 2 | 3, dir: 1 | -1): Promise<void> => {
      for (let i = 0; i < 6; i++) {
        ctx.enc(n, dir);
        await sleep(40);
      }
    };

    await tryInput("K2", () => {
      ctx.key(2, 1);
      ctx.key(2, 0);
    });
    await tryInput("K3", () => {
      ctx.key(3, 1);
      ctx.key(3, 0);
    });
    // BOTH DIRECTIONS before an encoder is called dead. A parameter already
    // at its limit answers a turn with nothing, truthfully, and that is not
    // the same as a script that is not listening.
    for (const n of [1, 2, 3] as const) {
      if ((await tryInput(`E${n}`, () => turn(n, 1))) === 0) {
        await tryInput(`E${n}`, () => turn(n, -1));
      }
    }

    // K1 HELD, which is the only way a script ever sees key 1.
    //
    // `_norns.key` (menu.lua:129) gives K1 to the MENU: press and release
    // inside `KEY1_HOLD_TIME` — 0.25 s — and it toggles the menu instead,
    // which is also what a short tap does on hardware. Past that timer the
    // press is handed to the script, and that is norns' alt: `amen` uses it
    // to change mode, and until the sweep held it, amen was reported silent
    // because its start gesture lives on the other side of that door.
    // Measured: with K1 held and then K3, amen goes from 0 to a 0.861 peak.
    //
    // 400 ms, comfortably past the timer, or this would walk into the menu
    // and every measurement after it would be of the menu.
    await tryInput("K1", async () => {
      ctx.key(1, 1);
      await sleep(400);
      ctx.key(1, 0);
    });
    // And K2/K3 again, because what K1 opened is usually a different page.
    await tryInput("K2'", () => {
      ctx.key(2, 1);
      ctx.key(2, 0);
    });
    await tryInput("K3'", () => {
      ctx.key(3, 1);
      ctx.key(3, 0);
    });

    // 4. a grid press, in a few places. Many scripts put their playable keys
    // in the middle, so a single (1,1) proves less than it looks.
    let gridLit: number | null = null;
    const g0 = ctx.grid();
    if (g0) {
      // Measured on the SCREEN as well as on the grid. A press that lights
      // a pad and a press that opens a page are different answers, and
      // counting lamps alone cannot tell them apart.
      await tryInput("GRID", async () => {
        for (const [x, y] of [
          [1, 1],
          [4, 4],
          [8, 5],
        ] as const) {
          ctx.gridKey(x, y, 1);
          await sleep(40);
          ctx.gridKey(x, y, 0);
          await sleep(40);
        }
      });
      const g1 = ctx.grid();
      gridLit = g1 ? g1.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) : null;
    }

    // 5. did it make a sound? The peak is taken repeatedly because a script
    // that plays one note would be missed by a single 43 ms window.
    let peak = 0;
    const until = performance.now() + listenMs;
    while (performance.now() < until) {
      peak = Math.max(peak, ctx.peak() ?? 0);
      await sleep(30);
    }

    // 5b. and does it sound when PLAYED? Three notes, an octave apart,
    // held long enough for an attack and released long enough for a tail.
    // Without this the sweep reports "silent" about every synth in the set,
    // which is most of them: they are correct and they were never asked.
    // E9-228 — and a kick and a snare first: a drum machine plays the
    // General MIDI drum map (drum_room's 808 kit starts at note 35), and
    // three melodic notes ask it nothing.
    let notePeak: number | null = null;
    if (ctx.note && ctx.noteOff) {
      notePeak = 0;
      for (const n of [36, 38, 48, 60, 67]) {
        ctx.note(n, 100);
        const held = performance.now() + 450;
        while (performance.now() < held) {
          notePeak = Math.max(notePeak, ctx.peak() ?? 0);
          await sleep(25);
        }
        ctx.noteOff(n);
        // The release is often where the sound is: a plucked voice gated
        // off at its peak would read as silence if we stopped at note-off.
        const tail = performance.now() + 250;
        while (performance.now() < tail) {
          notePeak = Math.max(notePeak, ctx.peak() ?? 0);
          await sleep(25);
        }
      }
      notePeak = Number(notePeak.toFixed(5));
    }

    // 6. anything it reported on the way.
    ctx.host.run("_EX.report = table.concat(_EX.errs, ' | ')");
    const reported = field("report");
    if (reported) errors.push(...reported.split(" | ").filter(Boolean));

    const row: ExerciseRow = {
      script: short,
      // THE SCREEN OR THE GRID, because a script is allowed to live on
      // either. `nb` draws nothing at all and lights 76 grid keys: it is a
      // voice library with a grid demo attached, and calling it a failure
      // for having no screen would be marking it down for what it is.
      ok: initDone && errors.length === 0 && (pixels > 0 || (gridLit ?? 0) > 0),
      engine: engine && engine !== "nil" ? engine : null,
      loadMs,
      initDone,
      pixels,
      responds,
      deltas,
      gridLit,
      peak: Number(peak.toFixed(5)),
      notePeak,
      errors,
      loadError: hostError ?? null,
    };
    rows.push(row);
    opts.onResult?.(row);
    log(
      `${row.ok ? "ok  " : "FAIL"} ${short} — ${loadMs} ms, ${pixels} px, ` +
        `[${responds.join(" ")}], peak ${row.peak}` +
        `${notePeak === null ? "" : `, note ${notePeak}`}` +
        `${row.errors.length ? `, ${row.errors.length} error(s)` : ""}`,
    );
  }

  // Leave the page where it was found, not inside the last script.
  if (!opts.keep) {
    ctx.host.run("if norns.script and norns.script.clear then pcall(norns.script.clear) end");
    ctx.host.run("if _menu and _menu.set_mode then pcall(_menu.set_mode, true) end");
  }

  return {
    when: new Date().toISOString(),
    total: rows.length,
    ok: rows.filter((r) => r.ok).length,
    rows,
  };
}

/**
 * Read one field of `_EX` off the Lua stack.
 *
 * Not through a `print` and not through a new global: `Script.clear` puts a
 * metatable on `_G` that diverts new globals into the running script's own
 * table, so a probe written after a load is written somewhere else and reads
 * back nil. `_EX` is reached by its own reference and is not affected.
 */
function readField(host: Host, field: string): string {
  const L = host.L;
  lua.lua_getglobal(L, to_luastring("_EX"));
  if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
    lua.lua_pop(L, 1);
    return "";
  }
  lua.lua_getfield(L, -1, to_luastring(field));
  const t = lua.lua_type(L, -1);
  const v =
    t === lua.LUA_TSTRING
      ? lua.lua_tojsstring(L, -1)
      : t === lua.LUA_TBOOLEAN
        ? String(Boolean(lua.lua_toboolean(L, -1)))
        : t === lua.LUA_TNUMBER
          ? String(lua.lua_tonumber(L, -1))
          : "";
  lua.lua_pop(L, 2);
  return v;
}
