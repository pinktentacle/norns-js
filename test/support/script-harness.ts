// E5-18 — load a real community script in Node, and say honestly what happened.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. It runs the script's Lua: the
// chunk itself, its `require`s, and `init()`. It does NOT make a sound --
// there is no scsynth here -- so a green row means "the Lua is satisfied",
// not "the script works". The browser is where the second half lives.
//
// It is still the measurement worth having first, because that is where the
// failures are: a script reaches `_norns` through `lua/core`, and anything
// missing there shows up as a Lua error with a file and a line, in a second,
// for all 35 at once.
//
// `Engine.load` takes the empty-names branch (`#Engine.names == 0`), which is
// upstream's "server has not reported yet, allow anything" path. That is the
// honest shape for a host with no engines rather than a lie about having
// them: the script's own init still runs, and an engine command it sends is a
// `_norns.send_command` stub.

import { createHost, boot, type Host } from "../../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../../src/lua/host-node.js";
import { loadDustNode } from "../../src/fs/dust-node.js";
import { registerFs } from "../../src/fs/register.js";
import { registerGrid } from "../../src/grid/register.js";
import { MidiManager } from "../../src/midi/manager.js";
import { GridManager } from "../../src/grid/manager.js";
import { makeCallbacks } from "../../src/norns/callbacks.js";
import { Vfs } from "../../src/fs/vfs.js";
import { lua, to_luastring } from "../../src/lua/lua.js";

export interface ScriptRun {
  readonly path: string;
  /** Everything the script printed, including norns' own tracebacks. */
  readonly log: string;
  /** `norns.scripterror` messages, which is how norns reports a failed init. */
  readonly errors: string[];
  /** A host-level Lua error, if `dofile` itself could not run. */
  readonly hostError: string | null;
  /** True once `Script.init` has returned without error. */
  readonly initDone: boolean;
  /** What the script asked for, so a missing engine can be named. */
  readonly engine: string | null;
}

/**
 * Read a field of the `_SWEEP` table.
 *
 * NOT a global. `Script.clear` puts a metatable on `_G` whose `__newindex`
 * diverts every NEW global into a script-local `state` table -- that is how
 * norns gives each script a clean slate without a fresh Lua state -- so a
 * probe that assigns a global after the load writes into the script's
 * private world and reads back nil. A table created BEFORE the load is
 * reached by its own reference and is not affected.
 */
function sweepField(h: Host, field: string): string {
  lua.lua_getglobal(h.L, to_luastring("_SWEEP"));
  lua.lua_getfield(h.L, -1, to_luastring(field));
  const t = lua.lua_type(h.L, -1);
  const v =
    t === lua.LUA_TSTRING
      ? lua.lua_tojsstring(h.L, -1)
      : t === lua.LUA_TBOOLEAN
        ? String(Boolean(lua.lua_toboolean(h.L, -1)))
        : "";
  lua.lua_pop(h.L, 2);
  return v;
}

/** A booted norns with a dust tree and one grid attached. */
export function bootedHost(vfs: Vfs = loadDustNode()): { host: Host; vfs: Vfs } {
  const host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const cb = makeCallbacks(host.L);
  const manager = new GridManager({
    monomeAdd: (id, serial, name, handle) => void cb.monomeAdd(id, serial, name, handle as never),
    monomeRemove: (id) => void cb.monomeRemove(id),
    gridKey: (id, x, y, s) => void cb.gridKey(id, x, y, s),
    gridTilt: (id, s, x, y, z) => void cb.gridTilt(id, s, x, y, z),
  });
  registerGrid(host.registry, manager);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
  // A grid, because most of these scripts are unplayable without one and
  // several index `g.cols` at init.
  manager.add({ serial: "v0001", name: "virtual grid", cols: 16, rows: 8, varibright: true });
  // E9-74 — AND A MIDI DEVICE, for the same reason and with one script to
  // show for it.
  //
  // `cheat_codes_2` has been the single red in this file for a long time,
  // on its own line: `ping_midi_devices` walks `midi.devices` for the
  // highest id and then `for i = 1, midi_dev_max`. `Midi.devices` is empty
  // until something is added (core/midi.lua:14), so the limit is nil and
  // `init` dies on "'for' limit must be a number" — on a norns with
  // nothing plugged in, exactly the same.
  //
  // The page has a virtual MIDI keyboard that attaches on a click, and
  // with it attached cheat_codes_2 runs: 430 pixels, 89 grid keys lit,
  // peak 0.014. So the honest harness is one with a device attached, the
  // same judgement the grid above was given, and the two measurements
  // agree again.
  const midi = new MidiManager({
    midiAdd: (id, name, dev) => void cb.midiAdd(id, name, dev as never),
    midiRemove: (id) => void cb.midiRemove(id),
    midiEvent: (id, bytes) => void cb.midiEvent(id, bytes),
  });
  midi.add({
    descriptor: { id: "v-midi-1", name: "virtual midi keyboard" },
    send: () => {},
  });
  return { host, vfs };
}

/** Load one script the way SELECT does, and report what happened. */
export function runScript(host: Host, path: string): ScriptRun {
  // Everything the probe needs lives in ONE table, made before the load.
  const setup = host.run([
    "_SWEEP = { log = {}, errs = {}, init = false }",
    "local S = _SWEEP",
    "print = function(...)",
    "  local n = select('#', ...)",
    "  local t = {}",
    "  for i = 1, n do t[i] = tostring((select(i, ...))) end",
    "  S.log[#S.log + 1] = table.concat(t, '\\t')",
    "end",
    "norns.scripterror = function(msg)",
    "  S.errs[#S.errs + 1] = tostring(msg)",
    "  print(msg)",
    "end",
    "norns.init_done = function(status) S.init = status and true or false end",
    // E9-42 — AN ENGINE COMMAND IS NOT A LUA FAILURE, and for a long time
    // this measured it as one. `Engine.load` takes upstream's "server has
    // not reported yet, allow anything" branch here, so the script loads —
    // but `Engine.__index` resolves a command out of `Engine.commands`,
    // which only `register_commands` fills, and only an OSC reply fills
    // that. So `engine.oscWaveShape(…)` from a param's `action` was nil,
    // and TWENTY-ONE of forty scripts went red on their first parameter
    // bang. Measured in the browser with a real server: twenty of those
    // twenty-one load and init with no error at all.
    //
    // The global is a read-only proxy (`tab.readonly`), so it is wrapped
    // rather than patched. A name Engine owns must still answer with
    // Engine's value — `engine.is_loading` is read at the top of
    // `Engine.load`, and a stub function there is TRUTHY, which made the
    // loader return false and no script ran at all.
    //
    // What this cannot tell you, and the browser sweep can: whether the
    // command exists on the real engine. The stub answers to anything.
    "S.cmds = {}",
    "local OWN = { is_loading=true, name=true, names=true, commands=true,",
    "  load=true, add_command=true, register_commands=true, list_commands=true }",
    "local real = engine",
    "engine = setmetatable({}, {",
    "  __index = function(_, k)",
    "    local v = real[k]",
    "    if v ~= nil or OWN[k] then return v end",
    "    return function(...) S.cmds[#S.cmds + 1] = tostring(k) end",
    "  end,",
    "  __newindex = function(_, k, v) real[k] = v end,",
    "})",
    // The same hole one layer along, and it cost nine more rows: a POLL is
    // registered from the server's reply too, so `poll.set('phase_1')`
    // returned nil and the next line indexed it. `glut`, `mangl`,
    // `passersby`, `reels`, `takt`, `otis` and `pedalboard` all died that
    // way, and all seven init cleanly in the browser.
    //
    // A real `Poll` object is handed back rather than a table that looks
    // like one, so `:start()`, `.time` and `.callback` behave as the script
    // expects. Nothing is behind it: the four `_norns` entry points a poll
    // calls belong to the engine binding, which this host does not load.
    "S.polls = {}",
    "if poll and poll.polls then",
    "  setmetatable(poll.polls, { __index = function(t, k)",
    "    local p = poll.new({ id = 0, name = tostring(k) })",
    "    rawset(t, k, p)",
    "    S.polls[#S.polls + 1] = tostring(k)",
    "    return p",
    "  end })",
    "end",
    "for _, f in ipairs({'start_poll','stop_poll','request_poll_value','set_poll_time'}) do",
    "  if _norns[f] == nil then _norns[f] = function() end end",
    "end",
    // And one more, for one script. `_menu.redraw` is not a field of the
    // menu: `_menu.set_page` assigns the CURRENT PAGE's redraw to it
    // (menu.lua:72), so on a host that never entered a menu page it is
    // nil — and `amen` asks the menu to repaint from a param action. A
    // repaint returns nothing and nobody reads it, so a no-op cannot hide
    // a failure; a missing screen is not a broken script.
    "if _menu and _menu.redraw == nil then _menu.redraw = function() end end",
  ].join("\n"));
  if (setup !== null) throw new Error(`sweep setup failed: ${setup}`);

  const hostError = host.run(`norns.script.load(${JSON.stringify(path)})`);
  // `Script.run` hands `Script.init` to the engine load and waits for the
  // server to answer. Nothing answers here, so the host plays the part
  // matron's OSC handler plays on hardware.
  host.run([
    "_SWEEP.engine = tostring(engine.name)",
    "if _norns.report.did_engine_load then _norns.report.did_engine_load() end",
    "_SWEEP.out = table.concat(_SWEEP.log, '\\n')",
    "_SWEEP.e = table.concat(_SWEEP.errs, '\\n')",
  ].join("\n"));

  const log = sweepField(host, "out");
  const e = sweepField(host, "e");
  const engine = sweepField(host, "engine");
  return {
    path,
    log,
    errors: e ? e.split("\n") : [],
    hostError,
    initDone: sweepField(host, "init") === "true",
    engine: engine === "nil" || engine === "" ? null : engine,
  };
}
