// E6-03 / E6-05 / E6-06 — the four `_norns` functions that reach the filesystem.
//
// `system_glob`, `execute`, `system_cmd` and `sound_file_inspect`. Three of
// them are the "almost all of the browser-impossibility" group of
// p1-api-plan §1.1, and the honesty is in the detail of what they return.

import type { NornsRegistry } from "../norns/registry.js";
import { lua, lauxlib, pushValue, type LuaValue } from "../lua/lua.js";
import { Vfs, normalise } from "./vfs.js";
import { runShell, globToRegExp } from "./shell.js";
import { parseWavHeader } from "./wav-header.js";

export interface FsOptions {
  /**
   * How long before a `system_cmd` callback runs. Upstream forks a process
   * and answers when it exits, so the callback is never synchronous — and
   * norns' SELECT menu sets `m.len = "scan"` first and relies on redrawing
   * when the answer arrives. Zero would still be a different turn, but a
   * small delay keeps the asynchrony visible rather than accidental.
   */
  readonly cmdDelayMs?: number;
  /** Called when a refused command is reached, for the compatibility page. */
  readonly onRefused?: (command: string, reason: string) => void;
  /**
   * E9-69 — a `git clone`, `wget -O` or `curl -o` for the host to run.
   *
   * THE SAME HOOK THE OTHER DOOR HAS HAD SINCE E9-37, and this one did not.
   * `runShell` recognises a download and hands it up; `lua-io.ts` started
   * it and these two implementations dropped it on the floor, so a command
   * that arrived through `_norns.execute` or `_norns.system_cmd` was
   * reported as "it will be in place next run" and then never was.
   *
   * Which is not a narrow door: `util.os_capture` is `_norns.execute`, and
   * that is what norns' own Lua gives a script to shell out with. Measured
   * on `folio`, whose DOWNLOAD button is
   * `run_cmdline('git clone '..project_url..' '..script_dir)` — the log
   * said the fetch had started, no request was ever made, and the files
   * were not there on the next run either.
   */
  readonly onFetch?: (fetch: { kind: "repo" | "file"; url: string; dest: string }) => void;
  /** Called after a command that may have changed the tree. */
  readonly onChanged?: () => void;
  /**
   * `system_action` reached: the name, and what happened to it.
   *
   * Separate from `onRefused`, which is about shell commands — a restart is
   * not a refused command and reading as one would be confusing.
   */
  readonly onSystemAction?: (action: string, outcome: string) => void;
  /**
   * What RESTART does. Defaults to reloading the page.
   *
   * Injectable because a test must not reload the runner, and because a
   * host that embeds norns in a frame may want to restart only the frame.
   */
  readonly reload?: () => void;
}

/**
 * A glob across path COMPONENTS, not only the last one.
 *
 * `core/mods.lua:13` searches for `<star>/lib/mod.lua` — written that way
 * here because the real pattern would close this comment — with the star in
 * the MIDDLE. This used to split the pattern into a directory and a basename
 * and match only the basename — so that search asked for a file called
 * `mod.lua` inside a directory literally named `*`, found nothing, and
 * returned GLOB_NOMATCH.
 *
 * What that cost: SYSTEM > MODS was empty for ever. The dust tree here ships
 * two mods — `passthrough` and `midigrid` — and norns could see neither, so
 * `passthrough`'s own two example scripts drew a blank screen (their `init`
 * is wrapped in `if mod_running`) and read as broken scripts rather than as
 * a mod that was never offered.
 *
 * Walks one component at a time: a non-final component must be a directory,
 * the final one may be either, which is what a shell's glob does.
 */
function globPaths(vfs: Vfs, pattern: string): string[] {
  const parts = pattern.split("/").filter((s) => s.length > 0);
  let here: string[] = [""];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    const next: string[] = [];
    if (/[*?]/.test(part)) {
      const re = globToRegExp(part);
      for (const base of here) {
        for (const e of vfs.list(base === "" ? "/" : base)) {
          if (!re.test(e.name)) continue;
          if (!last && !e.isDir) continue;
          next.push(`${base}/${e.name}`);
        }
      }
    } else {
      for (const base of here) {
        const p = `${base}/${part}`;
        if (last ? vfs.exists(p) || vfs.isDir(p) : vfs.isDir(p)) next.push(p);
      }
    }
    here = next;
    if (here.length === 0) break;
  }
  return here.sort();
}

export function registerFs(registry: NornsRegistry, vfs: Vfs, opts: FsOptions = {}): void {
  const delay = opts.cmdDelayMs ?? 0;

  registry.implement("system_glob", (pattern) => {
    // A TABLE on success, `(nil, glob_status)` on failure — and GLOB_NOMATCH
    // is 3, a FAILURE. An empty directory is `(nil, 3)` and not `{}`:
    // core/mods.lua:24 indexes the result, so handing back an empty table
    // where upstream hands back nil changes what the caller does.
    const p = normalise(String(pattern ?? ""), vfs.home);
    const hits = globPaths(vfs, p).map((h) => h as LuaValue);
    return hits.length ? [hits] : [null, 3];
  });

  registry.implement("execute", (command) => {
    // A STRING, possibly empty, never nil: `util.scandir` calls `:gmatch` on
    // the result immediately (lib/util.lua:27). A refused command returns ""
    // for the same reason a failed shell command would.
    const cmd = String(command ?? "");
    const r = runShell(vfs, cmd);
    if (r.fetch !== undefined) opts.onFetch?.(r.fetch);
    if (!r.ok) opts.onRefused?.(cmd, r.refused ?? "unsupported");
    else opts.onChanged?.();
    return [r.out];
  });

  // `system_action(name, callback)` — three names: "reset", "shutdown" and
  // "update". The stub returned false for all three, and THAT IS WHY RESTART
  // DID NOTHING: `norns.lua:244` discards the return value, so a false went
  // nowhere. The menu set `confirmed`, drew "restarting.", cleared the
  // script, muted the DAC, saved the state — and then stopped, on a dead
  // screen with no sound and no message.
  //
  // `reset` has an exact meaning here. On hardware it relaunches matron and
  // sclang as one detached command; in a browser the page IS matron, sclang,
  // crone and the clock, so reloading it restarts all four. The state was
  // saved by `_norns.restart` immediately before, so the reload comes back
  // into the same script.
  //
  // The other two do not have one, and pretending otherwise would be worse
  // than refusing:
  //   shutdown — a tab cannot close itself. `window.close()` only works on
  //              a window that a script opened.
  //   update   — updating norns-js is a deploy, not something the running
  //              copy can do to itself.
  // Both return false, as upstream does for an unknown action. The
  // difference is that the reason is said out loud, because the caller
  // discards the return value and nothing else would.
  const reload = opts.reload ?? (() => globalThis.location?.reload());
  registry.implementRaw("system_action", (S) => {
    const L = S as never;
    const action = lua.lua_tojsstring(L, 1) ?? "";

    // No `luaL_ref` in any branch, on purpose: the callback is never
    // invoked here. On a reset the page is replaced; on the other two the
    // answer is false, and upstream frees the ref for exactly that case.
    if (action === "reset") {
      opts.onSystemAction?.("reset", "restarting: reloading the page");
      // A task, not now: the menu has just drawn "restarting." and the
      // screen has to reach the canvas before the document goes away.
      setTimeout(reload, 50);
      lua.lua_pushboolean(L, true);
      return 1;
    }

    const why =
      action === "shutdown"
        ? "a browser tab cannot close itself; close it yourself"
        : action === "update"
          ? "updating norns-js is a deploy, not something the page can do"
          : `unknown system action "${action}"`;
    opts.onSystemAction?.(action, why);
    lua.lua_pushboolean(L, false);
    return 1;
  });

  // `system_cmd(cmd, callback)` is one of the two functions in the 178 that
  // take a LUA FUNCTION and hold it (p1-api-plan §4.4), so it works the stack
  // directly. `luaL_ref` is not optional: a closure that nothing on the stack
  // refers to is collectable, and norns' callback would vanish between the
  // call and the answer.
  registry.implementRaw("system_cmd", (S) => {
    const L = S as never;
    const cmd = lua.lua_tojsstring(L, 1) ?? "";

    // Hold the callback before anything else can disturb the stack.
    lua.lua_pushvalue(L, 2);
    const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);

    const r = runShell(vfs, cmd);
    if (!r.ok) {
      // false means "no event will fire", so the callback is correctly never
      // invoked — which is exactly what upstream does for a command that
      // could not be started. Release the reference now rather than leaking
      // one per refused command.
      lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref);
      if (r.fetch !== undefined) opts.onFetch?.(r.fetch);
      opts.onRefused?.(cmd, r.refused ?? "unsupported");
      lua.lua_pushboolean(L, false);
      return 1;
    }
    opts.onChanged?.();

    // Never synchronous. Upstream forks a process and answers when it exits,
    // and SELECT sets `m.len = "scan"` before the call and redraws when the
    // answer arrives — delivering inline would run the callback before the
    // caller had finished setting itself up.
    setTimeout(() => {
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
      pushValue(L, r.out);
      const status = lua.lua_pcall(L, 1, 0, 0);
      if (status !== lua.LUA_OK) {
        opts.onRefused?.(cmd, `callback failed: ${lua.lua_tojsstring(L, -1)}`);
        lua.lua_pop(L, 1);
      }
      lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref);
      opts.onChanged?.();
    }, delay);

    lua.lua_pushboolean(L, true);
    return 1;
  });

  registry.implement("sound_file_inspect", (path) => {
    // Three integers: channels, frames, samplerate. A WAV header is 44 bytes
    // and entirely readable; anything else reports zeros, which is what
    // upstream does for a file libsndfile cannot open.
    const p = String(path ?? "");
    // The manifest first: a sound file a script ships is declared before it
    // is fetched, and its header was read at build time. Reading the bytes
    // to find three numbers would mean fetching the whole file — and
    // `io.open` is synchronous, so there is nowhere to wait.
    const ref = vfs.remoteAt(p);
    if (ref?.audio) return [ref.audio.channels, ref.audio.frames, ref.audio.sampleRate];
    const data = vfs.read(p);
    const wav = data && parseWavHeader(data);
    return wav ? [wav.channels, wav.frames, wav.sampleRate] : [0, 0, 0];
  });

}

