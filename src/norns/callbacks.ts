// E1-07 — the other direction: JS calling INTO Lua.
//
// Lua→C is 178 functions. C→Lua is 28 nested callbacks and 14 flat ones, and
// it is what makes norns move: `_norns.metro` is how every metro in norns
// fires, `_norns.key` and `_norns.enc` are the only way anything is played.
//
// Signatures here are read from the `lua_push*` sequences in `weaver.cc`'s
// `w_handle_*` functions (p1-api-plan §2.1, §2.2). Two things they encode that
// a casual port gets wrong:
//
//   1. **1-based indices.** Every `id`, `x`, `y`, `n`, `sensor`, `idx` and
//      `stage` is converted from 0-based C to 1-based Lua on the way through.
//      Sending a 0-based index produces an off-by-one that only shows up as a
//      grid light in the wrong row.
//   2. **`_norns.poll` has two arities and `_norns.vu` is not a table.**
//      `w_handle_poll_value` pushes 2, `w_handle_poll_data` pushes 3 under the
//      same name; `w_handle_poll_io_levels` pushes **twelve separate
//      integers**, not an array.

import { lua, to_luastring, pushValue, type LuaState, type LuaValue } from "../lua/lua.js";
import { timed } from "./call-cost.js";

/** A failure calling into Lua. Never thrown past the audio thread. */
export interface CallbackError {
  readonly path: string;
  readonly message: string;
}

/**
 * Call `_norns.<path>(...args)`, where `path` is `"key"` or `"grid.key"`.
 *
 * Returns null on success, or the Lua error. A callback that does not exist is
 * NOT an error: `lua/core` assigns most of them itself and matron fires some
 * before anything has claimed them — on hardware that is a no-op, and it must
 * be one here too.
 */
export function callNorns(L: LuaState, path: string, args: readonly LuaValue[]): CallbackError | null {
  const parts = path.split(".");
  lua.lua_getglobal(L, to_luastring("_norns"));
  if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
    lua.lua_pop(L, 1);
    return { path, message: "_norns is not a table" };
  }
  for (const part of parts) {
    lua.lua_getfield(L, -1, to_luastring(part));
    lua.lua_remove(L, -2);
    if (lua.lua_type(L, -1) === lua.LUA_TNIL) {
      lua.lua_pop(L, 1);
      return null; // unclaimed: a no-op, exactly as on hardware
    }
  }
  if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
    lua.lua_pop(L, 1);
    return null;
  }
  for (const a of args) pushValue(L, a);
  // E9-138 — timed by name. See `call-cost.ts`; two clock reads, always on.
  const status = timed(path, () => lua.lua_pcall(L, args.length, 0, 0));
  if (status !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    return { path, message };
  }
  return null;
}

/** Call a global, for the four matron calls that are not on `_norns`. */
export function callGlobal(L: LuaState, name: string, args: readonly LuaValue[] = []): CallbackError | null {
  lua.lua_getglobal(L, to_luastring(name));
  if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
    lua.lua_pop(L, 1);
    return null;
  }
  for (const a of args) pushValue(L, a);
  // Same instrument, and the name it reports is the global's — `redraw`
  // and `init` are where a script's own cost actually lands.
  const status = timed(name, () => lua.lua_pcall(L, args.length, 0, 0));
  if (status !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    return { path: name, message };
  }
  return null;
}

/**
 * Typed senders. Each one converts to 1-based where `weaver.cc` does.
 *
 * Arguments are named for what they are rather than positionally, because the
 * only defence against an off-by-one in a list of five integers is that the
 * conversion happens in one place and is read once.
 */
export function makeCallbacks(L: LuaState) {
  const call = (path: string, ...args: LuaValue[]) => callNorns(L, path, args);

  return {
    // ---- flat (§2.2) ---------------------------------------------------
    /** Every metro in norns fires through this. Both arguments 1-based. */
    metro: (idx0: number, stage0: number) => call("metro", idx0 + 1, stage0 + 1),
    /** n is already 1..3 on the wire; z is 0 or 1. */
    key: (n: number, z: number) => call("key", n, z),
    enc: (n: number, delta: number) => call("enc", n, delta),
    battery: (percent: number, current: number) => call("battery", percent, current),
    /** Missing from boot-contract.md; present in matron as `w_handle_power`. */
    power: (present: number) => call("power", present),
    stat: (disk: number, temp: number, cpu: number, c1: number, c2: number, c3: number, c4: number) =>
      call("stat", disk, temp, cpu, c1, c2, c3, c4),
    /** 2-arity form, `w_handle_poll_value`. */
    pollValue: (idx0: number, value: number) => call("poll", idx0 + 1, value),
    /** 3-arity form of the SAME name, `w_handle_poll_data`. */
    pollData: (idx0: number, data: LuaValue, size: number) => call("poll", idx0 + 1, data, size),
    /** Twelve separate integers, NOT a table. `w_handle_poll_io_levels`. */
    vu: (levels: readonly number[]) => {
      if (levels.length !== 12) {
        return { path: "vu", message: `expected 12 levels, got ${levels.length}` };
      }
      return call("vu", ...levels);
    },
    softcutPhase: (idx0: number, val: number) => call("softcut_phase", idx0 + 1, val),
    softcutPosition: (idx0: number, pos: number) => call("softcut_position", idx0 + 1, pos),
    softcutRender: (idx0: number, start: number, secPerSample: number, samples: readonly number[]) =>
      call("softcut_render", idx0 + 1, start, secPerSample, samples as LuaValue),
    tapeStatus: (ps: number, pp: number, pl: number, rs: number, rp: number, loop: number) =>
      call("tape_status", ps, pp, pl, rs, rp, loop),
    /**
     * `null` becomes Lua `nil`, and that is upstream's behaviour, not a
     * convenience: `w_handle_tape_play_file` pushes nil when the path is
     * NULL, and crone's close notification carries no path at all —
     * `o_poll_callback_tape_file` sets it to NULL with a comment saying so.
     * Sending "" instead would have `core/tape.lua` treat a close as an open
     * of a file called nothing.
     */
    tapePlayFile: (path: string | null) => call("tape_play_file", path),
    tapeRecFile: (path: string | null) => call("tape_rec_file", path),

    // ---- nested (§2.1) -------------------------------------------------
    // matron only ever calls monome.*; `startup.lua:68-73` dispatches to
    // arc.add or grid.add in LUA, on the device name. Calling grid.add
    // directly from here would bypass that and is why E5-13 exists.
    monomeAdd: (id0: number, serial: string, name: string, dev: LuaValue) =>
      call("monome.add", id0 + 1, serial, name, dev),
    monomeRemove: (id0: number) => call("monome.remove", id0 + 1),
    gridKey: (id0: number, x0: number, y0: number, state: number) =>
      call("grid.key", id0 + 1, x0 + 1, y0 + 1, state),
    gridTilt: (id0: number, sensor0: number, x0: number, y0: number, z0: number) =>
      call("grid.tilt", id0 + 1, sensor0 + 1, x0 + 1, y0 + 1, z0 + 1),
    arcDelta: (id0: number, n0: number, delta: number) => call("arc.delta", id0 + 1, n0 + 1, delta),
    arcKey: (id0: number, n0: number, state: number) => call("arc.key", id0 + 1, n0 + 1, state),
    midiAdd: (id0: number, name: string, dev: LuaValue) => call("midi.add", id0 + 1, name, dev),
    midiRemove: (id0: number) => call("midi.remove", id0 + 1),
    midiEvent: (id0: number, bytes: readonly number[]) => call("midi.event", id0 + 1, bytes as LuaValue),
    hidAdd: (id0: number, name: string, types: LuaValue, codes: LuaValue, dev: LuaValue, guid: string) =>
      call("hid.add", id0 + 1, name, types, codes, dev, guid),
    hidRemove: (id0: number) => call("hid.remove", id0 + 1),
    hidEvent: (id0: number, type: number, code: number, value: number) =>
      call("hid.event", id0 + 1, type, code, value),
    oscEvent: (path: string, args: LuaValue, from: LuaValue) => call("osc.event", path, args, from),
    clockStart: () => call("clock.start"),
    clockStop: () => call("clock.stop"),
    // All three reports take (data, COUNT). `p1-api-plan` §2.1 listed only the
    // table, and the missing second argument surfaced as
    // `core/engine.lua:32: attempt to concatenate a nil value (local 'count')`
    // — a message that names neither the callback nor the missing argument.
    reportEngines: (names: readonly string[]) =>
      call("report.engines", names as LuaValue, names.length),
    /** Each entry is a two-element table: `{ name, format }`. */
    reportCommands: (commands: ReadonlyArray<{ name: string; format: string }>) =>
      call(
        "report.commands",
        commands.map((c) => [c.name, c.format]) as LuaValue,
        commands.length,
      ),
    /**
     * Each entry is `{ id, name }` — NOT `{ name, type }`.
     * `core/poll.lua:107-118` reads `data[i][1]` as the id and `data[i][2]`
     * as the name, and keys `Poll.poll_names` by the id. Sending the name
     * first would register every poll under a number.
     */
    reportPolls: (polls: ReadonlyArray<{ id: number; name: string }>) =>
      call("report.polls", polls.map((p) => [p.id, p.name]) as LuaValue, polls.length),
    didEngineLoad: () => call("report.did_engine_load"),
    /** The real boot gate — see E4-04. Until it fires norns is not running. */
    startupOk: () => call("startup_status.ok"),
    startupTimeout: () => call("startup_status.timeout"),

    // ---- globals -------------------------------------------------------
    /** `clock.resume` is a field on the GLOBAL clock table, not on _norns. */
    clockResume: (coroId: number, value: LuaValue) => {
      lua.lua_getglobal(L, to_luastring("clock"));
      if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
        lua.lua_pop(L, 1);
        return null;
      }
      lua.lua_getfield(L, -1, to_luastring("resume"));
      lua.lua_remove(L, -2);
      if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
        lua.lua_pop(L, 1);
        return null;
      }
      pushValue(L, coroId);
      pushValue(L, value);
      // E9-200 — TIMED, like the other two ways into Lua. `call-cost.ts`
      // says every callback goes through two `lua_pcall`s; this is the
      // third, and it is where a sequencer does its work. A level of
      // `_cpu` that resumed 366 coroutines reported no path for them.
      const status = timed("clock.resume", () => lua.lua_pcall(L, 2, 0, 0));
      if (status !== lua.LUA_OK) {
        const message = lua.lua_tojsstring(L, -1);
        lua.lua_pop(L, 1);
        return { path: "clock.resume", message };
      }
      return null;
    },
    refresh: () => callGlobal(L, "refresh"),
  };
}

export type Callbacks = ReturnType<typeof makeCallbacks>;
