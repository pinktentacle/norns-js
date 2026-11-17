// E1-03 / E1-04 — what a not-yet-implemented `_norns` function returns.
//
// THE DEFAULT IS NOTHING. Not `0`, not `nil`: nothing at all.
//
// This is the single most important rule carried out of the P0 spike. The
// spike's generic stub was `return 0`, which is the `platform_factory` bug
// generalised across the whole surface: in Lua `0` is **truthy**, so norns
// believed it was running on factory hardware. Any function whose result is
// tested with `if` is a landmine, and a stub that pushes a value where the C
// pushes none is a lie the caller cannot detect.
//
// So: the table below is the complete set of exceptions, each one with the
// reason it exists. Everything not listed pushes nothing.
//
// Sources, per entry, are `weaver.cc` line numbers read in this repo and the
// consumer in `lua/core` that makes the value matter. The arity of every entry
// is checked against `src/api/surface.json`, which is derived from the C by
// `tools/extract-api.mjs` — so a stub that returns the wrong NUMBER of values
// fails a test rather than being discovered later in a script.

import type { LuaValue } from "../lua/lua.js";

export interface StubSpec {
  /**
   * Values to push, in order. `[]` means push nothing.
   *
   * A function is allowed where the value cannot be a constant — `get_time`
   * has to advance or norns' menus never time out — but it must still push the
   * same NUMBER of values every call, because that is the part of the contract
   * the caller's `local a, b = f()` depends on.
   */
  readonly returns: readonly LuaValue[] | (() => readonly LuaValue[]);
  /** Why this is not the default, in one line. */
  readonly why: string;
}

/** Resolve a spec's values for one call. */
export function stubReturns(spec: StubSpec): readonly LuaValue[] {
  return typeof spec.returns === "function" ? spec.returns() : spec.returns;
}

/**
 * An image object, for the only two functions in the 178 that return something
 * with behaviour (`p1-api-plan.md` §4.3).
 *
 * `Screen.draw_to(image, func)` calls `image:_context_focus()` and
 * `image:_context_defocus()` around the user's function, and
 * `Screen.display_image` calls `image:extents()`. Returning `nil` or a bare
 * integer handle crashes both. Until cairo lands (E2-01) this is a table whose
 * methods do nothing — but it is the right SHAPE, which is what keeps boot
 * alive.
 */
function imageStub(name: string, w = 0, h = 0): LuaValue {
  return {
    __luaTable: {
      // Methods are filled in by install.ts, which can push functions; here we
      // record only the data. See `IMAGE_METHODS`.
      __norns_image: true,
      __name: name,
      __w: w,
      __h: h,
    },
  };
}

/** The method names the `_image` metatable carries (`weaver.cc:565`). */
export const IMAGE_METHODS = [
  "__gc",
  "__tostring",
  "__eq",
  "_context_focus",
  "_context_defocus",
  "extents",
  "name",
] as const;

export const STUBS: Readonly<Record<string, StubSpec>> = {
  // ---- screen (group 1) ------------------------------------------------
  screen_text_extents: {
    returns: [0, 0],
    why: "two integers (w, h). weaver.cc:1142. Measuring text is how every menu lays itself out.",
  },
  screen_current_point: {
    returns: [0, 0],
    why: "two numbers (x, y), the cairo current point. weaver.cc:1521.",
  },
  screen_peek: {
    returns: [""],
    why:
      "a binary string of exactly w*h bytes valued 0-15, never nil. An empty " +
      "string is the honest 'no pixels' answer; nil would break screen_poke's " +
      "round trip.",
  },
  screen_load_png: {
    returns: [imageStub("stub.png")],
    why: "an object with extents/name/_context_focus/_context_defocus. nil crashes Screen.draw_to.",
  },
  screen_create_image: {
    returns: [imageStub("created")],
    why: "same object contract as screen_load_png.",
  },

  // ---- clock (group 3) -------------------------------------------------
  clock_get_time_beats: {
    returns: [0.0],
    why: "number, fractional beats. Zero is the transport position before E3 starts it.",
  },
  clock_get_tempo: {
    returns: [120.0],
    why:
      "number, BPM. **Not 0**: core/clock.lua divides by the tempo, and a zero " +
      "tempo makes every beat conversion infinite or NaN.",
  },
  clock_link_get_number_of_peers: {
    returns: [0],
    why: "integer. Ableton Link is impossible in a browser (p1-api-plan §5.7); zero peers is true.",
  },

  // ---- mixer / analog (group 4) ----------------------------------------
  adc_rev: {
    returns: [0],
    why: "integer. weaver.cc:1548. This one is i2c and not crone, so it has no worklet route.",
  },

  // ---- grid / arc / monome (group 6) -----------------------------------
  grid_rows: {
    returns: [0],
    why: "integer. Zero until a grid is attached, which is also what hardware reports.",
  },
  grid_cols: {
    returns: [0],
    why: "integer. Zero until a grid is attached, which is also what hardware reports.",
  },

  // ---- jack / audio ports (group 10) -----------------------------------
  audio_connect: {
    returns: [true],
    why:
      "boolean. core/audio.lua tracks the value across SuperCollider restarts; " +
      "false would make it believe every connection failed.",
  },
  audio_disconnect: {
    returns: [true],
    why: "boolean. core/audio.lua tracks this value too; false reads as a failed teardown.",
  },
  audio_get_input_ports: {
    returns: [[]],
    why: "table of strings (_push_port_list, weaver.cc:2255). nil breaks core/audio.lua.",
  },
  audio_get_output_ports: {
    returns: [[]],
    why: "table of strings (_push_port_list, weaver.cc:2255). nil breaks core/audio.lua.",
  },
  audio_get_port_connections: {
    returns: [[]],
    why: "table of strings (_push_port_list, weaver.cc:2255). nil breaks core/audio.lua.",
  },
  audio_get_cpu_load: {
    returns: [0.0],
    why: "number. A real value becomes available from the worklet in E4 (cpu-metric.md).",
  },
  audio_get_xrun_count: {
    returns: [0],
    why: "number. Zero is honest until the worklet counts currentFrame gaps (E4-09).",
  },

  // ---- time / profiling (group 11) -------------------------------------
  get_time: {
    returns: () => {
      // TWO integers, seconds then microseconds. weaver.cc:2097 returns 2.
      // (The source comment there says "microseconds, seconds", which is the
      // wrong way round relative to the code — the code is what matters.)
      // util.time() computes s + us/1e6, so a frozen clock would stop every
      // timeout in the menu system. Real time is both easier and correct; the
      // monotonic version belongs to E3-01.
      const ms = Date.now();
      return [Math.floor(ms / 1000), (ms % 1000) * 1000];
    },
    why: "two integers (sec, usec). A frozen clock stops every menu timeout.",
  },
  cpu_time_get_delta: {
    returns: [0.0],
    why:
      "ONE number, in nanoseconds. boot-contract.md said (s, us) and was wrong " +
      "(p1-api-plan §0.2, weaver.cc:2319). Harmless so far only because nothing " +
      "under lua/ calls it.",
  },
  wall_time_get_delta: {
    returns: [0.0],
    why: "ONE number in nanoseconds, for the same reason as cpu_time_get_delta. weaver.cc:2309.",
  },

  // ---- system / file (group 12) ----------------------------------------
  system_glob: {
    returns: [null, 3],
    why:
      "table on success, (nil, glob_status) on failure. GLOB_NOMATCH is 3 and is " +
      "a FAILURE status, so an empty directory is (nil, 3) and not {}. Until the " +
      "virtual FS lands (E6-03) there is nothing to match, so (nil, 3) is the " +
      "truthful answer. core/mods.lua:24 indexes the result.",
  },
  sound_file_inspect: {
    returns: [0, 0, 0],
    why: "three integers: channels, frames, samplerate. weaver.cc:3463. Implementable in E6-07 by parsing a WAV header.",
  },
  execute: {
    returns: [""],
    why:
      "a string, possibly empty, NEVER nil: util.scandir calls :gmatch on the " +
      "result immediately. lib/util.lua:27.",
  },
  system_cmd: {
    returns: [false],
    why:
      "boolean. false means 'no event will fire', and the Lua callback is then " +
      "correctly never called. Returning true would leave a caller waiting forever.",
  },
  system_action: {
    returns: [false],
    why:
      "boolean. The FALLBACK for a page that does not call registerFs — which " +
      "implements all three actions, and makes RESTART reload the page. false " +
      "means 'unknown action'; `norns.lua:244` discards it, so a page without " +
      "registerFs sits on 'restarting.' and nothing happens. That is why the " +
      "implementation says out loud what it did.",
  },

  // ---- platform (group 15) ---------------------------------------------
  platform: {
    returns: [1],
    why:
      "integer enum from hardware/platform.h: UNKNOWN=0, OTHER=1, CM3=2, PI3=3, " +
      "PI4=4, CM4=5, CM4S=6. A browser is OTHER. Nothing reads norns.platform " +
      "beyond storing it.",
  },
  platform_factory: {
    returns: [false],
    why:
      "boolean, and the origin of this whole file's rule. norns.is_norns gates " +
      "the battery readout on the home screen (core/menu/home.lua:42); false is " +
      "correct for a browser, not a compromise.",
  },
  platform_shield: {
    returns: [false],
    why: "boolean. norns.is_shield gates only the wording of the sleep screen, core/menu/sleep.lua:23.",
  },
};

/** Names whose stub deliberately pushes nothing — i.e. every other one. */
export function stubFor(name: string): StubSpec {
  return STUBS[name] ?? EMPTY;
}

const EMPTY: StubSpec = { returns: [], why: "the default: the C pushes nothing, so neither do we" };
