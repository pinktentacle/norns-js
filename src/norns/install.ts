// E1-03 / E1-04 / E1-05 — build the `_norns` table in a Lua state.
//
// All 178 functions exist from the first instant, because norns checks for
// none of them: `lua/core` calls `_norns.screen_move(...)` directly, and a
// missing field is "attempt to call a nil value" at an arbitrary depth rather
// than a clear message. Existing-but-honest beats absent.
//
// E1-05: `_norns` is a PLAIN WRITABLE LUA TABLE. Not a userdata, not a proxy
// with a throwing __newindex, not frozen. `lua/core/screen.lua:375-395` adds
// three Lua polyfills to it (`screen_text_rotate`, `screen_text_center_rotate`,
// `screen_circle`) and `startup.lua` assigns `tape_status`, `tape_play_file`,
// `tape_rec_file`, `monome.add` and `monome.remove`. Any read-only
// representation breaks boot, invisibly and late.

import surface from "../api/surface.json" with { type: "json" };
import { stubFor, stubReturns, IMAGE_METHODS } from "../api/stubs.js";
import { NornsRegistry } from "./registry.js";
import {
  lua,
  to_luastring,
  pushReturns,
  readArgs,
  type LuaState,
  type LuaValue,
} from "../lua/lua.js";

export interface SurfaceEntry {
  name: string;
  symbol: string;
  line: number;
  via: string;
  /** Return counts seen in the C. `[0]` means it pushes nothing. */
  returns: number[];
  aliasOf?: string;
}

export const SURFACE: SurfaceEntry[] = surface.functions as SurfaceEntry[];

/** The 14 nested callback namespaces (`p1-api-plan` §2.1). */
export const CALLBACK_FIELDS = [
  "monome",
  "grid",
  "arc",
  "hid",
  "midi",
  "crow",
  "serial",
  "osc",
  "clock",
  "report",
  "startup_status",
] as const;

export interface InstallResult {
  readonly registry: NornsRegistry;
  /** Names installed, for assertions. */
  readonly installed: readonly string[];
}

/**
 * Create `_norns` as a global in `L`, with every one of the 178 functions.
 *
 * Dispatch per call:
 *   1. note the call;
 *   2. if a subsystem has registered an implementation, use it;
 *   3. otherwise record a loud stub and push the stub's values —
 *      which for 149 of the 178 is nothing at all.
 */
/**
 * E9-176 — THE ONE FUNCTION THIS PORT HAS THAT A NORNS DOES NOT.
 *
 * `surface.json` is derived from norns' C and must stay derived: it is
 * what makes "178 functions" a count rather than an opinion, and
 * hand-editing it would quietly turn the coverage test into a tautology.
 *
 * So anything this port adds is listed HERE instead, where it is
 * obviously an addition. There is one, and it exists because a page can
 * be asked what it has been spending and a norns cannot:
 * `src/lua/norns-js/bench.lua` calls it between its phases so each one
 * gets its own reading instead of all seven sharing a total. A script
 * that calls it on hardware finds nothing there and carries on, which
 * `bench.lua` checks for.
 */
export const EXTRAS: SurfaceEntry[] = [
  { name: "profile_mark", symbol: "(norns-js)", line: 0, via: "norns-js", returns: [0] },
  // E9-200 — and a second, for the same script and the same reason: a
  // probe that has to ask the PAGE to do something a script cannot, such
  // as time the SuperCollider interpreter from outside it. Named by a
  // string so that the next probe is not a third entry here.
  { name: "profile_probe", symbol: "(norns-js)", line: 0, via: "norns-js", returns: [0] },
];

export function installNorns(L: LuaState, registry = new NornsRegistry()): InstallResult {
  lua.lua_createtable(L, 0, SURFACE.length + EXTRAS.length + CALLBACK_FIELDS.length);

  const installed: string[] = [];
  for (const entry of [...SURFACE, ...EXTRAS]) {
    const { name } = entry;
    const spec = stubFor(name);

    const answer = (S: LuaState): number => {
      // A raw implementation works the stack itself, which is the only way to
      // receive a Lua function and keep it (see RawImplementation).
      const raw = registry.rawImplementationFor(name);
      if (raw) return raw(S);
      const impl = registry.implementationFor(name);
      if (impl) {
        const args = readArgs(S);
        const out = impl(...args) ?? [];
        return pushReturns(S, out);
      }
      registry.noteStub(name, readArgs(S));
      return pushReturns(S, stubReturns(spec));
    };
    const slot = registry.slotFor(name);

    lua.lua_pushcfunction(L, (S: LuaState) => {
      registry.noteCall(name);
      // E9-200 — one call in eight is timed, and only under `?profile`.
      // See `NornsRegistry.timing`.
      // The FIRST of every eight, not the last: a function called three
      // times in a phase would otherwise never be timed at all, and a cost
      // nobody measured prints as a cost of nothing.
      if (registry.timing && (++slot.calls & 7) === 1) {
        const t0 = performance.now();
        try {
          return answer(S);
        } finally {
          const took = performance.now() - t0;
          slot.timed++;
          slot.ms += took;
          if (took > slot.max) slot.max = took;
        }
      }
      return answer(S);
    });
    lua.lua_setfield(L, -2, to_luastring(name));
    installed.push(name);
  }

  // The nested namespaces matron calls into. They are created EMPTY on
  // purpose: `lua/core/*.lua` assigns the handlers itself (`arc.lua:203`
  // does `_norns.arc = {}` then fills it), and matron only ever calls what
  // Lua put there. Creating them here means an early matron-side call finds a
  // table rather than nil; filling them would overwrite norns' own handlers.
  for (const field of CALLBACK_FIELDS) {
    lua.lua_createtable(L, 0, 8);
    lua.lua_setfield(L, -2, to_luastring(field));
  }

  lua.lua_setglobal(L, to_luastring("_norns"));
  return { registry, installed };
}

/**
 * Build the image object the two image functions must return (§4.3).
 *
 * Kept here rather than in stubs.ts because it needs to push Lua functions,
 * which needs a state. `Screen.draw_to` calls `_context_focus` /
 * `_context_defocus`; `Screen.display_image` calls `extents`.
 */
export function pushImageObject(
  L: LuaState,
  impl: Partial<Record<(typeof IMAGE_METHODS)[number], (S: LuaState) => number>> = {},
): void {
  lua.lua_createtable(L, 0, IMAGE_METHODS.length);
  for (const method of IMAGE_METHODS) {
    const fn = impl[method];
    lua.lua_pushcfunction(L, fn ?? (() => 0));
    lua.lua_setfield(L, -2, to_luastring(method));
  }
}

/**
 * Cross-check the stub table against the C.
 *
 * A stub that pushes the wrong NUMBER of values is the failure this catches:
 * `local w, h = screen_text_extents(s)` with a one-value stub leaves `h` nil,
 * and the arithmetic that follows fails somewhere else entirely.
 *
 * Returns a list of problems; empty means consistent.
 */
export function checkStubArity(): string[] {
  const problems: string[] = [];
  for (const entry of SURFACE) {
    const spec = stubFor(entry.name);
    const n = stubReturns(spec).length;
    const cContract = entry.returns;

    if (cContract.length === 1 && cContract[0] === 0) {
      if (n !== 0) {
        problems.push(`${entry.name}: C pushes nothing, stub pushes ${n}`);
      }
      continue;
    }
    // Conditional arity in the C: the stub must pick one of the valid shapes.
    if (!cContract.includes(n)) {
      problems.push(
        `${entry.name}: C returns one of {${cContract.join(",")}}, stub pushes ${n}` +
          (n === 0 ? " — a value-returning function stubbed as silent" : ""),
      );
    }
  }
  return problems;
}

export type { LuaValue };
