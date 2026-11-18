// E4-01 / E4-04 / E4-05 / E4-06 / E4-12 — bind sclang and scsynth to `_norns`.
//
// 11 of the 178 go over OSC to sclang, and they are the only ones that do:
// p1-api-plan §0.3 established that `crone` is compiled INTO matron at this
// revision, so `level_*`, `cut_*`, `tape_*`, `rev_*` and `comp_*` are an
// in-process command queue and not OSC at all. Sending them to sclang would
// be a whole subsystem addressed to the wrong place.

import type { NornsRegistry } from "../norns/registry.js";
import type { LuaValue } from "../lua/lua.js";
import type { EngineHost, OscArg } from "./host.js";
import type { Callbacks } from "../norns/callbacks.js";

export interface EngineCommand {
  readonly name: string;
  /** The stored format string: `s` string, `i` int, `f` float, per character. */
  readonly format: string;
}

export interface EngineState {
  /** Engine names, in the order sclang reported them. */
  readonly engines: string[];
  /** The command table, IN ORDER — `send_command` indexes it. */
  readonly commands: EngineCommand[];
  /** Poll descriptors: name and whether it carries data rather than a value. */
  readonly polls: Array<{ id: number; name: string; isData: boolean }>;
  /** True once `/crone/ready` has arrived and the boot gate has fired. */
  ready: boolean;
  /** Dispatch one message sclang addressed to matron. */
  onMatron(address: string, args: OscArg[]): void;
  /** Start asking for `/crone/ready`. Nothing sends it unprompted. */
  queryStartup(timeoutMs?: number, intervalMs?: number): void;
}

export interface RegisterEngineOptions {
  readonly callbacks: Callbacks;
  readonly log?: (line: string) => void;
  /** Called the first time the boot gate fires, for the UI. */
  readonly onReady?: () => void;
  /**
   * Loads sound files into scsynth's buffers. Without it, `Buffer.read`
   * answers "no loader" rather than hanging — see src/engine/buffers.ts for
   * why scsynth cannot read a file itself.
   */
  readonly buffers?: {
    read(
      bufnum: number,
      path: string,
      start: number,
      frames: number,
      pick?: readonly number[],
    ): Promise<void>;
  };
}

export function registerEngine(
  registry: NornsRegistry,
  host: EngineHost,
  opts: RegisterEngineOptions,
): EngineState {
  const log = opts.log ?? (() => {});
  const cb = opts.callbacks;

  // `onMatron` and `queryStartup` are attached at the end; the cast is the
  // one place this file is not fully typed, and it is deliberate — the two
  // closures need `state` and `state` needs them.
  const state = { engines: [], commands: [], polls: [], ready: false } as unknown as EngineState;

  /**
   * Call into Lua and REPORT what came back.
   *
   * `callNorns` returns the error rather than throwing, and discarding it is
   * how `startup_status.ok` failed silently: it ran `norns.state.resume()`,
   * raised inside it, and the three calls after — the VU poll, the tape poll
   * and the engine report — never happened. Nothing on screen said so.
   */
  const say = (what: string, e: { message: string } | null): void => {
    if (e) log(`${what} raised: ${e.message}`);
  };

  // Reports arrive as a start / entry… / end triple, so each is accumulated
  // into a scratch list and published whole. A half-built command table is
  // worse than none: `send_command` indexes it, and an index into a partial
  // table addresses the wrong command.
  let engineScratch: string[] = [];
  let commandScratch: EngineCommand[] = [];
  let pollScratch: Array<{ id: number; name: string; isData: boolean }> = [];

  /**
   * What an engine load is still waiting for.
   *
   * `oracle.cc:118` sets `needCommandReport` and `needPollReport` when a load
   * starts; each report's `end` handler clears its own flag and calls
   * `test_engine_load_done`, which posts EVENT_ENGINE_LOADED only once BOTH
   * are in. That event is `_norns.report.did_engine_load`, and
   * `core/engine.lua:94` is the only thing that clears `Engine.is_loading`.
   *
   * Without this, the first load works and every load after it returns false
   * — `Engine.load` refuses while a load is pending, and the pending flag is
   * never cleared. It took a loop over five engines to notice, because one
   * load in isolation looks perfectly fine.
   *
   * `needParamReport` is false upstream (a FIXME in oracle.cc:120), so two.
   */
  const pending = new Set<"commands" | "polls">();

  /**
   * How long an engine load may stay silent before the host gives up on it.
   *
   * THIS IS A WATCHDOG, AND IT IS LOAD-BEARING. `Engine.load` refuses
   * outright while `is_loading` is set (`core/engine.lua:90`), and the ONLY
   * thing that clears it is `did_engine_load`. So a single load that never
   * reports does not fail one script -- it wedges every script loaded
   * afterwards, for the rest of the session, with no error anywhere. That is
   * what it looked like in the E5-18 sweep: twenty scripts in a row reported
   * no init, several of which had passed minutes earlier.
   *
   * `NornsJsEngineLoadGuard.sc` already catches a throwing `alloc`, but it
   * cannot catch what never reaches it -- a throw inside a `fork` in alloc,
   * or in the class library before `init` runs. The watchdog lives OUTSIDE
   * sclang, which is the whole point: it is the one place that still works
   * when sclang's side of the handshake is gone.
   *
   * THIRTY SECONDS, and the number is measured rather than chosen. Most
   * engines load in two or three. Pedalboard is the outlier: it builds 194
   * commands and takes **8.2 s on a freshly booted page**, nearly all of it
   * before the first report fragment, so its silence is the real 8 s. At ten
   * seconds it tripped once in a forty-script run and the script then ran
   * against an empty command table.
   *
   * The cost of a larger number is only how long a genuinely dead load takes
   * to give up, and that is not the thing being optimised: the point is that
   * the session recovers at all, not that it recovers quickly.
   */
  const ENGINE_LOAD_TIMEOUT_MS = 30_000;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let loadingName = "";

  function clearLoadWatchdog(): void {
    if (loadTimer === undefined) return;
    clearTimeout(loadTimer);
    loadTimer = undefined;
  }

  /**
   * IT MEASURES SILENCE, NOT DURATION, and the difference is the whole
   * design. A plain deadline punishes a big engine for being big: Pedalboard
   * reports 194 commands and Timber is not much smaller, and when the
   * deadline fired mid-report the script ran against the PREVIOUS engine's
   * command table -- `rudiments` failed on `engine.shape` holding
   * Pedalboard's 194 commands, which is a far more confusing failure than a
   * hang. So every report fragment re-arms the timer: as long as sclang is
   * still talking, it has as long as it needs.
   */
  function touchLoadWatchdog(): void {
    if (pending.size === 0) return;
    clearLoadWatchdog();
    const name = loadingName;
    loadTimer = setTimeout(() => {
      loadTimer = undefined;
      if (pending.size === 0) return;
      const missing = [...pending].join(" and ");
      pending.clear();
      log(
        `engine ${name}: silent for ${ENGINE_LOAD_TIMEOUT_MS / 1000} s with no ` +
          `${missing} report. Letting the script run anyway — the alternative is ` +
          `that this and every later script wait for ever.`,
      );
      // The tables still hold the PREVIOUS engine's surface, because
      // `Engine.register_commands` only clears them when a report arrives.
      // Publishing empty ones is the honest state: this engine reported
      // nothing. A script then fails on its first engine call, with its own
      // name in the error, instead of calling someone else's command.
      state.commands.length = 0;
      state.polls.length = 0;
      say("report.commands", cb.reportCommands(state.commands));
      say("report.polls", cb.reportPolls(state.polls));
      say("report.did_engine_load", cb.didEngineLoad());
    }, ENGINE_LOAD_TIMEOUT_MS);
  }

  function loadDone(what: "commands" | "polls"): void {
    if (!pending.delete(what)) return;
    if (pending.size > 0) return;
    clearLoadWatchdog();
    say("report.did_engine_load", cb.didEngineLoad());
  }

  /** Everything sclang addresses to matron. The router already split it out. */
  function onMatron(address: string, args: OscArg[]): void {
    // A script's own OSC, wrapped by NornsJsOscPortOverride.sc because
    // sclang-wasm has no ports to route by. The shape is
    // `/norns-js/osc <port> <path> <args...>`, and it becomes
    // `_norns.osc.event(path, args, from)` — the same call matron makes when
    // a UDP packet arrives on 10111.
    if (address === "/norns-js/buffer/read") {
      // sclang asked for a sound file. It cannot read one — scsynth has no
      // libsndfile and its MEMFS is not this filesystem — so the decode
      // happens here and the samples are pushed in with /b_setn.
      const bufnum = Number(args[0] ?? -1);
      const path = String(args[1] ?? "");
      if (opts.buffers === undefined) {
        log(`buffer ${bufnum}: no loader; ${path} will be empty`);
        // Answer anyway: the sclang side runs the caller's action on a
        // failure too, because a script waiting for a buffer that never
        // reports hangs.
        host.sendToLang("/norns-js/buffer/done", [bufnum, 0, 0, 0]);
        return;
      }
      // Anything after the first four is the channel list from
      // `Buffer.readChannel`. Empty for a plain `Buffer.read`.
      const pick = args.slice(4).map((a) => Number(a)).filter((n) => Number.isFinite(n));
      void opts.buffers.read(bufnum, path, Number(args[2] ?? 0), Number(args[3] ?? -1), pick);
      return;
    }

    if (address === "/norns-js/osc") {
      const port = Number(args[0] ?? 0);
      const path = String(args[1] ?? "");
      // `from` is a {host, port} TABLE, not two values: `core/osc.lua:22`
      // documents it as one and scripts index `from[1]` and `from[2]`.
      // 127.0.0.1 because that is where it came from — sclang is in this
      // page, and saying anything else would be inventing a network.
      say("osc.event", cb.oscEvent(path, args.slice(2) as never, ["127.0.0.1", port] as never));
      return;
    }

    switch (address) {
      case "/crone/ready":
        // E4-04, the real boot gate. Until this fires, norns renders a menu
        // but is not running: `startup_status.ok` loads the last script,
        // starts the VU and tape polls, and asks for the engine report
        // (core/startup.lua:80-90). The P0 spike never called it, which is
        // why "26 distinct functions at boot" was a floor and not a ceiling.
        if (state.ready) return;
        state.ready = true;
        log("engine: /crone/ready — firing the boot gate");
        say("startup_status.ok", cb.startupOk());
        opts.onReady?.();
        return;

      case "/report/engines/start":
        engineScratch = [];
        return;
      case "/report/engines/entry":
        engineScratch.push(String(args[1] ?? ""));
        return;
      case "/report/engines/end":
        state.engines.length = 0;
        state.engines.push(...engineScratch);
        say("report.engines", cb.reportEngines(state.engines));
        log(`engine: ${state.engines.length} engines reported`);
        return;

      case "/report/commands/start":
        commandScratch = [];
        touchLoadWatchdog();
        return;
      case "/report/commands/entry":
        // (index, name, format). The FORMAT is the load-bearing part: §4.8.
        commandScratch.push({ name: String(args[1] ?? ""), format: String(args[2] ?? "") });
        touchLoadWatchdog();
        return;
      case "/report/commands/end":
        state.commands.length = 0;
        state.commands.push(...commandScratch);
        say("report.commands", cb.reportCommands(state.commands));
        log(`engine: ${state.commands.length} commands`);
        loadDone("commands");
        return;

      case "/report/polls/start":
        pollScratch = [];
        touchLoadWatchdog();
        return;
      case "/report/polls/entry":
        // (index, name, type). The index is 0-based on the wire and 1-based
        // in Lua, like every other id that crosses this boundary.
        pollScratch.push({
          id: Number(args[0] ?? 0) + 1,
          name: String(args[1] ?? ""),
          isData: Number(args[2] ?? 0) === 1,
        });
        touchLoadWatchdog();
        return;
      case "/report/polls/end":
        state.polls.length = 0;
        state.polls.push(...pollScratch);
        say("report.polls", cb.reportPolls(state.polls));
        log(`engine: ${state.polls.length} polls`);
        loadDone("polls");
        return;

      case "/poll/value":
        // 0-based on the wire; the callback layer adds the 1.
        say("_norns.poll", cb.pollValue(Number(args[0] ?? 0), Number(args[1] ?? 0)));
        return;
      case "/poll/data":
        say("_norns.poll", cb.pollData(Number(args[0] ?? 0), args[1] as LuaValue, Number(args[2] ?? 0)));
        return;

      default:
        return;
    }
  }

  // --- engine ----------------------------------------------------------
  const toSclang = (address: string, args: OscArg[] = []): void => host.sclang.sendOsc(encode(address, args));

  registry.implement("load_engine", (name) => {
    const which = String(name ?? "");
    // A fresh load supersedes whatever the last one was still waiting for:
    // the reports that arrive from here on belong to THIS engine.
    pending.clear();
    pending.add("commands");
    pending.add("polls");
    loadingName = which;
    touchLoadWatchdog();
    toSclang("/engine/load/name", [which]);
  });
  registry.implement("free_engine", () => toSclang("/engine/free"));
  registry.implement("report_engines", () => toSclang("/report/engines"));
  registry.implement("restart_audio", () => {
    // Upstream restarts the sclang service. There is no service here, and
    // tearing the wasm module down and rebuilding it is not the same thing —
    // it would lose every loaded SynthDef and the AudioContext with them.
    log("restart_audio: not available in a browser (there is no sclang service)");
  });

  registry.implement("send_command", (idx, ...rest) => {
    // §4.8, the sharpest edge in the whole surface. `send_command` takes a
    // 1-BASED INDEX into the command table built from /report/commands/entry,
    // and coerces each argument by the STORED FORMAT STRING. Forwarding
    // arguments without consulting the format sends floats where the engine
    // expects ints and strings, and the failure surfaces inside SuperCollider
    // — far from the cause, and in a language the user did not write.
    const i = Number(idx ?? 0) - 1;
    const cmd = state.commands[i];
    if (!cmd) {
      log(`send_command: no command at index ${i + 1} (${state.commands.length} known)`);
      return;
    }
    const coerced: OscArg[] = [];
    for (let k = 0; k < rest.length; k++) {
      const spec = cmd.format[k];
      const v = rest[k];
      if (spec === "s") coerced.push(String(v ?? ""));
      else if (spec === "i") coerced.push(Math.trunc(Number(v ?? 0)));
      else if (spec === "f") coerced.push(Number(v ?? 0));
      else {
        // A format shorter than the argument list is upstream raising a Lua
        // error; say so rather than guessing a type.
        log(`send_command: ${cmd.name} has format "${cmd.format}" but got ${rest.length} args`);
        return;
      }
    }
    toSclang(`/command/${cmd.name}`, coerced);
  });

  // --- polls (E4-06) ---------------------------------------------------
  // These four go over OSC to sclang. The other six — poll_start_vu and the
  // rest — belong to the worklet and are E4-09.
  //
  // THE INDEX IS 1-BASED COMING IN AND 0-BASED GOING OUT, and missing that
  // meant no poll in this project ever delivered a value to a script.
  // `poll_set_state` in `weaver.cc:2928` is
  //
  //     int idx = (int)luaL_checkinteger(l, 1) - 1; // convert from 1-based
  //
  // and the same subtraction is in `_set_poll_time` and
  // `_request_poll_value`. The other direction already had it:
  // `w_handle_poll_value` pushes `idx + 1`, which is what `/poll/value`
  // above does.
  //
  // Forwarding the 1-based id unchanged started the NEXT poll along, and the
  // values then arrived under that poll's name — so a script's callback on
  // `amp_out_l` was never called while `amp_out_r` quietly ran. Nothing
  // errored. Every script with a level meter or a phase readout — glut,
  // mangl, otis, pedalboard, reels, takt — has had a dead meter.
  const pollIdx = (v: unknown): number => Math.trunc(Number(v ?? 0)) - 1;
  registry.implement("start_poll", (idx) => toSclang("/poll/start", [pollIdx(idx)]));
  registry.implement("stop_poll", (idx) => toSclang("/poll/stop", [pollIdx(idx)]));
  registry.implement("set_poll_time", (idx, dt) =>
    toSclang("/poll/time", [pollIdx(idx), Number(dt ?? 0)]),
  );
  registry.implement("request_poll_value", (idx) =>
    toSclang("/poll/request/value", [pollIdx(idx)]),
  );

  registry.implement("osc_send_crone", (...args) => {
    const [address, ...rest] = args;
    toSclang(String(address ?? ""), rest.flat() as OscArg[]);
  });

  // --- audio -----------------------------------------------------------
  registry.implement("start_audio", () => {
    // Upstream tells matron the audio service is up. Here sclang boots the
    // server itself through `bootServer`, so this marks the request and the
    // handshake completes on its own.
    log("start_audio()");
  });
  registry.implement("audio_pitch_on", () => toSclang("/crone/pitch/on"));
  registry.implement("audio_pitch_off", () => toSclang("/crone/pitch/off"));

  // E9-112 — THE AUDIO LOAD, FROM THE SERVER THAT KNOWS IT.
  //
  // Stubbed at `0.0` until now, with a note saying a real value would come
  // from the worklet. It does not have to: scsynth measures its own DSP
  // against the block period and answers `/status` with it, which is the
  // same quantity jack gives matron on hardware — the AUDIO thread's
  // share, not the page's. `main.ts` asks once a second and the reply is
  // cached in `host.status`.
  //
  // Rounded to a whole percent here rather than in Lua: `home.lua:55` does
  // `math.floor` on it anyway, and 0.29 floored is 0, which is honest for
  // a server that is doing almost nothing.
  registry.implement("audio_get_cpu_load", () => [host.status.avgCpu]);

  // --- the virtual port graph (E4-12) ----------------------------------
  //
  // There is no JACK, but there IS a real graph to model: `core/audio.lua`
  // uses these to track SuperCollider's connections across restarts, and
  // `audio.supercollider_connect()` is called from startup.lua:110. A
  // registry that records connections and can replay them is honest and
  // cheap; returning empty lists forever would make norns believe every
  // connection failed.
  const ports = {
    inputs: ["crone:input_1", "crone:input_2", "SuperCollider:out_1", "SuperCollider:out_2"],
    outputs: ["crone:output_1", "crone:output_2", "SuperCollider:in_1", "SuperCollider:in_2"],
    connections: new Set<string>(),
  };
  registry.implement("audio_get_input_ports", () => [ports.inputs as unknown as LuaValue]);
  registry.implement("audio_get_output_ports", () => [ports.outputs as unknown as LuaValue]);
  registry.implement("audio_get_port_connections", (port) => [
    [...ports.connections]
      .filter((c) => c.startsWith(`${String(port ?? "")}\u0000`))
      .map((c) => c.split("\u0000")[1]!) as unknown as LuaValue,
  ]);
  registry.implement("audio_connect", (from, to) => {
    ports.connections.add(`${String(from ?? "")}\u0000${String(to ?? "")}`);
    return [true];
  });
  registry.implement("audio_disconnect", (from, to) => {
    ports.connections.delete(`${String(from ?? "")}\u0000${String(to ?? "")}`);
    return [true];
  });

  /**
   * The startup handshake (E4-04).
   *
   * `/crone/ready` is only ever sent in REPLY to `/ready` (Crone.sc:214), so
   * nothing arrives unless matron asks — and matron asks in a loop:
   * `hello.cc` polls every 5 ms for 2400 ticks, about **12 seconds**, then
   * gives up and posts a timeout. Crone answers as soon as `finishBoot` sets
   * `complete = 1`, which is before its 11-second startup tone, so the wait is
   * usually short and the tone plays over an already-running norns.
   *
   * The interval here is 50 ms rather than 5. Upstream's 5 ms is driving the
   * boot LED animation at the same time; there is no LED, and 240 polls over
   * the same 12 seconds is the same deadline at a fortieth of the traffic.
   */
  function queryStartup(timeoutMs = 12000, intervalMs = 50): void {
    const deadline = performance.now() + timeoutMs;
    const tick = (): void => {
      if (state.ready) return;
      if (performance.now() > deadline) {
        // Upstream clears the script and says so. A silent failure here would
        // leave norns drawing a menu over an engine that never arrived.
        log("engine: /crone/ready did not arrive within 12 s");
        say("startup_status.timeout", cb.startupTimeout());
        return;
      }
      toSclang("/ready");
      setTimeout(tick, intervalMs);
    };
    tick();
  }

  return Object.assign(state, { onMatron, queryStartup });
}

/** Local import kept at the bottom so the exported shape reads first. */
import { encodeMessage as encode } from "./osc.js";
