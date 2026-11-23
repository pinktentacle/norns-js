// E3-01 / E3-04 / E3-05 / E3-10 — bind the clock to the `_norns` boundary.
//
// 25 of the 178: 16 `clock_*`, 3 `metro_*`, and the 6 time functions. Ten of
// the sixteen are honest stubs and say so by name.

import type { NornsRegistry } from "../norns/registry.js";
import type { Clock } from "./clock.js";

export interface ClockRegisterOptions {
  /** Called when something unimplementable is reached, for the compat page. */
  readonly onStub?: (name: string, why: string) => void;
  /** `clock_set_source`, 0-based as `clock.lua` sends it. */
  readonly onSource?: (source: ClockSource) => void;
  /** `clock_crow_in_div` — how many of crow's pulses make a beat. E9-206. */
  readonly onCrowDiv?: (div: number) => void;
}

/**
 * The four, as `_norns.clock_set_source` numbers them.
 *
 * `clock.lua:101` does `util.clamp(source-1, 0, 3)`, so what arrives here is
 * ALREADY 0-based — one of the few places in the boundary where Lua does the
 * subtraction rather than C.
 */
export const CLOCK_SOURCES = ["internal", "midi", "link", "crow"] as const;
export type ClockSource = (typeof CLOCK_SOURCES)[number];

/**
 * Impossible in a browser, and why. Each returns the shape upstream returns
 * so nothing downstream has to special-case them.
 *
 * Ableton Link is six of them: it needs **UDP multicast** on the local
 * network, which no browser API provides. A WebSocket bridge to a native
 * helper could carry it one day, but it would not be Link — it would be a
 * different protocol wearing Link's API, and that is worse than a stub that
 * says no.
 */
export const CLOCK_STUBS: Readonly<Record<string, string>> = {
  clock_link_set_tempo: "Ableton Link needs UDP multicast; no browser API provides it",
  clock_link_set_quantum: "Ableton Link needs UDP multicast",
  clock_link_set_transport_start: "Ableton Link needs UDP multicast",
  clock_link_set_transport_stop: "Ableton Link needs UDP multicast",
  clock_link_set_start_stop_sync: "Ableton Link needs UDP multicast",
  clock_link_get_number_of_peers: "Ableton Link needs UDP multicast; zero peers is true",
  // `clock_set_source` is NOT here any more: internal and midi both work.
  // `clock_crow_in_div` came out in E9-206: crow is reached over a serial
  // port now, and its pulses drive the clock as they do on a norns.
};

export function registerClock(
  registry: NornsRegistry,
  clock: Clock,
  opts: ClockRegisterOptions = {},
): void {
  // --- time ------------------------------------------------------------
  registry.implement("get_time", () => {
    // TWO integers, seconds then microseconds. `util.time()` computes
    // `s + us/1e6`, so splitting the same instant is all that matters.
    const ms = Date.now();
    return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1000)];
  });

  // Upstream's profiling timers, in nanoseconds and one value each —
  // `boot-contract.md` said `(s, us)` and was wrong (p1-api-plan §0.2).
  // Nothing under `lua/` calls either; they are script-facing.
  let cpuMark = 0;
  let wallMark = 0;
  const nowNs = (): number =>
    typeof performance !== "undefined" ? performance.now() * 1e6 : Date.now() * 1e6;
  registry.implement("cpu_time_start_timer", () => void (cpuMark = nowNs()));
  registry.implement("cpu_time_get_delta", () => [nowNs() - cpuMark]);
  registry.implement("wall_time_start_timer", () => void (wallMark = nowNs()));
  registry.implement("wall_time_get_delta", () => [nowNs() - wallMark]);

  registry.implement("usleep", () => {
    // A BLOCKING sleep in C. Blocking here would freeze the thread that pumps
    // the audio graph's messages, so it is a no-op and is recorded as one.
    // Nothing in `lua/core` calls it.
    opts.onStub?.("usleep", "a blocking sleep would freeze the message pump");
  });

  // --- metro -----------------------------------------------------------
  // All three take a 1-based index from Lua. `metro_start` is VARIADIC and
  // its sentinels matter: `seconds = -1` means reuse the previous value,
  // `count = -1` means forever, a missing `stage` means 0. A fixed-arity
  // implementation silently breaks `metro:start()` with no arguments.
  registry.implement("metro_start", (idx, seconds, count, stage) => {
    clock.metroStart(
      num(idx) - 1,
      seconds === null || seconds === undefined ? -1 : num(seconds),
      count === null || count === undefined ? -1 : num(count),
      stage === null || stage === undefined ? 0 : num(stage) - 1,
    );
  });
  registry.implement("metro_stop", (idx) => clock.metroStop(num(idx) - 1));
  registry.implement("metro_set_time", (idx, seconds) =>
    clock.metroSetTime(num(idx) - 1, num(seconds)),
  );

  // --- clock -----------------------------------------------------------
  registry.implement("clock_get_tempo", () => [clock.tempo]);
  registry.implement("clock_get_time_beats", () => [clock.beat]);
  registry.implement("clock_internal_set_tempo", (bpm) => clock.setTempo(num(bpm)));
  registry.implement("clock_internal_start", () => clock.transportStart());
  registry.implement("clock_internal_stop", () => clock.transportStop());
  registry.implement("clock_cancel", (id) => clock.cancel(num(id)));

  registry.implement("clock_schedule_sleep", (id, seconds) =>
    clock.scheduleSleep(num(id), num(seconds)),
  );

  registry.implement("clock_schedule_sync", (id, beat, offset) => {
    // `sync_beat <= 0` raises a Lua error upstream (weaver.cc:2149) and that
    // is the ONLY guard — `clock.sync(math.huge)` passes it, which is why the
    // scheduler uses fmax rather than Math.max.
    const b = num(beat);
    if (!(b > 0)) throw new Error("clock_schedule_sync: sync_beat must be > 0");
    clock.scheduleSync(num(id), b, offset === null || offset === undefined ? 0 : num(offset));
  });

  registry.implement("clock_set_source", (source) => {
    const i = num(source);
    const name = CLOCK_SOURCES[i] ?? "internal";
    if (name === "link") {
      // Accepting the call and staying on the clock we have is what upstream
      // does for a source it cannot reach. Saying nothing would leave the
      // param page showing a source that is not running anything.
      opts.onStub?.(
        "clock_set_source",
        `${name} is not available here; the clock stays where it was`,
      );
      return;
    }
    opts.onSource?.(name);
  });

  registry.implement("clock_crow_in_div", (div) => opts.onCrowDiv?.(num(div)));

  // --- the impossible ---------------------------------------------------
  for (const [name, why] of Object.entries(CLOCK_STUBS)) {
    registry.implement(name, () => {
      opts.onStub?.(name, why);
      return name === "clock_link_get_number_of_peers" ? [0] : undefined;
    });
  }
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}
