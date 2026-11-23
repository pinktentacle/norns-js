// E2-03 + E2-05 — norns on a page you can look at and press.
//
// Boots the Lua host with the real `lua/core`, binds the wasm screen to it,
// and wires a keyboard, a mouse and a touch screen to the three keys and three
// encoders. No audio: that is E4.

// E9-118 — the `process` and `Buffer` globals that were installed here
// first, before any other import, are gone. fengari read them while it
// initialised, being a Node-shaped CommonJS package; a wasm module reads
// nothing of the sort, and the page was BUILT AND BOOTED without them
// before they were deleted.
import { createHost, boot, type Host } from "./lua/host.js";
import { loadNornsLuaWeb, loadConfigWeb } from "./lua/host-web.js";
import menuHereLua from "./lua/norns-js/menu-here.lua?raw";
import screenDirectLua from "./lua/norns-js/screen-direct.lua?raw";
import benchLua from "./lua/norns-js/bench.lua?raw";
import cpuLua from "./lua/norns-js/cpu.lua?raw";
import luaprofLua from "./lua/norns-js/luaprof.lua?raw";
import { luaHeapBytes } from "./lua/wasm53.js";
import { clockStepMs, createProbe, oscName, type Probe } from "./ui/probe.js";
import { decode as decodeOsc, encodeMessage as encodeOsc } from "./engine/osc.js";
import { createScreen, type Screen } from "./screen/screen.js";
import { loadScreenModuleWeb } from "./screen/screen-web.js";
import { createScreenCanvas } from "./ui/canvas.js";
import { createInput, type Side } from "./ui/input.js";
import { createPadCore, readPad, type PadCore } from "./ui/gamepad.js";
import { detect, effectiveKind, readSignals, type MachineKind } from "./ui/machine.js";
import { startCpuMeter } from "./ui/cpu-meter.js";
import { createLog } from "./ui/log.js";
import { profileRequest, startProfile } from "./ui/profiler.js";
import { describeFrames, watchLongFrames } from "./ui/frames.js";
import { describeDeviceLatency, describeGraphLatency } from "./ui/audio-latency.js";
import { afterPaint } from "./ui/first-paint.js";
import { describeVu, emptyVu, foldVu, judgeVu } from "./ui/output-watch.js";
import {
  describeAudioLoad,
  emptyAudioLoad,
  foldCrone,
  foldScsynth,
} from "./ui/audio-load.js";
import { drawingRatio } from "./ui/dpr.js";
import { createWakeupWatch } from "./ui/wakeups.js";
import { accountedMs, callCosts, resetCallCosts, sayCost, timed, watchCallCost } from "./norns/call-cost.js";
import { registerScreenImages } from "./screen/images.js";
import { registerHardware, type Hardware } from "./norns/hardware.js";
import { registerOsc } from "./osc/register.js";
import { exercise, scriptsIn, type ExerciseOptions } from "./exercise/runner.js";
import { OscRemote } from "./osc/remote.js";
import { browserStorage, createSettings, dbToGain, type DeviceId } from "./ui/settings.js";
import { openAudioInput } from "./engine/input.js";
import {
  canChooseOutput,
  grantDeviceAccess,
  listAudioDevices,
  setOutputDevice,
  watchDevices,
} from "./ui/audio-devices.js";
import { createStage, type Stage } from "./ui/stage.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { createMaidenPanel } from "./ui/maiden-panel.js";
import { createVfsStore } from "./editor/store.js";
import { createRunner } from "./editor/runner.js";
import { installFromRepo, parseRepoUrl } from "./community/install.js";
import { fetchAndStoreCatalogs } from "./community/maiden-catalogs.js";
import { needsOf } from "./community/needs.js";
import { initLua, lua, luaVersion, to_luastring } from "./lua/lua.js";
import {
  MISSING_INCLUDE,
  SCRIPT_LOAD,
  readMissingInclude,
} from "./community/missing-include.js";
import { declareExtensions } from "./community/extensions.js";
import { exportTree, fetchArchive, importTree, installScript } from "./fs/transfer.js";
import { makeCallbacks } from "./norns/callbacks.js";
import { loadDustWeb } from "./fs/dust-web.js";
import { registerFs } from "./fs/register.js";
import { restoreFromOpfs, mirrorToOpfs, wipeOpfs } from "./fs/opfs.js";
import { GridManager } from "./grid/manager.js";
import { registerGrid } from "./grid/register.js";
import { GridView } from "./grid/view.js";
import { MidiManager } from "./midi/manager.js";
import { registerMidi } from "./midi/register.js";
import { startWebMidi } from "./midi/web.js";
import { createVirtualMidiPort, type VirtualMidiPort } from "./midi/virtual.js";
import { createKeyboardMidiPort, type KeyboardMidiPort } from "./midi/keyboard.js";
import { createKeyboardView, type KeyboardView } from "./ui/keyboard-view.js";
import { createFadersMidiPort, FADERS_MIDI_NAME, type FadersMidiPort } from "./midi/faders.js";
import { createFadersView, type FadersView } from "./ui/faders-view.js";
import { createKnobsMidiPort, KNOBS_MIDI_NAME, type KnobsMidiPort } from "./midi/knobs.js";
import { createKnobsView, type KnobsView } from "./ui/knobs-view.js";
import { RemoteGridTransport } from "./grid/remote.js";
import { ArcManager } from "./arc/manager.js";
import { registerArc } from "./arc/register.js";
import { ArcView } from "./arc/view.js";
import { registerMonome } from "./monome/register.js";
import { registerSerial } from "./serial/register.js";
import { MidiClockSource } from "./clock/midi-source.js";
import type { ClockSource } from "./clock/register.js";
import type { Clock } from "./clock/clock.js";
import { createWorkletClock } from "./clock/clock.js";
import { createEngineHost } from "./engine/host.js";
import { repairScSource } from "./engine/sc-source.js";
import { registerEngine } from "./engine/register.js";
import { createBufferLoader } from "./engine/buffers.js";
import { parseWavHeader } from "./fs/wav-header.js";
import { registerClock } from "./clock/register.js";
import { startCrone } from "./crone/crone.js";
import {
  registerCrone,
  croneEvents,
  croneFileWriter,
  croneTapeWriter,
  createTapePaths,
} from "./crone/register.js";
import { captured } from "./engine/capture.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const logEl = $<HTMLPreElement>("#log");

/**
 * The loudest sample in the meter's window, 0..1.
 *
 * `getFloatTimeDomainData` is the raw signal, not the spectrum, so this is
 * the peak you would see on a meter rather than an energy estimate. One
 * window is 2048 samples — about 43 ms at 48 kHz — which is long enough to
 * catch a note and short enough to ask for repeatedly.
 */
function peakOf(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) {
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

/** E9-130 — stamped and appended; see `src/ui/log.ts` for both reasons. */
const rawLog = createLog(logEl);

/**
 * E9-166 — THE ONE PLACE EVERY LINE GOES PAST, so it can also be read.
 *
 * `output-watch.ts` needs to know whether a script is running before it
 * will say that nothing reaching the mixer is worth mentioning — a quiet
 * page with no script is not a fault, and an instrument that cries wolf
 * at idle is one people learn to scroll past.
 *
 * Matron does not tell this file; it tells the LOG. `# script run` and
 * `# script clear` are norns' own vocabulary, printed by `core/script.lua`
 * on every load and every unload, and they go through here like
 * everything else. Reading them costs one `startsWith` per line.
 *
 * FRAGILE BY CONSTRUCTION, and said so here: if upstream reworded those
 * two lines this would quietly answer `false` for ever. What it guards
 * is one observational message, so the failure is a line that stops
 * appearing rather than a wrong one.
 */
let scriptIsLoaded = false;
/** Whether this script has already been told its input is off. E9-173. */
let saidInputIsOff = false;
const log = (line: string): void => {
  if (line.startsWith("# script run")) scriptIsLoaded = true;
  else if (line.startsWith("# script clear")) {
    scriptIsLoaded = false;
    // A new script gets its own warning: the last one having been told
    // says nothing about this one.
    saidInputIsOff = false;
  }
  rawLog(line);
};

/**
 * Baked in by vite (see `define` in vite.config.ts), so a page can say which
 * build it is. A copy of this runs on other machines, and "the button is not
 * there" and "there is no sound" are both what an OLD build looks like.
 */
declare const __BUILD_ID__: string;

/**
 * E9-60 — an install gives up rather than hanging for ever.
 *
 * `fetch` has no timeout of its own, and a connection the CDN accepts and
 * then stalls never settles: measured on `graintopia`, which sat at 20 of
 * its 22 files for four minutes with no traffic at all and could not be
 * stopped, because there was nothing to stop — the promise simply never
 * resolved. The retry that fetches a file from a second source cannot help
 * either, since the first attempt has not failed yet.
 *
 * Ten minutes is long on purpose. A repository with 60 MB of samples on a
 * slow line is a legitimate install, and somebody who has changed their
 * mind already has a cancel button; this is for the case where nothing is
 * coming and no one is told.
 */
const STALL_MS = 10 * 60 * 1000;

function withStallTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(STALL_MS);
  if (!signal) return timeout;
  // `AbortSignal.any` is the whole of it where it exists; where it does not,
  // the caller's own signal is still honoured and only the timeout is lost.
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([signal, timeout]) : signal;
}

async function main(): Promise<void> {
  let dirty = true;
  log(`norns-js · build ${typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"}`);
  log("loading the screen module…");
  const screen: Screen = await createScreen(loadScreenModuleWeb, {
    // Upstream's screen_update pushes the surface over SPI. Here it marks the
    // frame dirty and the next animation frame presents it: drawing straight
    // from this callback would repaint several times inside one redraw, since
    // norns calls screen.update() once per page and the menu redraws pages in
    // sequence.
    onUpdate: () => void (dirty = true),
    // cairo trapped and the context was rebuilt (E5-27). Said out loud,
    // because a lost frame with no explanation is how this went unnoticed
    // for a whole epic: the screen simply stayed black.
    onTrap: (name, count) => {
      dirty = true;
      log(`screen: ${name} trapped in cairo; context rebuilt (${count})`);
    },
    // Past the bound. Rebuilding leaks, so trying for ever ends in a
    // corrupted heap rather than a working screen; this says the one thing
    // that helps instead of pretending.
    onGone: (traps) => {
      log(
        `screen: the drawing module is past saving after ${traps} traps. ` +
          "Everything else still runs; reload the page to get the screen back.",
      );
    },
  });

  // The dust tree has to be in place BEFORE Lua starts: `io.open` and
  // `loadfile` are synchronous and have nowhere to await, and norns reads its
  // display settings during `_startup`.
  log("loading the dust tree…");
  const vfs = await loadDustWeb();

  // Whatever this origin saved last time, BEFORE Lua starts. `state.resume`
  // reads `system.state` during `_startup`, so a file that arrives later
  // arrives after the only moment anything reads it. See src/fs/opfs.ts.
  /**
   * E9-138 — name the callback that held the thread.
   *
   * Started before anything can call into Lua, because the costly
   * callback is as likely to be `init` as anything a script does later.
   * See `src/norns/call-cost.ts` for why this is on without being asked.
   */
  watchCallCost({
    onSlow: (c) =>
      log(
        `slow callback: ${c.path} took ${c.ms.toFixed(0)} ms` +
          ` — worst ${c.worstMs.toFixed(0)} ms over ${c.calls} call${c.calls === 1 ? "" : "s"}`,
      ),
  });

  /**
   * E9-149 — `?profile` samples the real stack, from here.
   *
   * Started BEFORE the tree is restored, because the boot is part of what
   * a phone is waiting through: there are eight seconds between the
   * storage line and the extensions line on one, and nothing instrumented
   * sits in between.
   *
   * The download is handed over late — `download` is declared two
   * thousand lines below and a profile started after it would miss the
   * boot. The summary reaches the log either way, and the log is the
   * channel that works from a phone.
   */
  let offerFile: ((bytes: Uint8Array, name: string) => void) | null = null;
  /**
   * E9-162 — the other half of "busy": what the main thread did that no
   * script asked for. See `ui/frames.ts`.
   *
   * DECLARED HERE, above the profile that reads it, and not beside the
   * CPU meter a thousand lines down where it belongs by subject: a short
   * `?profile=2` finishes before the boot reaches that line, and the
   * summary would reach this in its temporal dead zone.
   */
  const frameLoad = watchLongFrames();
  const profile = profileRequest(globalThis.location?.search ?? "");
  /**
   * E9-162 — THE SAMPLER AND THE INSTRUMENT, SIDE BY SIDE.
   *
   * The sampled table ranks by share of the busy samples; the account in
   * `call-cost.ts` has been counting the same work in milliseconds the
   * whole time. Printing them together is what makes either readable: a
   * path at twenty per cent of six per cent of ninety seconds is a
   * second and a bit, and a reader should not have to do that
   * multiplication to find out.
   */
  let profileRun: { mark(): void; phase(label: string, fromMs: number, toMs: number): void } | null = null;
  /**
   * E9-200 — EVERY INSTRUMENT A PROFILE CARRIES BACK. See `ui/probe.ts`.
   *
   * Built here, a few lines after the URL is read, because the frame loop
   * and the timer that feed it are set up long before the things it
   * REPORTS on exist. Every source below is a function for that reason:
   * the host, the grid, the audio context and the engine are declared
   * hundreds of lines down and are only asked for at a mark.
   *
   * `null` WITHOUT `?profile`, and every feed is `probe?.`. A page nobody
   * is measuring runs none of it.
   */
  /** What the page adds to each report: slow events, pressure, battery. */
  const probeNotes: Array<() => string | null> = [];
  const probe: Probe | null =
    profile === null
      ? null
      : createProbe({
          now: () => performance.now(),
          heap: () =>
            (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? null,
          bridge: () => host.registry.slots,
          costs: () => callCosts(),
          audio: () => audioContext,
          grid: () => gridView?.stats() ?? null,
          heaps: () => {
            const out: Array<readonly [string, number]> = [["lua", luaHeapBytes()]];
            const size = (m: unknown): number =>
              (m as { HEAPU8?: { length: number } } | null | undefined)?.HEAPU8?.length ?? 0;
            const lang = size(scEngine?.sclang);
            const synth = size(scEngine?.scsynth);
            if (lang > 0) out.push(["sclang", lang]);
            if (synth > 0) out.push(["scsynth", synth]);
            return out;
          },
          notes: () => probeNotes.map((f) => f()).filter((l): l is string => l !== null),
        });
  /** Set once there is an engine to ask; see where the engine comes up. */
  let probeRun: ((what: string, n: number, text: string) => void) | null = null;
  /** The whole of a mark, callable from the page as well as from Lua. */
  let reportPhase: ((what: string, fromLua: boolean) => void) | null = null;
  if (profile !== null) {
    profileRun = startProfile(
      profile,
      (l) => log(l),
      (b, n) => offerFile?.(b, n),
      () => {
        // E9-200 — the span since the last mark is a span like any other.
        // Reported as one, so the end of a hand-driven session carries
        // the same lines as a phase of the bench.
        if (reportPhase !== null) {
          reportPhase("the end of the profile window", false);
          /**
           * AND THE WHOLE LOG AS A FILE. A run of `_cpu` and `_bench` is
           * a couple of thousand lines; the copy button still works, but
           * a quarter of a megabyte through a phone's clipboard is the
           * step most likely to lose the end of it. Offered a moment
           * later, so the lines this very function is about to cause —
           * the Lua half of the last mark — are in it.
           */
          setTimeout(() => {
            const text = logEl.textContent ?? "";
            const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "");
            offerFile?.(new TextEncoder().encode(text), `norns-js-log-${stamp}.txt`);
            log(
              `profile: this log is downloading too (${(text.length / 1024).toFixed(0)} KB) — ` +
                `the copy button gives the same text.`,
            );
          }, 500);
          return [];
        }
        const lines: string[] = [];
        const costs = callCosts().filter((c) => c.ms >= 1);
        lines.push(
          costs.length === 0
            ? "profile: the instrumented account is empty — nothing this project times ran for a millisecond."
            : "profile: and what this project times, in milliseconds rather than shares:",
        );
        for (const c of costs.slice(0, 8)) {
          lines.push(`  ${sayCost(c).padStart(10)}  over ${String(c.calls).padStart(6)} calls   ${c.path}`);
        }
        const frames = describeFrames(frameLoad.load());
        lines.push(frames ?? "frames: none over 50 ms in the whole run.");
        return lines;
      },
    );
  }

  log("restoring saved files…");
  await restoreFromOpfs(vfs, { log: (l) => log(l) });

  /**
   * E9-137 — SAY HOW MUCH ROOM THERE IS, AND WHETHER IT IS KEPT.
   *
   * Two numbers that decide whether an install survives, and neither was
   * ever written down. A phone is where they bite: the quota is a share of
   * the device's FREE space, so a full phone gets a small one, and
   * `tmi` — fifteen files — pulls `kolor` behind it, which is 446 files
   * and 58.7 MB. Measured on this machine at 12520 MB of quota, which is
   * why nothing here has ever hit it.
   *
   * `persisted` is the other half and the quieter one. Without
   * `navigator.storage.persist()` an origin is BEST-EFFORT: the browser
   * may evict it under storage pressure, and Android does. That is a
   * script collection disappearing between two sessions with nothing
   * said. This line does not ask for persistence — Firefox prompts for
   * it, and a prompt on page load is not ours to spend — it only reports
   * which of the two kinds of storage the page is standing on.
   *
   * Failure is silent on purpose: a browser without the Storage API
   * simply does not get the line, which is one line less rather than one
   * boot less.
   */
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) {
      const mb = (n: number): string => (n / 1048576).toFixed(1);
      const kept = (await navigator.storage?.persisted?.()) === true;
      log(
        `storage: ${mb(est.usage ?? 0)} MB used of ${mb(est.quota ?? 0)} MB` +
          (kept ? ", persistent" : ", best-effort — the browser may clear it"),
      );
    }
  } catch {
    // See above: no line rather than no boot.
  }

  // E9-33 — what the server has, said where thirteen scripts look for it.
  //
  // BEFORE LUA, because `engine.name` is often decided in a script's main
  // chunk — `bitters` writes
  // `util.file_exists(ext.."/PulsePTR/PulsePTR.sc") and … or nil` at the
  // top of the file — so an answer that arrives after the script loads
  // arrives after the only moment it is read. Same reason the restore
  // above runs here.
  //
  // After the restore, not before: this writes into the VFS and a restore
  // landing on top of it would put back whatever a previous session had
  // there.
  await declareExtensions(vfs, { log: (l) => log(l) });

  // AN INTERRUPTED DOWNLOAD, SWEPT AT BOOT.
  //
  // `installFromRepo` stages into `~/dust/.installing/<name>` and only moves
  // the files into `code/` when they are all there, so a cancel or a failure
  // cleans up after itself (E9-19). A CLOSED TAB DOES NOT: the page goes
  // away mid-download and the sweep never runs, leaving a part of a script
  // in OPFS — outside `code/`, so nothing lists it, nothing loads it, and
  // nobody ever finds it. Three were sitting here when this was written,
  // left by reloads during testing.
  //
  // Anything in there is by definition a download that did not finish, so
  // the boot is the right place and "delete it" is the right answer.
  const stale = vfs.list("/home/we/dust/.installing").map((e) => e.name);
  if (stale.length > 0) {
    for (const p of vfs.walk("/home/we/dust/.installing")) vfs.remove(p);
    for (const name of stale) vfs.remove(`/home/we/dust/.installing/${name}`);
    vfs.remove("/home/we/dust/.installing");
    log(`swept ${stale.length} interrupted download${stale.length === 1 ? "" : "s"}: ${stale.join(", ")}`);
  }
  /**
   * E9-176 — THE BENCH IS THERE WHEN YOU ARE PROFILING, AND NOT OTHERWISE.
   *
   * `src/lua/norns-js/bench.lua` is a script with no musical value whose
   * only job is to do the same work every time, so that two profiles can
   * be compared. It ships inside the application rather than in the dust
   * tree, because the published build is `--no-scripts` and anything
   * under `community patches/` is stripped out of it.
   *
   * PUT THERE BY `?profile` AND TAKEN AWAY WITHOUT IT. A diagnostic that
   * stays in SELECT for ever after one profiling session is clutter
   * somebody has to work out how to remove; one that appears exactly
   * when it is useful needs no explaining. Both directions run on every
   * boot, so the state always matches the URL.
   */
  const BENCH_DIR = "/home/we/dust/code/_bench";
  const BENCH_LUA = `${BENCH_DIR}/_bench.lua`;
  /**
   * E9-191 — AND THE ONE THAT ASKS WHY THE PHONE IS SLOW.
   *
   * `_bench` reported a Lua callback at 18.8 us on this desktop and 462 us
   * on a Pixel 9 Pro — twenty-four times, for arithmetic on a handful of
   * locals, where drawing is three. Geekbench 6 single-core puts the two
   * processors about 1.5x apart and this code is single-threaded, so
   * sixteen of those twenty-four are something else.
   *
   * `_cpu` sweeps the duty cycle with the work unit held identical. Flat
   * cost per iteration means the processor; falling means the scheduler
   * was never giving the page a fast core to begin with.
   */
  const CPU_DIR = "/home/we/dust/code/_cpu";
  const CPU_LUA = `${CPU_DIR}/_cpu.lua`;
  if (profile !== null) {
    if (vfs.read(BENCH_LUA) === null) {
      log("bench: _bench and _cpu are in SELECT — two scripts that measure this page");
    }
    vfs.write(BENCH_LUA, new TextEncoder().encode(benchLua));
    vfs.write(CPU_LUA, new TextEncoder().encode(cpuLua));
  } else {
    for (const dir of [BENCH_DIR, CPU_DIR]) {
      if (vfs.walk(dir).length === 0) continue;
      for (const p of vfs.walk(dir)) vfs.remove(p);
      vfs.remove(dir);
    }
  }

  const mirror = mirrorToOpfs(vfs, { log: (l) => log(l) });
  // A tab being closed is the common case for losing the last write, and
  // `visibilitychange` is the event that actually fires on mobile. The flush
  // is not awaited — nothing can await during a teardown — but starting it
  // is what gives it a chance.
  globalThis.addEventListener("pagehide", () => void mirror.flush());
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (globalThis.document?.hidden) void mirror.flush();
  });

  const installed = vfs.list("/home/we/dust/code").filter((e) => e.isDir).length;

  /**
   * A shell command that was refused, said once and in full.
   *
   * THE COMMAND, not only the verb. "unsupported shell command: wget" is
   * true and useless; the thing that explains a script's behaviour is what
   * it was trying to do — `cd /tmp && wget …tapedeck/releases… && sudo
   * rsync … Extensions/` says, to anyone who reads it, that the script is
   * installing a native SuperCollider plugin and that no restart will ever
   * produce one here.
   *
   * Trimmed to one line and 160 characters: `install.sh` scripts run to
   * hundreds of characters and the console is not a terminal.
   *
   * E9-69 — AND A BURST OF THE SAME REFUSAL IS ONE REFUSAL.
   *
   * `folio` lists the whole library and asks git for a version of every
   * entry it lists:
   *
   *     e['git_hash'] = run_cmdline('cd '..paths.code..name..' && git describe --always') or ''
   *
   * 359 entries, 359 refusals, every one of them a different command and
   * every one of them the same fact. Measured: a 1397-line log of which
   * 359 lines were ours saying `cd` is not supported, in a window where
   * the interesting line was the one before them.
   *
   * So the FIRST is said in full, as it always was, and the ones that
   * follow it in the same burst are counted and reported together when
   * they stop. Nothing is hidden and no count is lost — an isolated
   * refusal a minute later is a new burst and is said in full again,
   * which a per-session cap would not have done.
   */
  const bursts = new Map<string, { n: number; latest: string; timer: ReturnType<typeof setTimeout> }>();
  const refused = (cmd: string, why: string): void => {
    const one = cmd.replace(/\s+/g, " ").trim();
    const short = one.length > 160 ? one.slice(0, 157) + "…" : one;
    const open = bursts.get(why);
    if (open === undefined) {
      log(`shell refused: ${why} — ${short}`);
      bursts.set(why, { n: 0, latest: short, timer: setTimeout(() => bursts.delete(why), 1000) });
      return;
    }
    clearTimeout(open.timer);
    open.n += 1;
    open.latest = short;
    open.timer = setTimeout(() => {
      bursts.delete(why);
      log(`shell refused: ${why} — and ${open.n} more like it, last ${open.latest}`);
    }, 1000);
  };

  // E9-59 — norns' OWN Lua is on the filesystem too, as it is on hardware.
  //
  // The sources are bundled for `require`, which reads them from a map. But
  // `include` does not use that map: `startup.lua:52` resolves a name with
  // `util.file_exists(dir .. file .. '.lua')` against the script's path,
  // `_path.code` and `_path.extn` — and `_path.extn` is
  // `/home/we/norns/lua/extn/`, which held NOTHING here. So
  //
  //     tambla.lua   local sky = include('sky/unstable')
  //     ### MISSING INCLUDE: sky/unstable
  //
  // while `extn/sky/unstable.lua` sat in the bundle the whole time. It is
  // mounted, not written: a mount is a supplier the base layer answers from,
  // so the OPFS mirror never sees it and storage does not gain a copy of the
  // bundle on every boot.
  const nornsSources = loadNornsLuaWeb();
  for (const [name, src] of nornsSources) {
    vfs.mount(`/home/we/norns/lua/${name}.lua`, () => src);
  }

  // E9-37 — the dependency a script downloads for itself.
  //
  // Fourteen scripts do this, and most want a GitHub repository or a
  // release file. The shell recognised the shape and said no for THIS
  // run, truthfully; here is where the work actually happens, and the
  // files are in place the next time the script is loaded.
  //
  // Deliberately not awaited and deliberately not retried: the script
  // has already been told, and a failure says so in the log rather than
  // leaving a half tree behind — `installFromRepo` stages outside
  // `code/` and sweeps after itself.
  //
  // E9-69 — AND IT IS WIRED TO BOTH DOORS NOW. `registerFs` below takes
  // the same function: `util.os_capture` is `_norns.execute`, which is
  // what norns' own Lua gives a script to shell out with, and that door
  // reported the download and never started it.
  const startFetch = (f: { kind: "repo" | "file"; url: string; dest: string }): void => {
    void (async () => {
      try {
        if (f.kind === "repo") {
          const repo = parseRepoUrl(f.url);
          if (!repo) {
            log(`fetch: ${f.url} is not a github repository`);
            return;
          }
          const name = f.dest.split("/").filter(Boolean).pop() ?? repo.repo;
          const r = await installFromRepo(vfs, repo, { name, commit: () => mirror.flush() });
          log(`fetch: ${repo.owner}/${repo.repo} → ${f.dest} (${r.files} files)`);
        } else {
          const res = await fetch(f.url);
          if (!res.ok) {
            log(`fetch: ${f.url} answered ${res.status}`);
            return;
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          vfs.write(f.dest, bytes);
          log(`fetch: ${f.url} → ${f.dest} (${(bytes.length / 1024).toFixed(0)} KB)`);
        }
      } catch (e) {
        log(`fetch: ${f.url} failed — ${(e as Error).message}`);
      }
    })();
  };

  /**
   * E9-109 — A SCRIPT THAT CANNOT LOAD BECAUSE ANOTHER ONE IS NOT HERE.
   *
   * `tmi` ends at `### MISSING INCLUDE: kolor/lib/lattice` and a traceback,
   * and nothing anywhere says that `kolor` is a catalogue script, that it
   * is not installed, or that installing it is the cure. Reported from a
   * phone (user, 2026-11-18).
   *
   * It is supposed to be installed for you and usually is — E9-32 reads a
   * freshly installed script's includes and E9-34 fetches what they name.
   * But that is asked ONCE, in the minute after the install, and `kolor` is
   * 446 files: a backgrounded tab, a reload or a cancel leaves `tmi` here
   * and `kolor` not, and nobody asks again. So it is asked again here,
   * where the failure actually happens.
   *
   * THROUGH maiden's OWN QUEUE rather than a second installer, so it gets
   * the row, the count and the cancel that every other install has, behind
   * anything already downloading. `maiden.want` is that door.
   *
   * ONCE PER PATH PER SESSION. A script left in SELECT redraws and can be
   * loaded again and again; three identical paragraphs about `kolor` would
   * bury the one that matters.
   */
  let loadingScript: string | null = null;
  const toldAbout = new Set<string>();

  const watchIncludes = (line: string): void => {
    const loaded = SCRIPT_LOAD.exec(line);
    if (loaded !== null) {
      // `/home/we/dust/code/tmi/tmi.lua` — the FOLDER is the script's name,
      // and a folder can have a space in it (`get in the sea!`), so this
      // takes the segment rather than the file's stem.
      const parts = loaded[1]!.split("/");
      const at = parts.indexOf("code");
      loadingScript = at >= 0 && parts.length > at + 1 ? parts[at + 1]! : null;
      return;
    }
    const missing = MISSING_INCLUDE.exec(line);
    if (missing === null) return;
    const path = missing[1]!;
    if (toldAbout.has(path)) return;
    toldAbout.add(path);

    const verdict = readMissingInclude(path, loadingScript, (name) => {
      const dir = `/home/we/dust/code/${name}`;
      return vfs.isDir(dir) && vfs.walk(dir).length > 0;
    });
    log(verdict.line);
    if (verdict.want === null || verdict.installed) return;

    // Asked for, said, and reported either way. A name the catalogue has
    // never heard of is an answer rather than a silence: it means the
    // script wants something that is not ours to fetch.
    const want = verdict.want;
    void (async () => {
      try {
        const missed = await maiden.want([want], loadingScript ?? "a script");
        if (missed.length > 0) {
          log(
            `\`${want}\` is not in the catalogue and not one of the repositories ` +
              "this build knows by name, so it has to be installed by hand.",
          );
          return;
        }
        log(`fetching \`${want}\` — maiden has it; load the script again when it is done.`);
      } catch (e) {
        log(`\`${want}\` could not be fetched — ${(e as Error).message}`);
      }
    })();
  };

  // E9-117 — THE INTERPRETER IS WASM NOW, SO IT HAS TO BE INSTANTIATED.
  //
  // fengari was a JavaScript module: importing it was having it. PUC Lua
  // 5.3 is 232 KB of wasm (`tools/lua53/build.sh`) and comes up
  // asynchronously, which is the one line the port costs its callers.
  //
  // Before `createHost` rather than beside it, because every `luaL_newstate`
  // after this point would otherwise raise — and here rather than at the top
  // of `main`, so the lines above it still run while it instantiates.
  await initLua();
  log(`booting norns… (${luaVersion()})`);
  const host: Host = createHost({
    sources: nornsSources,
    onPrint: (l) => {
      log(l);
      watchIncludes(l);
    },
    vfs,
    // The OTHER door. `registerFs` below covers what norns core asks for
    // through `_norns.execute`; this one covers a script's own `os.execute`
    // and `io.popen`, which reported nothing at all until E9-12.
    onShellRefused: refused,
    onShellFetch: startFetch,
  });
  screen.register(host.registry);
  registerFs(host.registry, vfs, {
    onRefused: refused,
    onFetch: startFetch,
    onSystemAction: (action, outcome) => log(`${action}: ${outcome}`),
    // SELECT answers asynchronously and norns redraws when it does, but the
    // redraw metro is E3, so the page asks for one itself.
    onChanged: () => void (dirty = true),
    /**
     * E9-135 — FLUSH, THEN GO.
     *
     * `_norns.restart` clears the script and saves `system.state` in the
     * instant before this runs, and that save only reaches the overlay.
     * The mirror is debounced by 150 ms and the reload was at 50, so the
     * write lost by 100 ms every time: the page came back, restored the
     * PREVIOUS `system.state` from OPFS, found the script still named in
     * it, and resumed into it. Reported from a Pixel as a restart that
     * does not restart.
     *
     * `flush()` cancels the debounce and settles the write — it exists
     * for exactly this, "for tests and for a quit". `finally`, not
     * `then`: a storage error is a reason to lose the state, never a
     * reason to leave the machine with a dead screen and no way back.
     */
    reload: () => {
      void mirror.flush().finally(() => globalThis.location?.reload());
    },
  });

  // E5-24 — the last fifteen of the 178.
  //
  // The screen's image and PNG family, built on peek and poke because there
  // is no emscripten here to add exports to the screen module.
  /**
   * Ask for a redraw from something that is not Lua.
   *
   * `dirty` is declared above but the present loop that reads it is set up
   * after boot, and these registrations happen before it; an indirection is
   * cheaper than moving the boot.
   */
  const dirtyFlag = (): void => void (dirty = true);
  /** Set once `makeCallbacks` has run, which is after boot. */
  let cbReady: ReturnType<typeof makeCallbacks> | null = null;
  const cbLater = (): ReturnType<typeof makeCallbacks> | null => cbReady;
  registerScreenImages(host.registry, {
    screen,
    vfs,
    log: (l) => log(l),
    // A PNG decodes after the frame that asked for it. Without this, a
    // script that drew its picture once in `init` would never show it.
    onChanged: () => dirtyFlag(),
  });

  // What machine we say we are, and the two numbers `menu/home.lua` does
  // arithmetic on. `croneLoad` is read through a closure because the audio
  // thread comes up long after this.
  let audioLoad: { meanMs: number; budgetMs: number } | null = null;
  /** When `profile_mark` last reported, so a phase knows its own length. E9-176. */
  let markAt = performance.now();
  /** The battery as last heard, for a profile to print beside its speed. E9-200. */
  let batteryNote = "battery: no reading";
  const hardware: Hardware = registerHardware(host.registry, {
    load: () => audioLoad,
    log: (l) => log(l),
  });

  // OSC leaves through a relay or it does not leave: a browser has no UDP.
  const oscRelayUrl = new URLSearchParams(location.search).get("osc-relay");
  const oscRemote =
    oscRelayUrl !== null && oscRelayUrl !== ""
      ? new OscRemote({
          url: oscRelayUrl,
          onEvent: (path, args, from) => {
            cbLater()?.oscEvent(path, [...args], [...from]);
            dirtyFlag();
          },
          log: (l) => log(l),
        })
      : null;
  registerOsc(host.registry, { remote: oscRemote, log: (l) => log(l) });

  const err = boot(host, loadConfigWeb());
  if (err) {
    log(`ERROR ${err.step}: ${err.error}`);
    return;
  }

  // The menu pages that cannot do what they offer, told to say so.
  //
  // AFTER boot and not as a patch to norns' own Lua: `_menu.m` is built
  // while `core/menu` is required, so there is nothing to mutate before
  // that, and `src/lua/patches.ts` is for crashes and hangs rather than
  // for wording. Failing here must not stop the page — a menu that reads
  // slightly wrong is better than no norns at all.
  const menuErr = host.run(menuHereLua, "=(norns-js menu)");
  if (menuErr) log(`menu notes: ${menuErr}`);

  // E9-112 — AFTER `core/screen` EXISTS AND BEFORE ANY SCRIPT RUNS.
  //
  // 31 of norns' 49 `Screen.*` functions are one-line pass-throughs to
  // `_norns`, which on hardware costs fifty nanoseconds and here costs
  // half the call. See the file for the measurements and for the four
  // that are deliberately left alone.
  //
  // Here rather than in a patch to `third_party/`: `src/lua/patches.ts`
  // is for upstream code that CRASHES, by its own stated bar, and this is
  // an optimisation. An assignment after the module has loaded is also
  // the reversible version — delete the import and the wrappers come
  // back.
  const directErr = host.run(screenDirectLua, "=(norns-js screen)");
  if (directErr) log(`screen: ${directErr}`);

  // E9-200 — the two instruments that live on the Lua side of the bridge.
  // Both are `?profile` only: the dispatcher times one call in eight, and
  // `luaprof.lua` wraps `coroutine.create` so a hook can follow a script
  // into its clocks. The hook itself stays off without `&lua`.
  if (profile !== null) {
    host.registry.timing = true;
    const profErr = host.run(luaprofLua, "=(norns-js luaprof)");
    if (profErr) log(`profile: the Lua profiler did not load — ${profErr}`);
    else if (profile.lua) {
      host.run("_njs_prof.start()");
      log("profile: Lua is being sampled (&lua). Costs measured in this session are of a slower interpreter.");
    }
  }

  const cb = makeCallbacks(host.L);
  // The callbacks exist only after boot, and the OSC relay may deliver
  // before then; this is how the handler above reaches them when they do.
  cbReady = cb;

  // --- presentation ------------------------------------------------------
  const screenBox = $("#screen");
  /**
   * The page zoom, for the canvas, through a box rather than a closure.
   *
   * `settings` is built further down — the canvas has to exist before the
   * first frame and the store before the first setting — and a closure over
   * it here would be read at the first `resize()`, which happens between
   * the two. One mutable function, set once the store exists, keeps the
   * canvas zoom-aware without moving either of them.
   */
  let zoomNow = (): number => 1;
  const canvas = createScreenCanvas(screenBox, { zoom: () => zoomNow() });
  const grey = new Uint8Array(128 * 64);

  // THE SCALE HAS TO FOLLOW THE WELL. The screen is sized to the largest
  // whole multiple of 128x64 that fits its container, and the container is a
  // percentage of a device that resizes with the page -- so a canvas left at
  // the scale it was born with is clipped the moment the window narrows, and
  // what gets clipped is the LEFT of the screen, which is where norns draws
  // almost everything. Resizing a canvas also clears it, hence the redraw.
  const refit = (): void => {
    canvas.resize();
    dirty = true;
  };
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(refit).observe(screenBox);
  } else {
    globalThis.addEventListener("resize", refit);
  }

  /**
   * The veil over the first seconds, and the gesture gate, in one element.
   *
   * A gesture that is needed WINS over loading: the browser can hold the
   * audio engine while the screen is still blank, and a page that says
   * "Loading" while it is in fact waiting for a click waits for ever.
   */
  let painted = false;
  let needsGesture = false;
  const showGate = (): void => {
    const gate = document.querySelector("#gate");
    if (!(gate instanceof HTMLElement)) return;
    gate.dataset["state"] = needsGesture ? "gesture" : painted ? "off" : "loading";
  };
  // A SCREEN THAT NEVER DRAWS MUST NOT LEAVE A BLACK PAGE. If the module
  // fails, nothing ever paints, and an opaque veil would hide the console
  // that says why. This lifts it anyway and says so.
  setTimeout(() => {
    if (painted) return;
    painted = true;
    showGate();
    log("the screen has not drawn anything yet; showing the page regardless");
  }, 45_000);

  /**
   * A Steam Deck's controls, polled.
   *
   * The Gamepad API has no events for sticks: a pad is READ, once a frame,
   * and the frame loop is already here. It stays null on every other
   * machine, so nothing is polled that nobody asked for.
   */
  let pad: PadCore | null = null;
  let padAt = 0;
  const padFrame = (now: number): void => {
    if (pad === null) return;
    const dt = padAt === 0 ? 16 : Math.min(100, now - padAt);
    padAt = now;
    for (const a of pad.frame(readPad(), dt)) {
      if (a.a === "key") onKeyIn(a.n, a.z);
      else onEncIn(a.n, a.delta);
    }
  };

  /**
   * THE GLOBAL `refresh()`, which matron fires at 60 Hz and we never did.
   *
   * `ssd1322_thread_run` posts `EVENT_SCREEN_REFRESH` every 16.6 ms, and
   * `w_handle_screen_refresh` calls the Lua global `refresh`. On a norns
   * that is a free redraw loop for any script that defines one — and
   * `acrostic` is exactly such a script: `function refresh()` calls
   * `acrostic:update()` and then `redraw()`, and NOTHING ELSE in it ever
   * calls `redraw`. Here its screen was blank from the moment it loaded
   * while the engine played: measured 0 lit pixels, and 489 the instant
   * `redraw()` was called by hand.
   *
   * The callback has existed in `src/norns/callbacks.ts` since E2-04 and
   * nothing drove it. A defined callback nobody calls is the quietest kind
   * of missing feature: every test of it passes.
   *
   * ON A TIMER AND NOT IN THE FRAME LOOP, which is a deliberate difference
   * from `present` below. matron's is a thread: it runs whether or not
   * anybody is looking at the screen. `requestAnimationFrame` stops when
   * the page is not being composited — which is not a theoretical
   * concern, it is how a sweep of 25 scripts came to report four of them
   * frozen. A script's redraw loop must not depend on whether the window
   * is in front.
   *
   * `refresh` is `norns.none` outside play mode, so this costs one Lua
   * call into an empty function for the whole time the menu is up.
   *
   * SIXTY IS MATRON'S OWN NUMBER, and E9-113 went and read it rather than
   * leaving it as ours. `matron/src/hardware/screen/ssd1322.cc` runs a
   * thread whose whole body is
   *
   *     static struct timespec ts = { .tv_sec = 0, .tv_nsec = 16666666 };
   *     while (spidev_buffer) {
   *       if (display_dirty) { ssd1322_refresh(); display_dirty = false; }
   *       event_post(event_data_new(EVENT_SCREEN_REFRESH));
   *       clock_nanosleep(CLOCK_MONOTONIC, 0, &ts, NULL);
   *     }
   *
   * — 16.666 ms, posted every time round and NOT only when the display
   * was dirty, and `w_handle_screen_refresh` calls the Lua global
   * `refresh`. So this interval is a copy of that loop and the rate is not
   * a choice to be tuned. `test/refresh-rate.test.ts` reads that file and
   * fails if the two ever disagree.
   *
   * WHAT IT COSTS, measured (`docs/13-CPU.md` §4): 0.52 ms/s with no
   * `refresh` defined, which is 38 of the 40 bundled scripts, and 19.5
   * ms/s for `dreamsequence`, whose `refresh` is `redraw()` and nothing
   * else. Halving the rate was considered and declined: it would buy
   * about four per cent of a phone's core on one script in twenty, and
   * the four per cent comes out of a frame rate that script's author
   * chose on purpose — the commented-out line above it in
   * `dreamsequence.lua` throttles it to 20 fps and is commented out.
   */
  const REFRESH_MS = 1000 / 60;
  let refreshSaid = false;
  setInterval(() => {
    const err = cb.refresh();
    // ONCE. A script whose `refresh` raises would otherwise write sixty
    // lines a second into the log, which is both useless and slow enough
    // to look like a hang — matron says nothing at all here.
    if (err !== null && !refreshSaid) {
      refreshSaid = true;
      log(`refresh: ${err.message} (said once)`);
    }
  }, REFRESH_MS);

  /**
   * E9-149 — THE FRAME IS TIMED, in the same account as the callbacks.
   *
   * A Pixel log had 17 seconds of a pinned main thread and the callback
   * account came to 978 ms of it — under six per cent — so the line that
   * reports a busy span was naming everything it could and still leaving
   * the answer out. This is where the rest of a frame goes: pulling the
   * cairo surface into a greyscale buffer, and blitting it to a canvas.
   *
   * SEPARATELY, because they are different work and the point is to tell
   * them apart: `screen.greyscale` crosses the wasm boundary for 128x64
   * bytes, `canvas.draw` is a putImageData the browser may or may not
   * accelerate, and `padFrame` runs on EVERY frame whether anything is
   * dirty or not.
   *
   * E9-179 — ONE SIGNAL MARKS THE FRAME, AND IT IS `screen.update()`.
   *
   * This loop was correct and the flag was a lie. Measured on the plain
   * page, at the menu, with no script loaded and nothing touched:
   *
   *     rAF                          31.9 frames/s
   *     draw:canvas                  320 calls in 10.02 s -> every frame
   *     _norns.screen_update (Lua)   10 calls in 5 s      -> 2/s
   *
   * Sixteen blits for every change. `dirty` was being posted by every
   * metro tick, every clock resume, every message from sclang or
   * scsynth and every MIDI event — none of which draw. They call into
   * Lua, and Lua that draws ALWAYS ends in `screen.update()`, which
   * posts the flag through `onUpdate` above. Every one of those marks
   * was redundant with the only one that means anything.
   *
   * What stays, because each is a change the screen module never sees:
   * a cairo trap and rebuild, a canvas resize (which CLEARS it), a PNG
   * that decoded after the frame that asked for it, and the places
   * where norns answers a file selection without redrawing.
   *
   * 0.069 ms a blit here; 0.156 ms on a Pixel 9 Pro, where
   * `draw:canvas` was 636 ms over 4071 calls in `kolor`'s profile — the
   * largest instrumented cost on the machine that matters. A script
   * that genuinely redraws at 30 fps gains nothing. The menu, and every
   * script that redraws only when something changed, stop paying for
   * frames nobody asked for.
   */
  const present = (now: number): void => {
    // E9-200 — how far apart frames really are, while somebody is looking.
    probe?.frame(now);
    timed("draw:pad", () => padFrame(now));
    if (dirty) {
      dirty = false;
      timed("draw:screen", () => screen.greyscale(grey));
      timed("draw:canvas", () => canvas.draw(grey, screen.panel()));
      // THE LOADING VEIL LIFTS ON THE FIRST FRAME THAT HAS SOMETHING IN IT.
      //
      // Not on the first frame: a blank one is still the instrument's
      // furniture with nothing behind it. Not on `audio ready` either, which
      // is a further twenty seconds of staring at a black rectangle when the
      // menu has been usable the whole time. The scan stops happening the
      // moment it succeeds.
      if (!painted) {
        for (const v of grey) {
          if (v !== 0) {
            painted = true;
            showGate();
            break;
          }
        }
      }
    }
    requestAnimationFrame(present);
  };
  requestAnimationFrame(present);

  // --- what this browser remembers (E6-10) --------------------------------
  //
  // Created BEFORE the input, because the input reads the keymap out of it.
  const settings = createSettings(browserStorage());

  // --- which machine this is ----------------------------------------------
  //
  // Detected once: the signals are a user agent, a screen and a gamepad
  // list, and none of them change under a running page. The PREFERENCE can
  // change, so everything downstream is handed a function rather than a
  // value.
  //
  // E9-108 — UP HERE RATHER THAN BESIDE THE STAGE, which is where it was.
  // The grid is attached seven hundred lines above that, and a phone wants
  // a different grid, so the answer has to exist before the question.
  let detected = detect(readSignals());
  const kindNow = (): MachineKind => effectiveKind(settings.machine, detected);

  /**
   * Which norns is drawn, on the element the CSS keys both layouts off.
   *
   * The markup already says `shield`, so this only ever has work to do for
   * somebody who chose the other one — but it has to run before the stage
   * measures anything, because the two bodies have different aspect ratios
   * and the stage lays out from the measured height.
   */
  const applyPanel = (): void => {
    const el = document.getElementById("norns");
    if (el !== null) el.dataset["panel"] = settings.panel;
  };
  applyPanel();
  log(
    `machine: ${kindNow()} — ${settings.machine === "auto" ? detected.why : "set in the gear"}` +
      `, body: ${settings.panel}`,
  );
  zoomNow = (): number => settings.zoom;

  /**
   * E9-61 — ONE ZOOM, for the whole page.
   *
   * It used to scale the devices on the stage and nothing else, so maiden,
   * the rail and every panel stayed the size they were. `zoom` on the root
   * is the browser's own: it is a LAYOUT scale, not a transform, so hit
   * testing, scrolling and text rendering all follow, and the editor's text
   * grows with the instrument.
   *
   * The screen canvas divides it back out (see `zoom` in CanvasOptions), so
   * 128x64 still lands on whole device pixels.
   */
  const applyZoom = (): void => {
    const z = settings.zoom;
    document.documentElement.style.zoom = z === 1 ? "" : String(z);
  };
  applyZoom();
  /** Set once the stage exists; until then nothing can be arranging. */
  let stage: Stage | null = null;
  /**
   * True while the community dialogue is up.
   *
   * It takes the keyboard: Escape is K2 on a norns and the digits are the
   * three keys, so a dialogue that let them through would have the user
   * playing an instrument they cannot see while typing a search.
   */
  let dialogOpen = false;
  /**
   * Set once the audio graph exists. Until then there is nothing to mute,
   * and the toolbar button has to work anyway — it is the first thing
   * someone reaches for, and a button that silently does nothing until the
   * engine happens to be up is worse than no button.
   */
  let applyMute: (muted: boolean) => void = () => {};

  // --- a restart that is owed (E9-17) -------------------------------------
  //
  // sclang compiles its class library ONCE, at boot, from whatever is in
  // `~/dust/code` at that moment. So a SuperCollider class that arrives
  // afterwards — installed with a script, or saved in the editor — is on
  // disk and was never built, and the script that wants it loads, draws,
  // and has no engine. Nothing else needs a restart: SELECT re-reads the
  // tree on every scan, so Lua is ready at once.
  //
  // THE PAGE REMEMBERS WHAT IT OWES, rather than leaving a sentence behind
  // in a panel. The names are kept because "restart" with no reason is a
  // button people learn to ignore.
  const restartOwed = new Set<string>();
  /** Answered "later": do not ask again until something new earns it. */
  let restartDeferred = false;
  let markRestart: () => void = () => {};

  const restartEarned = (why: string): void => {
    restartOwed.add(why);
    restartDeferred = false;
    markRestart();
  };

  /**
   * Restart the way the menu does, and not with a bare reload.
   *
   * `_norns.restart` runs the shutdown hooks, clears the script, marks the
   * shutdown CLEAN, saves the state, and mutes the DAC before asking for
   * the reset (core/norns.lua:248). A bare reload skips all five.
   *
   * E9-135 — AND THE REASON IS NOT THE ONE THIS SAID. It used to claim a
   * bare reload "comes back to an empty SELECT and looks like it lost your
   * work", as though the full restart came back into the script. It does
   * not, and should not: `script.clear()` runs BEFORE the state is saved,
   * so both paths come up empty. What the five steps actually buy is that
   * the script is told — `cleanup()` runs, which is where a script writes
   * what it was holding — the DAC is muted rather than cut, and the state
   * on disk describes a machine that was shut down rather than one that
   * stopped mid-sentence.
   */
  const doRestart = (): void => {
    log("restart: asked from the rail");
    host.run("if _norns and _norns.restart then _norns.restart() end");
  };

  // --- the sound cards (E9-15) -------------------------------------------
  //
  // DECLARED HERE, FILLED IN WHEN THE AUDIO GRAPH EXISTS. The gear is built
  // long before scsynth and crone are up — a panel that waited for them
  // would be a page with no settings until the engine booted, and the
  // engine is the thing you most want settings for when it does not boot.
  // So the panel gets functions, and the functions find out whether there
  // is anything to talk to yet.
  let audioContext: AudioContext | null = null;

  /**
   * E9-182 — WHEN THE PAGE CANNOT KEEP TIME, STOP RATHER THAN PLAY WRONG.
   *
   * A page that is not being painted is not necessarily a page that has
   * stopped, and the difference is worth measuring before acting on it.
   * In this app's own browser pane, with the tab behind another:
   *
   *     requestAnimationFrame    0 per second
   *     setInterval(16 ms)       62.5 per second — not throttled at all
   *     metro at 20 Hz           160 callbacks in 8.02 s, exact
   *     document.hidden          false
   *
   * Everything carries on, so nothing should be stopped. A page the
   * browser has genuinely HIDDEN is the other case: timers there are
   * throttled to roughly one wake-up a second, and twenty metro ticks a
   * second cannot be delivered by a thread that wakes once. The audio
   * thread meanwhile keeps perfect time, so the result is a sequencer
   * running at a twentieth of its tempo with the backlog piling up
   * behind it — unstacked at speed on the way back before E9-182 made
   * the clock skip instead of replay.
   *
   * So this does not act on `document.hidden`. It acts on the rate the
   * page is actually being woken at, which is the thing that matters and
   * the only one of the two that is a measurement. If the wake-ups are
   * still coming, nothing happens at all.
   *
   * Suspending is what stops it: the audio thread stops counting, so no
   * backlog forms, no metro is due on the way back, and the clock
   * resumes where it left off instead of somewhere it never was. It also
   * reports a stall on resume, which is true — audio time did stop.
   */
  const wakeups = createWakeupWatch();
  let hiddenWatch: ReturnType<typeof setInterval> | null = null;
  const stopWatchingWakeups = (): void => {
    if (hiddenWatch === null) return;
    clearInterval(hiddenWatch);
    hiddenWatch = null;
  };
  const onPageHidden = (): void => {
    stopWatchingWakeups();
    wakeups.away(performance.now());
    hiddenWatch = setInterval(() => {
      const gap = wakeups.tick(performance.now());
      // Still being serviced. Leave the instrument playing.
      if (gap === null) return;
      stopWatchingWakeups();
      const ctx = audioContext;
      if (ctx === null || ctx.state !== "running") return;
      log(
        `audio: this page is only being woken every ${(gap / 1000).toFixed(1)} s while it is ` +
          `hidden, which is too seldom to keep time — stopping the sound until it comes back ` +
          `rather than playing it out of tempo`,
      );
      void Promise.resolve(ctx.suspend()).catch(() => {});
    }, 200);
  };
  const onPageVisible = (): void => {
    stopWatchingWakeups();
    if (!wakeups.back()) return;
    const ctx = audioContext;
    if (ctx === null) return;
    log("audio: the page is back — starting the sound again");
    void Promise.resolve(ctx.resume()).catch(() => {});
  };
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (globalThis.document?.hidden === true) onPageHidden();
    else onPageVisible();
  });

  /**
   * E9-163 — HOW LATE THE SOUND IS, WHICH NOTHING HERE HAS EVER ASKED.
   *
   * The project measures the main thread, the callbacks into Lua, the
   * frames and now the audio thread's own load. It has never once asked
   * the browser how long a sample takes to get from the graph to a
   * speaker — and on a phone that is routinely tens of milliseconds,
   * sometimes over a hundred. It is a floor under every gesture: a key
   * pressed on the grid cannot sound sooner than this no matter how
   * fast everything above it gets, so optimising the page without
   * knowing it is working on the wrong end.
   *
   * TWO NUMBERS AND THEY MEAN DIFFERENT THINGS. `baseLatency` is what
   * the AudioContext itself adds — the render quantum, essentially a
   * property of the graph. `outputLatency` is the browser's estimate of
   * everything after it, down through the OS mixer to the device, which
   * is where Bluetooth headphones put their eighty milliseconds.
   *
   * REPORTED TWICE, because the second is not known yet when the first
   * is. `outputLatency` reads 0 until audio has actually flowed, so a
   * single reading at adoption would report the interesting half as
   * zero and look like good news.
   */
  const reportAudioLatency = (ctx: AudioContext): void => {
    const base = typeof ctx.baseLatency === "number" ? ctx.baseLatency : 0;
    log(describeGraphLatency(base, ctx.sampleRate));
    // The device's share, once something has gone through it. Six
    // seconds is past the boot and past the first sound; one look, and
    // a line of its own if the browser never fills it in.
    setTimeout(() => {
      const out = typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0;
      log(describeDeviceLatency(base, out));
    }, 6000);
  };

  /** Where a microphone goes: crone's input 1, which IS the adc (processor.js:16). */
  let adcInput: AudioNode | null = null;
  let liveInput: Awaited<ReturnType<typeof openAudioInput>> | null = null;
  /** What went wrong last, shown under the pickers rather than only logged. */
  let audioError = "";
  /** The live Web MIDI access, once it exists. Null before, and when refused. */
  let webMidiAccess: Awaited<ReturnType<typeof startWebMidi>> = null;

  /**
   * Every MIDI port, for the gear to show.
   *
   * READ FROM THE LIVE `MIDIAccess`, not from the device manager: the
   * manager keeps norns DEVICES, which are bidirectional vports paired by
   * name, and the question the gear is opened for is the other one — is
   * this interface detected at all, in which direction, and under what
   * name. A virtual device of our own has no Web MIDI port and is listed
   * from the manager instead, because it is still something you can play.
   */
  const listMidiPorts = (): { name: string; direction: string }[] => {
    const out: { name: string; direction: string }[] = [];
    const seen = new Set<string>();
    const access = webMidiAccess;
    if (access !== null) {
      for (const p of access.ports()) {
        out.push(p);
        seen.add(p.name);
      }
    }
    for (const d of midiManager.descriptors()) {
      if (!seen.has(d.name)) out.push({ name: d.name, direction: "here" });
    }
    return out;
  };

  const applyOutputDevice = async (): Promise<void> => {
    if (!audioContext) return;
    const r = await setOutputDevice(audioContext, settings.audioOut);
    audioError = r.ok ? "" : (r.why ?? "the output could not be changed");
    if (r.ok) log(`audio out: ${settings.audioOut === "" ? "system default" : "chosen device"}`);
    else log(`audio out: ${audioError}`);
  };

  const applyInputDevice = async (): Promise<void> => {
    // ALWAYS STOPPED FIRST, even when turning it on with a new device: two
    // live capture streams into one input is two microphones summed, and
    // the second would be the only one anybody noticed.
    if (liveInput) {
      liveInput.stop();
      liveInput = null;
    }
    if (!settings.audioInOn || !audioContext || !adcInput) {
      if (settings.audioInOn && !adcInput) {
        audioError = "the mixer is not up; there is nowhere for an input to go";
      }
      return;
    }
    try {
      liveInput = await openAudioInput({
        context: audioContext,
        destination: adcInput,
        destinationInput: 1,
        deviceId: settings.audioIn,
        log: (l) => log(l),
      });
      audioError = "";
    } catch (e) {
      const err = e as Error;
      // `OverconstrainedError` is the device being gone, which is the one
      // worth naming: the picker is offering something that is not there.
      audioError = `${err.name}: ${err.message}`;
      log(`audio in: ${audioError}`);
      settings.setAudio({ inOn: false });
    }
  };

  // --- input -------------------------------------------------------------
  //
  // Named, because a Steam Deck's gamepad arrives through the frame loop
  // rather than through an event and has to land in exactly the same place:
  // one path to norns, whatever moved.
  function onKeyIn(n: Side, z: 0 | 1): void {
    const e = cb.key(n, z);
    if (e) log(`key error: ${e.message}`);
    dirty = true;
    $(`#k${n}`).classList.toggle("down", z === 1);
  }
  function onEncIn(n: Side, delta: number): void {
    const e = cb.enc(n, delta);
    if (e) log(`enc error: ${e.message}`);
    dirty = true;
    showTurn(n, delta);
  }

  const input = createInput({
    // The user's map, asked for on every keystroke so a rebind takes effect
    // at once. While the devices are being arranged the map is EMPTY, which
    // is how the arrows nudge a device instead of turning E2 and E3.
    keymap: () => (stage?.arranging || dialogOpen ? {} : settings.keymap),
    // Read per event, so moving the slider changes the feel under the
    // user's hand rather than at the next page load.
    sensitivity: () => settings.encoderSensitivity,
    onKey: (n, z) => onKeyIn(n, z),
    onEnc: (n, delta) => onEncIn(n, delta),
  });

  /**
   * SHOW THAT AN ENCODER TURNED, as a gesture and not as a position.
   *
   * A norns encoder carries no mark: it is a smooth cap on a detented
   * shaft, and you FEEL the turn. So nothing drawn here may look like a
   * pointer. What is drawn is an arc from twelve o'clock round to where the
   * turn has reached, which fades as soon as the hand stops.
   *
   * It exists because a screen gives nothing back: a turn that a script
   * ignores looks exactly like a page that stopped listening, and the arc
   * is the one answer to that. `_norns.enc` carries a RELATIVE movement and
   * nothing in the protocol says where a knob is, so the angle below is an
   * accumulator for the eye and is reset the moment the gesture ends.
   */
  const turnAngle = new Map<number, number>();
  const turnTimer = new Map<number, number>();
  const turnArt = new Map<number, SVGPathElement>();

  /** The arc path, in a 100x100 box, clockwise from the top for a > 0. */
  const arcPath = (degrees: number): string => {
    const R = 39;
    const C = 50;
    // A full turn cannot be drawn as one arc (start and end coincide), and
    // beyond one turn there is nothing more to say: the ring is the most
    // the gesture can read as.
    const a = Math.max(-359.9, Math.min(359.9, degrees));
    const rad = ((a - 90) * Math.PI) / 180;
    const x = C + Math.cos(rad) * R;
    const y = C + Math.sin(rad) * R;
    const large = Math.abs(a) > 180 ? 1 : 0;
    const sweep = a >= 0 ? 1 : 0;
    return `M ${C} ${C - R} A ${R} ${R} 0 ${large} ${sweep} ${x.toFixed(2)} ${y.toFixed(2)}`;
  };

  const turnArc = (n: 1 | 2 | 3): SVGPathElement | null => {
    const existing = turnArt.get(n);
    if (existing) return existing;
    const host = document.querySelector<HTMLElement>(`#e${n}`);
    if (!host) return null;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "turn");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(path);
    host.append(svg);
    turnArt.set(n, path);
    return path;
  };

  const showTurn = (n: 1 | 2 | 3, delta: number): void => {
    const host = document.querySelector<HTMLElement>(`#e${n}`);
    const path = turnArc(n);
    if (!host || !path) return;
    // Six degrees a tick: a detent's worth, and sixty ticks make a turn.
    const next = (turnAngle.get(n) ?? 0) + delta * 6;
    turnAngle.set(n, next);
    path.setAttribute("d", arcPath(next));
    host.classList.add("turning");
    const prev = turnTimer.get(n);
    if (prev !== undefined) clearTimeout(prev);
    turnTimer.set(
      n,
      window.setTimeout(() => {
        host.classList.remove("turning");
        turnTimer.delete(n);
        // The gesture is over, so the next one starts from the top again.
        // Keeping the angle would make the arc a position, which is the one
        // thing it must not be.
        turnAngle.delete(n);
      }, 320),
    );
  };

  input.bindKeyboard(window);
  input.bindScreen(canvas.canvas);
  for (const n of [1, 2, 3] as const) {
    input.bindEncoder($(`#e${n}`), n);
    input.bindKey($(`#k${n}`), n);
  }

  // The redraw norns does on its own is driven by metros we have not got yet
  // (E3), so the page asks for one after every input. Until then the screen
  // only changes when something is pressed, which is honest rather than
  // frozen.
  const redraw = (): void => {
    host.run(`if _menu.mode then _menu.redraw() end`);
  };
  window.addEventListener("keyup", redraw);
  window.addEventListener("keydown", redraw);
  window.addEventListener("pointerup", redraw);
  window.addEventListener("wheel", redraw, { passive: true });

  host.run(`_menu.redraw()`);

  // --- the stat line (E5-24) ---------------------------------------------
  //
  // `_norns.stat(disk, temp, cpu, cpu1..4)` is a matron CALLBACK, not one of
  // the 178 functions, which is why it was still missing after the surface
  // was complete: matron polls /proc once a second and calls it, and nothing
  // here was playing that part. `norns.cpu` therefore stayed nil, and
  // pressing K2 on the main menu — which toggles `_menu.showstats` — raised
  // `core/menu/home.lua:51: attempt to index a nil value (field 'cpu')`.
  // Measured, both before and after.
  //
  // Only ONE of the seven numbers can be real. A browser has no per-core CPU
  // load and no temperature sensor, and a zero for either is not "unknown",
  // it reads as an idle machine running cold -- so the menu overlay in
  // src/lua/norns-js/menu-here.lua replaces those five with a mark that
  // cannot be mistaken for a reading. Free disk space it does have:
  // `navigator.storage.estimate()` is the quota this origin may still use,
  // which is exactly what "disk" means to someone deciding whether a tape
  // recording will fit.
  /**
   * E9-112 — how busy the main thread is, left running for ever.
   *
   * One timer and a subtraction; see `src/ui/cpu-meter.ts` for why it is
   * lateness rather than instrumentation, and `docs/13-CPU.md` for what it
   * was measured against.
   */
  const cpuMeter = startCpuMeter();
  // E9-200 — the same timer, read tick by tick when a profile wants the
  // shape of the lateness and not only its share of a second.
  if (probe !== null) cpuMeter.watch((lateMs) => probe.timerLate(lateMs));
  /** Hysteresis for the two lines below; see `pollStat`. */
  let cpuBusy = false;
  /** When the busy span started, for the duration it reports. */
  let cpuBusyAt = 0;
  /** When it last said anything, so a span that never ends still reports. */
  let cpuSaidAt = 0;

  /**
   * E9-162 — THE TWO PLACES THE COST CAN BE THAT ARE NOT OUR JAVASCRIPT.
   *
   * The first is the main thread doing work no script asked for — style,
   * layout, paint, garbage collection — which `ui/frames.ts` gets from
   * the browser's own long-frame reports.
   *
   * The second is not the main thread at all. scsynth and the six
   * softcut voices run in an audio worklet, which has no
   * `performance.now()` and cannot be measured from here at all; the CPU
   * meter would nonetheless read high, because a saturated audio thread
   * on a phone takes a core the main thread then waits for. But scsynth
   * MEASURES ITSELF and has been answering `/status` once a second since
   * E9-112 — the number was going into `audio_get_cpu_load` and nowhere a
   * log could show it.
   *
   * NO LONG FRAMES PLUS A LOADED AUDIO THREAD IS AN ANSWER, and until
   * now there was no way to write it down.
   */
  let audioStatus: () => {
    avgCpu: number;
    peakCpu: number;
    ugens: number;
    synths: number;
    at: number;
  } | null = () => null;

  /**
   * E9-166 — WHERE THE SOUND STOPS, read from crone's own VU.
   *
   * Folded over three-second windows rather than judged per poll: the
   * levels arrive every 50 ms, a single flat reading means nothing at
   * all, and a window is short enough that a person pressing a key and
   * hearing nothing gets an answer while they are still looking at it.
   *
   * SAID ONCE, NOT SIXTY TIMES. A page in this state stays in it, so the
   * same sentence every three seconds would bury the log it exists to
   * explain — the same reasoning as `call-cost.ts`'s quiet period, and
   * the same mistake was available here. It speaks when the verdict
   * CHANGES, and says so again at most every thirty seconds.
   */
  let vuWindow = emptyVu();
  let vuLast = emptyVu();
  /**
   * E9-180 — A PHASE'S LEVEL IS THE PEAK OVER THAT PHASE.
   *
   * Separate from the three-second judging window because it answers a
   * different question. `profile_mark` reported `describeVu(vuLast)`,
   * and `vuLast` is the previous COMPLETED window: it ends somewhere
   * between nought and three seconds before the mark, and the bench
   * marks at a phase boundary immediately after `stop_all()` has
   * silenced the phase. So the line could report a stretch of time the
   * phase did not cover, and did: the engine phase was written up as
   * "a stock engine that loads and makes no sound" on the strength of
   * it. Driven by hand and from a metro at the bench's own 20/s,
   * `PolyPerc` reaches peak 0.159 and takes the server from 8 synths
   * to 19. It sounds. The instrument was reading the wrong window.
   *
   * Folded by the same `foldVu`, so this is the same maxima over a
   * different span, and reset by the mark rather than by the clock.
   */
  let vuPhase = emptyVu();
  /**
   * E9-183 — what the AUDIO thread cost over a phase.
   *
   * The companion to `vuPhase`: that one says how loud the span was,
   * this one says what rendering it cost the thread that is not being
   * measured by anything else. Both are reset by the mark.
   */
  let dspPhase = emptyAudioLoad();
  /** Where the OSC counters stood at the last mark. E9-197. */
  let oscReadAt = 0;
  let oscRelayedAt = 0;
  let oscSeen = 0;
  /** `/status.reply` timestamps already folded, so a poll counts once. */
  let scStatusAt = 0;
  let vuQuietSince = 0;
  let vuSaid = "";
  let vuSaidAt = -Infinity;
  /** Set by the first poll crone ever sends, and never cleared. */
  let vuHeardEver = false;

  /**
   * E9-169 — THE JUDGE RUNS ON A CLOCK, NOT ON THE SIGNAL IT JUDGES.
   *
   * The first version did all of this inside the VU handler, which made
   * it deaf to exactly one thing: the VU polls stopping. No polls meant
   * the handler never ran, so nothing was ever judged, so the branch
   * that exists to report "crone has stopped reporting its levels"
   * could not be reached. The instrument was blind in the one direction
   * it was built to look.
   *
   * Found in a log from a silent `amen` where every other new line
   * worked — master at 0 dB, context running, one scsynth output routed
   * through the mixer — and the watcher said nothing at all. A watcher
   * that is silent when its subject is absent is indistinguishable from
   * one that is silent because all is well, which is the worst thing an
   * instrument can be.
   *
   * NOT BEFORE CRONE HAS EVER SPOKEN. Until the first poll arrives
   * there is no audio thread yet and its silence is the boot, not a
   * fault. After that, silence is news.
   */
  const watchVu = (levels: readonly number[]): void => {
    if (foldVu(vuWindow, levels)) vuHeardEver = true;
    // Same reading, second span. A reading that is not twelve numbers is
    // refused by both, so the two cannot disagree about what arrived.
    foldVu(vuPhase, levels);
  };

  const judgeWindow = (): void => {
    if (!vuHeardEver) return;
    const now = performance.now();
    if (vuQuietSince === 0) vuQuietSince = now;
    if (vuWindow.outMax > 0) vuQuietSince = now;
    const verdict = judgeVu(vuWindow, scriptIsLoaded, now - vuQuietSince);
    vuLast = vuWindow;
    vuWindow = emptyVu();
    if (verdict === null) {
      // Coming back is worth one line, because a log that only ever
      // reports trouble cannot be used to tell when it stopped.
      if (vuSaid !== "") log(`audio: output is flowing again — ${describeVu(vuLast)}`);
      vuSaid = "";
      return;
    }
    // E9-172 — ON THE KIND, NOT THE SENTENCE. The sentence carries an
    // elapsed time, so it is never equal to the last one and this quiet
    // period never once applied: a log from a silent `amen` carried
    // fifty copies of one finding, three seconds apart.
    if (verdict.kind === vuSaid && now - vuSaidAt < 30000) return;
    vuSaid = verdict.kind;
    vuSaidAt = now;
    log(verdict.line);
  };
  setInterval(judgeWindow, 3000);

  /**
   * E9-166 — EVERYTHING AT ONCE, because a phone has no console.
   *
   * Three rounds of a silent script were spent asking for one number at
   * a time and waiting for a reply. On a desktop that is a console
   * paste; on the Pixel the console is not reachable at all, and the
   * log IS the channel — it is already what gets copied and sent.
   *
   * So `?diagnose` prints the whole state as a block, and
   * `__norns.diagnose()` does the same from a console that has one.
   */
  const diagnose = (): string => {
    /**
     * E9-170 — IT GOES WHEREVER THE READER IS LOOKING.
     *
     * The first version only wrote to the page's log. Somebody typed
     * `__norns.diagnose()` in the devtools console, saw `undefined`
     * printed back, and reported that it did not work — while the
     * block sat at the bottom of the log pane behind the console. Both
     * halves of that are my doing: a command typed in a console that
     * answers somewhere else has not worked, whatever it did.
     *
     * So the lines go to the page log (which is what gets copied off a
     * phone), to `console.log` (which is where somebody who typed this
     * is looking), and back as the return value (so a console that
     * prints return values shows it too).
     */
    const lines: string[] = [];
    const say = (l: string): void => {
      lines.push(l);
      log(l);
    };
    say("— diagnosis ——————————————————————————————");
    say(`build ${__BUILD_ID__}`);
    const st = audioStatus();
    say(
      `audio: master ${settings.muted ? "MUTED" : `${settings.volumeDb} dB`}` +
        `, context ${audioContext?.state ?? "none"}` +
        `, ${audioContext ? Math.round(audioContext.sampleRate) : 0} Hz`,
    );
    /**
     * E9-169 — WITH THE NUMBER OF READINGS BEHIND IT.
     *
     * "all zero" and "nobody said anything" print identically without
     * it, and they mean opposite things: one is a mixer passing
     * silence, the other is an audio thread that has stopped talking.
     */
    say(
      `crone vu (last 3 s, ${vuLast.polls} reading(s)): ${describeVu(vuLast)}` +
        (vuHeardEver ? "" : " — crone has never reported a level"),
    );
    say(
      `scsynth: ${st === null ? "no /status reply yet" : `${st.avgCpu.toFixed(0)}% avg, ${st.peakCpu.toFixed(0)}% peak, ${st.synths} synths, ${st.ugens} ugens`}`,
    );
    const l = audioLoad;
    say(
      `crone dsp: ${l === null ? "nothing reported yet" : `${l.meanMs.toFixed(2)} ms of ${l.budgetMs.toFixed(2)} ms a block`}`,
    );
    say(`script loaded: ${scriptIsLoaded ? "yes" : "no"}`);
    say(`cpu: ${Math.round(cpuMeter.percent)}% of the main thread, ${cpuMeter.windows} window(s) measured`);
    const frames = describeFrames(frameLoad.load());
    say(frames ?? "frames: none over 50 ms");
    const costs = callCosts().filter((c) => c.ms >= 1);
    say(
      costs.length === 0
        ? "instrumented: nothing has cost a millisecond"
        : `instrumented: ${costs
            .slice(0, 5)
            .map((c) => `${c.path} ${sayCost(c)} over ${c.calls}`)
            .join(" · ")}`,
    );
    say(`storage: ${vfs.walk("/home/we/dust").length} file(s) under ~/dust`);
    say(`drawing at ${drawingRatio()}x (device ${globalThis.devicePixelRatio ?? 1}x)`);
    say("————————————————————————————————————————");
    const block = lines.join("\n");
    // eslint-disable-next-line no-console
    console.log(block);
    return block;
  };

  const reportFrames = (): void => {
    const line = describeFrames(frameLoad.load());
    log(
      line ??
        "frames: none over 50 ms — whatever held the thread, it was not " +
          "a long frame on it",
    );
    // Read through a function set later, NOT `scEngine` directly: that is
    // a `let` declared a thousand lines below, and the busiest moment this
    // page has is the boot that happens before it — so a span that opened
    // during the boot would reach it in its temporal dead zone and take
    // the whole stat poll down with it. The same trap `pollServer` below
    // carries a comment about, and the same answer.
    const st = audioStatus();
    if (st !== null && st.at > 0) {
      log(
        `audio thread: scsynth says ${st.avgCpu.toFixed(0)}% average, ` +
          `${st.peakCpu.toFixed(0)}% peak, ${st.synths} synths and ${st.ugens} ugens ` +
          `— measured by the server, not by this page`,
      );
    }
  };

  /**
   * Ask the audio server for its load, once there is one.
   *
   * A FUNCTION SET LATER, not a reference to `scEngine`: that is a `let`
   * declared a thousand lines below, and `pollStat` runs immediately — so
   * naming it here is a temporal dead zone and the boot dies with
   * `Cannot access 'scEngine' before initialization`, which is what the
   * first draft of this did. Measured by the page failing to start.
   */
  let pollServer: () => void = () => {};

  let freeMb = 0;
  const pollStat = (): void => {
    void navigator.storage
      ?.estimate?.()
      .then((e) => {
        const quota = e.quota ?? 0;
        const usage = e.usage ?? 0;
        freeMb = Math.max(0, Math.round((quota - usage) / (1024 * 1024)));
      })
      .catch(() => {});
    // E9-112 — THE THREE READINGS norns DRAWS, AND THEY WERE ALL ZERO.
    //
    // Its home overlay (K2 on the menu, `core/menu/home.lua:40`) draws
    // `norns.cpu[1..4]`, `_norns.audio_get_cpu_load()` and
    // `_norns.audio_get_xrun_count()`. All three were dead here: four
    // zeros sent from this line, and two stubs. A phone was taken to its
    // knees by one script and the instrument reported a machine at rest
    // — measured afterwards at 15-21% of a desktop core, which is 60-85%
    // of a phone's. See `docs/13-CPU.md`.
    //
    // `cpu[1]` IS THE ONLY ONE FILLED, and the other three stay zero
    // rather than repeating it. On hardware they are four cores of a Pi;
    // here there is one main thread, and no browser reports per-core load.
    // Four copies of one number would read as four cores at that load.
    // The WORST window since the last poll, not the last one: these two
    // clocks drift, and the window that is lost when they do is always
    // the busy one. See `peakSince`. E9-162.
    const main = Math.round(cpuMeter.peakSince());
    /**
     * E9-138 — AND IT GOES IN THE LOG, not only on the home overlay.
     *
     * The reading has existed since E9-112 and lived in two places a
     * struggling page cannot show you: `norns.cpu[1]`, drawn on an
     * overlay four presses into a menu, and a stat callback. A log sent
     * from a phone that was crawling therefore contained no CPU figure at
     * all.
     *
     * TWO THRESHOLDS, NOT ONE, because a single one chatters: a page
     * sitting at the line would print every second. It says so once on
     * the way up and once on the way back down, so the log carries the
     * span rather than a column of numbers.
     */
    if (!cpuBusy && main >= 80) {
      cpuBusy = true;
      cpuBusyAt = performance.now();
      // The account starts with the trouble, so what it reports is what
      // happened DURING it rather than since the page booted.
      resetCallCosts();
      frameLoad.reset();
      cpuSaidAt = cpuBusyAt;
      log(`cpu: ${main}% of the main thread — the page is at its limit`);
    } else if (cpuBusy && main < 50) {
      cpuBusy = false;
      /**
       * E9-141 — AND WHERE IT WENT, which the first version could not say.
       *
       * A log from a Pixel showed 91% for fourteen and a half seconds with
       * NOT ONE `slow callback` line in it. That is not a quiet
       * instrument, it is an answer: no single call into Lua reached the
       * 120 ms threshold, so the cost was spread — many small callbacks,
       * or work that is not Lua at all. `call-cost.ts` had been keeping
       * the totals since E9-138 and nothing ever printed them.
       *
       * Three is enough. Sorted by TOTAL rather than worst, because the
       * steady drip is what pins a thread and the one spike is what gets
       * noticed.
       *
       * AND IT SAYS SO WHEN LUA IS NOT THE ANSWER. An empty account over a
       * busy span is the most useful thing this line can report: it rules
       * out every callback at once and sends the next look at drawing,
       * decoding, garbage collection or the browser's own work.
       */
      const spanMs = performance.now() - cpuBusyAt;
      const top = callCosts()
        .filter((c) => c.ms >= 1)
        .slice(0, 4)
        .map((c) => `${c.path} ${sayCost(c)} over ${c.calls}`)
        .join(" · ");
      /**
       * E9-160 — HOW MUCH OF IT IS EXPLAINED, before what explains it.
       *
       * The first span that reported itself named three things adding up
       * to 4.3 seconds of 53.8, and nothing said that. A list of the
       * heaviest instrumented work reads as an answer whether it covers
       * ninety per cent of the span or eight, and the difference is the
       * whole of what the reader needs to know — eight means the answer
       * is somewhere nobody has put a clock, and that is a finding too.
       *
       * The entries are SELF time now (`call-cost.ts`), so they can be
       * summed without counting a callback and the OSC send inside it
       * twice.
       */
      const share = (accountedMs() / Math.max(1, spanMs)) * 100;
      log(
        `cpu: back to ${main}% after ${(spanMs / 1000).toFixed(1)} s — ` +
          `${share.toFixed(0)}% of it accounted for` +
          (top === "" ? ", none of it instrumented" : `: ${top}`),
      );
      reportFrames();
    } else if (cpuBusy && performance.now() - cpuSaidAt >= 15000) {
      /**
       * E9-162 — A PAGE THAT NEVER RECOVERS MUST STILL REPORT.
       *
       * The span line was written for a page that struggles and comes
       * back, and it only prints on the way DOWN. A log from a Pixel
       * playing `kolor` went to 92% at fifty seconds and never dropped
       * below fifty again: the thresholds did exactly what they say, and
       * the account — the one thing that would have named the cost —
       * was never printed at all, for fifty-three seconds of exactly the
       * trouble it exists to explain.
       *
       * The worst case for this instrument is therefore the case it was
       * silent for. Every fifteen seconds of a span that is still going,
       * it says so and empties the account, so a page that stays stuck
       * produces a reading every fifteen seconds instead of one reading
       * never.
       */
      const spanMs = performance.now() - cpuBusyAt;
      const top = callCosts()
        .filter((c) => c.ms >= 1)
        .slice(0, 4)
        .map((c) => `${c.path} ${sayCost(c)} over ${c.calls}`)
        .join(" · ");
      const share = (accountedMs() / Math.max(1, performance.now() - cpuSaidAt)) * 100;
      log(
        `cpu: still ${main}% after ${(spanMs / 1000).toFixed(1)} s — ` +
          `${share.toFixed(0)}% of the last 15 s accounted for` +
          (top === "" ? ", none of it instrumented" : `: ${top}`),
      );
      reportFrames();
      resetCallCosts();
      frameLoad.reset();
      cpuSaidAt = performance.now();
    }
    cb.stat(freeMb, 0, main, main, 0, 0, 0);
    // E9-183 — scsynth's own reading of itself, into the phase window.
    // Keyed on the reply's timestamp so a second that brought no answer
    // does not count the previous one again.
    const sc = audioStatus();
    if (sc !== null && sc.at !== scStatusAt) {
      scStatusAt = sc.at;
      foldScsynth(dspPhase, sc.avgCpu, sc.peakCpu, sc.synths, sc.ugens);
    }
    // One round trip a second, beside the disk poll that was already here.
    // The answer lands in `engine.status` and is read by
    // `audio_get_cpu_load`.
    pollServer();
  };
  pollStat();
  setInterval(pollStat, 1000);
  // Counted here because this is where the clock reports them; read by
  // `audio_get_xrun_count`, which norns' home overlay turns into `!!!`.
  let xruns = 0;
  host.registry.implement("audio_get_xrun_count", () => [xruns]);

  /**
   * E9-182 — what a sleeping page cost, summed and said once it stops.
   *
   * `backlogRuns` counts the drains that found a backlog, not the ticks:
   * a throttled page produces one per wake-up, and sixty log lines
   * saying the same thing is how an instrument buries its own finding.
   */
  let backlogDropped = 0;
  let backlogRuns = 0;
  let backlogAt = 0;
  setInterval(() => {
    if (backlogRuns === 0 || performance.now() - backlogAt < 2000) return;
    log(
      `clock: caught up — ${backlogDropped} metro tick(s) skipped over ` +
        `${backlogRuns} gap(s). Nothing was replayed.`,
    );
    backlogDropped = 0;
    backlogRuns = 0;
  }, 1000);

  /**
   * E9-176 — ONE PHASE'S WORTH OF ACCOUNT, ON REQUEST FROM LUA.
   *
   * `src/lua/norns-js/bench.lua` runs one kind of work at a time —
   * screen, grid, engine, softcut, plain callbacks — and the
   * instruments all report ONE running total. Without a way to clear
   * that total between phases, a sixty-second run produces one blended
   * number and the whole point of the script is lost.
   *
   * So the script says where it is, and this answers with what has been
   * spent since it last said anything: the instrumented account, the
   * levels crone measured, and any long frames. Then it clears all
   * three, so the next phase starts from zero.
   *
   * IT IS NOT FOR SCRIPTS IN GENERAL. Nothing in norns has this; a
   * community script calling it gets a line in the log and no harm.
   * It exists because the alternative is reading a sixty-second total
   * and guessing which phase it came from, which is the mistake this
   * whole file has been correcting for five releases.
   */
  reportPhase = (what: string, fromLua: boolean): void => {
    const from = markAt;
    const spentMs = performance.now() - markAt;
    markAt = performance.now();
    log(`mark: ${what} — ${(spentMs / 1000).toFixed(1)} s`);
    const costs = callCosts().filter((c) => c.ms >= 1);
    log(
      costs.length === 0
        ? "  instrumented: nothing reached a millisecond"
        : `  instrumented: ${costs
            .slice(0, 6)
            .map((c) => `${c.path} ${sayCost(c)} over ${c.calls}`)
            .join(" · ")}`,
    );
    // E9-180 — the peak over THIS phase, and how many polls it is made
    // of. A zero out of 160 readings is a phase that was silent; a zero
    // out of none is a phase whose levels never arrived, and the two
    // were indistinguishable in every reading taken before now.
    log(`  levels: ${describeVu(vuPhase)} — ${vuPhase.polls} reading(s)`);
    vuPhase = emptyVu();
    // E9-183 — the thread that was doing the work the whole time. Six
    // softcut voices used to report `metro 1 ms over 80`, which is the
    // phase timer and nothing else.
    log(`  audio thread: ${describeAudioLoad(dspPhase)}`);
    dspPhase = emptyAudioLoad();
    /**
     * E9-197 — HOW MUCH OF THE OSC THIS SIDE ACTUALLY LOOKS AT.
     *
     * On a Pixel the bench's engine phase carried 327 inbound messages
     * for 159 notes and `osc:from-server` cost 0.25 ms each — a third of
     * what a note costs. All but about nine were `/n_go` and `/n_end`,
     * which nothing here reads. Printed as a pair with `osc:to-sclang`
     * in the instrumented list above, the two together say whether that
     * quarter-millisecond is ours or sclang's.
     */
    const t = scEngine?.transport;
    if (t !== undefined && t.oscRead + t.oscRelayed > oscSeen) {
      const read = t.oscRead - oscReadAt;
      const relayed = t.oscRelayed - oscRelayedAt;
      oscReadAt = t.oscRead;
      oscRelayedAt = t.oscRelayed;
      oscSeen = t.oscRead + t.oscRelayed;
      log(`  osc from the server: ${read} read, ${relayed} relayed without reading`);
    }
    const frames = describeFrames(frameLoad.load());
    log(`  ${frames ?? "frames: none over 50 ms"}`);
    /**
     * E9-200 — AND EVERYTHING ELSE, when a profile is running.
     *
     * Read BEFORE the account is cleared two lines down: the probe prints
     * the same account in full, with the count and the cost of one call
     * for every path and not only the six that reached a millisecond.
     * The span is handed to the sampler too, so the stacks taken inside
     * it are ranked on their own at the end.
     */
    if (probe !== null) {
      for (const line of probe.report()) log(`  ${line}`);
      profileRun?.phase(what, from, markAt);
    }
    resetCallCosts();
    frameLoad.reset();
    // A mark made by Lua is finished by Lua, which prints its own half on
    // the way out (`luaprof.lua`). One made by the page has to ask.
    if (!fromLua && probe !== null) host.run("if _njs_prof then _njs_prof.report() end");
  };
  host.registry.implement("profile_mark", (label) => {
    reportPhase?.(String(label ?? ""), true);
    return [];
  });
  host.registry.implement("profile_probe", (what, n, text) => {
    const name = String(what ?? "");
    if (probeRun === null) log(`probe ${name}: needs ?profile and a running engine`);
    else probeRun(name, Number(n ?? 0), String(text ?? ""));
    return [];
  });

  if (probe !== null && profile !== null) {
    /**
     * E9-200 — A SESSION NOBODY SCRIPTED STILL GETS ITS PHASES.
     *
     * `_bench` and `_cpu` mark their own. Somebody playing `awake` for
     * two minutes does not, and used to get one total for the lot — the
     * blend this whole file keeps having to un-learn. Fifteen seconds
     * without a mark makes one, until the window closes.
     */
    const AUTO_MS = 15_000;
    let autoN = 0;
    const openedAt = performance.now();
    const auto = setInterval(() => {
      if (performance.now() - openedAt > profile.seconds * 1000) {
        clearInterval(auto);
        return;
      }
      // Numbered, because five spans with one name cannot be told apart
      // when the sampler prints a table for each of them at the end.
      if (performance.now() - markAt >= AUTO_MS) reportPhase?.(`auto ${++autoN}, nothing marked for 15 s`, false);
    }, 1000);

    setInterval(() => probe.heapTick(), 500);

    /**
     * HOW LONG AN INPUT WAITED BEFORE ANYTHING HEARD IT.
     *
     * `event.timeStamp` is when the browser received it and this listener
     * is the first thing that can run for it — capture, on the window —
     * so the difference is the time the main thread was busy with
     * something else. That is the lag a hand feels, before a single line
     * of this project has had the chance to add to it.
     */
    for (const type of ["pointerdown", "pointerup", "pointermove", "keydown", "keyup", "wheel"] as const) {
      globalThis.addEventListener?.(
        type,
        (e: Event) => probe.input(type, Math.max(0, performance.now() - e.timeStamp)),
        { capture: true, passive: true },
      );
    }

    /**
     * AND HOW LONG THE ONES THAT TOOK LONG TOOK, from the browser itself.
     * Event Timing reports any interaction over sixteen milliseconds from
     * hardware to the next paint, with the part spent waiting.
     */
    let slow = 0;
    let worstMs = 0;
    let worstWaitMs = 0;
    let worstName = "";
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as Array<PerformanceEntry & { processingStart?: number }>) {
          slow++;
          if (e.duration > worstMs) {
            worstMs = e.duration;
            worstName = e.name;
          }
          const wait = (e.processingStart ?? e.startTime) - e.startTime;
          if (wait > worstWaitMs) worstWaitMs = wait;
        }
      }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
      probeNotes.push(() => {
        const line =
          slow === 0
            ? "events over 16 ms to paint: none"
            : `events over 16 ms to paint: ${slow}, worst ${worstMs.toFixed(0)} ms (${worstName}), ` +
              `worst wait ${worstWaitMs.toFixed(0)} ms`;
        slow = 0;
        worstMs = 0;
        worstWaitMs = 0;
        worstName = "";
        return line;
      });
    } catch {
      probeNotes.push(() => "events over 16 ms to paint: not observable in this browser");
    }

    /**
     * WHETHER THE MACHINE SAYS IT IS HOT. The Compute Pressure API where
     * there is one; the reason a phone that was fast a minute ago is not.
     */
    let pressure = "not reported by this browser";
    let pressureChanges = 0;
    try {
      const PO = (globalThis as unknown as {
        PressureObserver?: new (cb: (r: Array<{ state?: string }>) => void) => {
          observe(source: string, opts?: { sampleInterval?: number }): Promise<void>;
        };
      }).PressureObserver;
      if (typeof PO === "function") {
        pressure = "no reading yet";
        const po = new PO((records) => {
          const state = records[records.length - 1]?.state;
          if (state !== undefined && state !== pressure) {
            pressure = state;
            pressureChanges++;
          }
        });
        void po.observe("cpu", { sampleInterval: 2000 }).catch(() => void (pressure = "refused"));
      }
    } catch {
      /* said as "not reported" */
    }
    probeNotes.push(() => {
      const line = `pressure: ${pressure}${pressureChanges > 1 ? `, changed ${pressureChanges - 1} time(s)` : ""} · ${batteryNote}`;
      pressureChanges = Math.min(pressureChanges, 1);
      return line;
    });
  }

  // --- the battery, when the machine has one -----------------------------
  //
  // SYSTEM > SETTINGS > BATTERY WARNING is a real setting with a real
  // effect — it swaps `screen.update` for the low-battery overlay
  // (norns.lua:106) — and it could never fire, because nothing here ever
  // called `_norns.battery`. On a Steam Deck or a laptop that is a loss:
  // this is a page you run on a handheld, and the warning is exactly the
  // one piece of hardware news worth having.
  //
  // The Battery Status API answers the two things norns asks for. It is
  // also a known fingerprinting surface, which is why Firefox removed it —
  // nothing leaves the machine here, the reading is used to call one Lua
  // function, and a browser that does not offer it simply reports no
  // battery, which is the honest reason for the setting to sit inert.
  //
  // THE SIGN IS THE WHOLE OF `current`. norns reads milliamps; the browser
  // will not say. `_norns.battery` only ever tests `current < 0`, and
  // nothing displays the number — the home screen's battery line is behind
  // `norns.is_norns`, which is false — so a sign is all it can honestly
  // mean, and all that is needed.
  type BatteryLike = {
    level: number;
    charging: boolean;
    addEventListener?: (type: string, fn: () => void) => void;
  };
  const getBattery = (navigator as unknown as { getBattery?: () => Promise<BatteryLike> })
    .getBattery;
  if (typeof getBattery === "function") {
    void getBattery
      .call(navigator)
      .then((b) => {
        const push = (): void => {
          cb.battery(Math.round(b.level * 100), b.charging ? 1 : -1);
          batteryNote = `battery ${Math.round(b.level * 100)}%, ${b.charging ? "charging" : "discharging"}`;
        };
        b.addEventListener?.("levelchange", push);
        b.addEventListener?.("chargingchange", push);
        push();
        log(
          `battery: ${Math.round(b.level * 100)}%, ${b.charging ? "charging" : "on battery"}`,
        );
      })
      .catch(() => log("battery: no reading — the low-battery warning cannot fire"));
  } else {
    log("battery: no reading — the low-battery warning cannot fire");
  }

  // The boot line goes to the console, not above the device: the page is
  // meant to look like the hardware, and the hardware does not caption
  // itself. Open the console to see it.
  log(`norns · ${installed} scripts · scale ${canvas.scale}× · audio starting…`);
  // Exposed for the console. A development aid, and the only way to ask the
  // running system a question without adding a UI for it.
  // It MERGES. Audio and MIDI arrive on their own schedules and each calls
  // this when it is ready; a replace would mean whichever finished second
  // erased the other, and which one that is depends on how fast the machine
  // is.
  const expose = (extra: Record<string, unknown> = {}): void => {
    const w = window as unknown as Record<string, unknown>;
    const prev = (w["__norns"] as Record<string, unknown> | undefined) ?? {};
    w["__norns"] = { ...prev, host, vfs, screen, ...extra };
  };
  expose();

  // --- the grid (E5-01/02/03/04/05) ------------------------------------
  //
  // A device and a view of it. The view is a `GridTransport` like any other,
  // so a WebSocket grid or a real one over Web Serial attaches beside it
  // with nothing above having to know.
  //
  // It is added BEFORE the script loads, because `startup.lua` builds the
  // vport table from whatever is present and `Grid.cleanup` walks it on
  // every script load; a grid that arrives later is a hot-plug, which works
  // but means the first script to run saw no grid.
  // ONE id space for every monome device. An arc and a grid are the same
  // `dev_monome` to matron and are looked up from one table by
  // `monome_refresh`; two counters would collide as soon as both existed.
  let nextMonomeId = 0;
  const mintMonomeId = (): number => nextMonomeId++;

  const gridManager = new GridManager({
    monomeAdd: (id, serial, name, handle) => {
      // monome.add, never grid.add: `startup.lua:68-73` is what decides
      // whether a device is a grid or an arc, by its name. Calling grid.add
      // from here would bypass that — and is why E5-13 exists.
      const e = cb.monomeAdd(id, serial, name, handle as never);
      if (e) log(`monome.add: ${e.message}`);
      dirty = true;
    },
    monomeRemove: (id) => void cb.monomeRemove(id),
    gridKey: (id, x, y, state) => {
      const e = cb.gridKey(id, x, y, state);
      if (e) log(`grid.key: ${e.message}`);
      dirty = true;
    },
    gridTilt: (id, s, x, y, z) => void cb.gridTilt(id, s, x, y, z),
  }, mintMonomeId);
  registerGrid(host.registry, gridManager, { log: (l) => log(l) });

  // --- the arc (E5-12 … E5-17) ------------------------------------------
  //
  // Added through `monome.add` like the grid, and the NAME is what makes it
  // an arc: `startup.lua:68-73` routes on the prefix "monome arc" and
  // nothing else does.
  const arcManager = new ArcManager(
    {
      monomeAdd: (id, serial, name, handle) => {
        const e = cb.monomeAdd(id, serial, name, handle as never);
        if (e) log(`monome.add: ${e.message}`);
        dirty = true;
      },
      monomeRemove: (id) => void cb.monomeRemove(id),
      arcDelta: (id, ring, d) => {
        const e = cb.arcDelta(id, ring, d);
        if (e) log(`arc.delta: ${e.message}`);
        dirty = true;
      },
      arcKey: (id, ring, state) => {
        const e = cb.arcKey(id, ring, state);
        if (e) log(`arc.key: ${e.message}`);
        dirty = true;
      },
    },
    mintMonomeId,
  );
  registerArc(host.registry, arcManager, { log: (l) => log(l) });
  // The two functions a grid and an arc share, in one place because a `dev`
  // handle reaching them may be either.
  registerMonome(host.registry, [(id) => gridManager.get(id), (id) => arcManager.get(id)]);

  const gridCanvas = $("#grid") as HTMLCanvasElement;
  const gridBox = $("#gridbox") as HTMLElement;
  /**
   * E9-108 — A PHONE GETS A 64, and every other machine still gets a 128.
   *
   * A grid takes the full width of a phone and a 128 is sixteen keys
   * across it: on a Pixel 9 Pro that is about 24 CSS pixels a key, under
   * half of what anybody's guidance calls a touch target, and the keys you
   * miss are the ones next to the key you wanted. A 64 is eight across, so
   * each key is twice as wide — and 8x8 is a real monome that real scripts
   * are written for, not a cropped 128.
   *
   * It is a DEFAULT and not a rule: SETTINGS has 64/128/256/none and the
   * buttons work the same on a phone as anywhere else.
   */
  const GRID_ON_PHONE = 64;
  const GRID_DEFAULT = 128;
  /** 0 means nothing is plugged in, and then there is no device at all. */
  let gridSize = kindNow() === "phone" ? GRID_ON_PHONE : GRID_DEFAULT;
  /**
   * The grid can be ABSENT, not merely hidden.
   *
   * A norns with no grid plugged in has no grid: `grid.devices` is empty and
   * a script's `grid.connect()` gets a vport with no device behind it. A
   * page that kept the device and hid the picture would be telling scripts
   * something different from what it tells the person looking at it.
   */
  let gridDevice: ReturnType<GridManager["add"]> | null = null;
  let gridView: GridView | null = null;
  /** A second sink, when `?grid-remote=` asked for one. See E5-06. */
  let remoteGrid: RemoteGridTransport | null = null;

  // Stable identity across a resize: the serial and the name never change,
  // so the vport binding `system.state` persisted survives. See
  // src/grid/manager.ts.
  const attachGrid = (cols: number, rows: number): void => {
    gridDevice = gridManager.add({
      serial: "v0001",
      name: "virtual grid",
      cols,
      rows,
      varibright: true,
    });
    gridBox.hidden = false;
    // `buildGridView` refreshes the stage itself, and in the right order:
    // the refresh here ran BEFORE the aspect ratio was set, so it measured
    // the shape the grid was about to stop being.
    buildGridView();
  };

  const detachGrid = (): void => {
    if (gridDevice === null) return;
    // Unbind while the device is still there, so a finger down across the
    // unplug reports its lift to a grid Lua still knows about.
    teardownGridView();
    gridManager.remove(gridDevice.id);
    gridDevice = null;
    gridBox.hidden = true;
    stage?.refresh();
  };

  /**
   * Unbind the current view from the device it is attached to.
   *
   * It is called BEFORE the device goes away, never after: `dispose()` lifts
   * whatever is still held, and a lift delivered to a device matron has
   * already removed comes back as `grid.key: no entry for grid N` from
   * `core/grid.lua:230`.
   *
   * It is also what makes a rebuild safe at all. The canvas is reused, so a
   * view that is simply dropped keeps its pointer listeners on it: the old
   * one and the new one both answer, and each key arrives twice -- once at
   * the device that no longer exists.
   */
  function teardownGridView(): void {
    if (remoteGrid !== null) gridDevice?.removeTransport(remoteGrid);
    if (!gridView) return;
    gridDevice?.removeTransport(gridView);
    gridView.dispose();
    gridView = null;
  }

  function buildGridView(): void {
    teardownGridView();
    const d = gridDevice;
    if (d === null) return;
    gridCanvas.style.aspectRatio = `${d.cols()} / ${d.rows()}`;
    // THE SHAPE HAS JUST CHANGED, SO THE LAYOUT HAS TO BE RE-RUN, and here
    // rather than in each of the three callers: this is the one line that
    // changes the grid's aspect ratio, and 64, 128, 256 and rotate all come
    // through it. Without it the box kept the height the old shape gave it
    // and everything stacked below stayed where it was — a rotated grid was
    // drawn straight over the keyboard. The read of `aspectRatio` above is
    // what makes the measurement inside `refresh` the new one.
    stage?.refresh();
    gridView = new GridView({
      canvas: gridCanvas,
      descriptor: d.descriptor,
      cols: () => d.cols(),
      rows: () => d.rows(),
      onKey: (x, y, state) => d.key(x, y, state),
    });
    d.addTransport(gridView);
    if (remoteGrid !== null) d.addTransport(remoteGrid);
    // The canvas has just been given a new aspect ratio; its box is only
    // the right size after layout, so the measurement has to wait a frame.
    requestAnimationFrame(() => gridView?.layout());
  }
  // One is connected by default, as a norns usually has one.
  attachGrid(gridSize === 64 ? 8 : 16, 8);
  globalThis.addEventListener("resize", () => gridView?.layout());

  const sizeButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-size]")];
  const markSize = (): void => {
    for (const b of sizeButtons) {
      b.setAttribute("aria-pressed", String(Number(b.dataset["size"]) === gridSize));
    }
  };
  for (const b of sizeButtons) {
    b.addEventListener("click", () => {
      const size = Number(b.dataset["size"]);
      if (size === gridSize) return;
      gridSize = size;
      markSize();
      if (size === 0) {
        detachGrid();
        return;
      }
      const cols = size === 64 ? 8 : 16;
      const rows = size === 256 ? 16 : 8;
      if (gridDevice === null) {
        attachGrid(cols, rows);
        return;
      }
      teardownGridView();
      // A resize is a remove and an add with the SAME serial and name:
      // `Grid.new` reads the size once, on add, so a device that changed
      // shape underneath Lua would keep reporting the old one.
      const next = gridManager.resize(gridDevice.id, cols, rows);
      if (next) {
        gridDevice = next;
        buildGridView();
      }
    });
  }
  markSize();
  // A grid somewhere else (E5-06). `?grid-remote=ws://host:port` attaches a
  // second sink to the SAME device, so the on-screen grid and the remote one
  // light together — which hardware cannot do.
  const remoteUrl = new URLSearchParams(location.search).get("grid-remote");
  if (remoteUrl !== null && remoteUrl !== "") {
    // The socket is opened ONCE and re-attached on every rebuild, so a
    // resize or an unplug does not drop the connection. Its callbacks read
    // the live device rather than closing over one, which is the same
    // reason: the device is replaced on a resize.
    remoteGrid = new RemoteGridTransport({
      url: remoteUrl,
      descriptor: { serial: "v0001", name: "virtual grid", cols: 16, rows: 8, varibright: true },
      onKey: (x, y, state) => gridDevice?.key(x, y, state),
      onTilt: (s, x, y, z) => gridDevice?.tilt(s, x, y, z),
      log: (l) => log(l),
    });
    expose({ gridRemote: remoteGrid });
    log(`grid remote: connecting to ${remoteUrl}`);
    buildGridView();
  }

  $("#gridrot").addEventListener("click", () => {
    const d = gridDevice;
    if (d === null) return;
    d.setRotation((((d.currentRotation + 1) % 4) as 0 | 1 | 2 | 3));
    buildGridView();
  });

  // --- one panel at a time (E9-93) ---------------------------------------
  //
  // EVERY RAIL PANEL IS REGISTERED HERE, and opening one closes the rest.
  //
  // That used to be left to the document click listener further down, which
  // closes a popover when the click lands outside it — and a click on
  // another rail button IS outside it, so it worked for the four panels the
  // listener knew about. It did not know about the gear: the settings panel
  // is built by `settings-panel.ts` and opened through its own handle, so
  // settings and the level could be on screen together, overlapping, with
  // the rail drawn over the settings panel’s close button.
  //
  // Registered rather than listed, because the gear is created two hundred
  // lines after the sound panel and a list written at either end would be
  // half empty. The array is read when a panel opens, never at declaration.
  type RailPanel = { readonly isOpen: () => boolean; readonly close: () => void };
  const railPanels: RailPanel[] = [];
  /** Close every registered panel but one. Called by each panel as it opens. */
  const closeOtherPanels = (me: RailPanel | null): void => {
    for (const p of railPanels) if (p !== me && p.isOpen()) p.close();
  };
  /** Register a panel and hand back the token it closes the others with. */
  const railPanel = (isOpen: () => boolean, close: () => void): RailPanel => {
    const p: RailPanel = { isOpen, close };
    railPanels.push(p);
    return p;
  };

  // The master mute, which starts OFF: the output is live. A browser will
  // not start an AudioContext before a user gesture anyway, so a mute as
  // well was asking permission twice.
  const soundButton = $("#sound");
  const soundPanel = $("#soundpanel") as HTMLElement;
  const volumeInput = $("#volume") as HTMLInputElement;
  const volumeDb = $("#volumedb");
  const volumeNote = $("#volumenote");
  const muteButton = $("#mute");
  const markSound = (): void => {
    // The icon carries the state: `aria-pressed` turns it amber and the
    // CSS draws the slash when it is false. The tooltip says what the
    // output IS, because pressing it no longer does one thing — it opens
    // the panel, and the panel holds both the level and the mute.
    const db = settings.volumeDb;
    soundButton.setAttribute("aria-pressed", String(!settings.muted));
    soundButton.dataset["tip"] = settings.muted ? "sound — muted" : `sound — ${db > 0 ? "+" : ""}${db} dB`;
    volumeInput.value = String(db);
    volumeDb.textContent = `${db > 0 ? "+" : ""}${db} dB`;
    muteButton.textContent = settings.muted ? "off" : "on";
    muteButton.setAttribute("aria-pressed", String(!settings.muted));
    // The note earns its place only when there is something to say: a
    // panel that always carries a warning is a panel nobody reads.
    volumeNote.textContent = settings.muted
      ? "the output is muted; the level is remembered"
      : db > 0
        ? "above 0 dB the output can clip. it is here because some scripts arrive quieter than they should."
        : "";
  };
  /** Push the level at the audio graph, muted or not. */
  const applyOutput = (): void => applyMute(settings.muted);
  const showSound = (on: boolean): void => {
    if (on) closeOtherPanels(soundToken);
    soundPanel.hidden = !on;
    soundButton.setAttribute("aria-expanded", String(on));
  };
  const soundToken = railPanel(() => soundPanel.hidden === false, () => showSound(false));
  // NO stopPropagation: the document listener below is what puts a panel
  // away when the click lands outside it, and it knows to leave alone the
  // one whose button was just pressed.
  soundButton.addEventListener("click", () => showSound(soundPanel.hidden === true));
  volumeInput.addEventListener("input", () => {
    settings.setVolume(Number(volumeInput.value));
    applyOutput();
    markSound();
  });
  // Said once per gesture rather than once per pixel of the drag: `input`
  // fires for every step and a log line each would bury everything else.
  volumeInput.addEventListener("change", () => log(`audio: level ${settings.volumeDb} dB`));
  $("#volume0").addEventListener("click", () => {
    settings.setVolume(0);
    applyOutput();
    markSound();
    log("audio: level 0 dB");
  });
  // --- zoom (E9-61) ------------------------------------------------------
  //
  // The panel under the magnifier, and the two gestures everybody already
  // knows. `settings.setZoom` clamps, so every path here can be naive.
  const zoomButton = $("#zoom");
  const zoomPanel = $("#zoompanel") as HTMLElement;
  const zoomRange = $("#zoomrange") as HTMLInputElement;
  const zoomVal = $("#zoomval");
  const markZoom = (): void => {
    const pct = Math.round(settings.zoom * 100);
    zoomRange.value = String(pct);
    zoomVal.textContent = `${pct}%`;
    zoomButton.dataset["tip"] = `zoom — ${pct}%`;
  };
  const showZoom = (on: boolean): void => {
    if (on) closeOtherPanels(zoomToken);
    zoomPanel.hidden = !on;
    zoomButton.setAttribute("aria-expanded", String(on));
  };
  const zoomToken = railPanel(() => zoomPanel.hidden === false, () => showZoom(false));
  zoomButton.addEventListener("click", () => showZoom(zoomPanel.hidden === true));
  zoomRange.addEventListener("input", () => settings.setZoom(Number(zoomRange.value) / 100));
  zoomRange.addEventListener("change", () => log(`zoom: ${Math.round(settings.zoom * 100)}%`));
  $("#zoomreset").addEventListener("click", () => {
    settings.setZoom(1);
    log("zoom: 100%");
  });
  markZoom();

  /** One step of zoom, rounded to whole percents so it cannot drift. */
  const nudgeZoom = (factor: number): void => {
    settings.setZoom(Math.round(settings.zoom * factor * 100) / 100);
  };

  // CTRL AND THE WHEEL. `passive: false`, because the default action is the
  // browser's own zoom and the whole point is to do ours instead — a
  // passive listener cannot prevent it. On a trackpad a pinch arrives as
  // exactly this event with ctrlKey set, which is why the gesture below is
  // only needed for touch.
  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // deltaY is lines on some mice and pixels on others; only the sign is
      // portable, so a step is a step.
      nudgeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false },
  );

  // A PINCH, on a touch screen. Two pointers down, and the zoom follows the
  // ratio of the distance between them to the distance they started at —
  // which is what a pinch is, and it means letting go and starting again
  // continues from where it stopped rather than snapping.
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { span: number; zoom: number } | null = null;
  const span = (): number => {
    const [a, b] = [...touches.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch = touches.size === 2 ? { span: span(), zoom: settings.zoom } : null;
  });
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size !== 2) return;
      const now = span();
      if (pinch.span < 24 || now < 24) return; // two fingers, not one thumb
      e.preventDefault();
      settings.setZoom(Math.round(((pinch.zoom * now) / pinch.span) * 100) / 100);
    },
    { passive: false },
  );
  const liftTouch = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  document.addEventListener("pointerup", liftTouch);
  document.addEventListener("pointercancel", liftTouch);

  muteButton.addEventListener("click", () => {
    settings.setMuted(!settings.muted);
    applyOutput();
    markSound();
    log(`audio: ${settings.muted ? "muted" : "unmuted"}`);
  });
  markSound();
  if (settings.muted) log("audio: muted — the speaker in the rail has the level and the mute");
  else log("audio: output is live. The speaker in the rail has the level and the mute.");

  // Copy the console. The one time anyone wants this is when something has
  // gone wrong and the whole log has to be pasted somewhere else, so it has
  // a FALLBACK: `navigator.clipboard` needs a secure context and a focused
  // document, and a page that is misbehaving is exactly where that fails.
  const copyButton = $("#logcopy");
  copyButton.addEventListener("click", () => {
    const text = logEl.textContent ?? "";
    const settle = (ok: boolean): void => {
      copyButton.textContent = ok ? "copied" : "select all";
      copyButton.classList.toggle("done", ok);
      copyButton.classList.toggle("failed", !ok);
      setTimeout(() => {
        copyButton.textContent = "copy";
        copyButton.classList.remove("done", "failed");
      }, 1400);
    };
    const theOldWay = (): boolean => {
      // Deprecated, and the only thing that works without the permission
      // the modern API wants. If it fails too, the selection is left on
      // the log so Ctrl+C still does it.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      if (!ok) globalThis.getSelection?.()?.selectAllChildren(logEl);
      return ok;
    };
    void navigator.clipboard
      ?.writeText(text)
      .then(() => settle(true))
      .catch(() => settle(theOldWay()));
    if (!navigator.clipboard) settle(theOldWay());
  });

  // The console is a development aid, not part of the instrument, so it is
  // folded away by default and the toolbar button is what reveals it.
  // The console is a DEVICE now, so showing it is showing its box — which
  // is also what the stage reads to decide whether to lay it out, and what
  // `arrange devices` reads to decide whether it can be moved.
  const consoleBox = $("#consolebox") as HTMLElement;
  const consoleButton = $("#consoletoggle");
  consoleButton.addEventListener("click", () => {
    const open = consoleBox.hidden;
    consoleBox.hidden = !open;
    stage?.refresh();
    refit();
    consoleButton.setAttribute("aria-pressed", String(open));
    // The log has been accumulating while hidden; show its end, not its
    // beginning, which is what a console that was open all along would show.
    if (open) logEl.scrollTop = logEl.scrollHeight;
  });

  // --- the restart button (E9-17) ----------------------------------------
  //
  // In a tab you reload the tab. In the application there is no address bar
  // and no reload, and SYSTEM > RESTART is four presses into a menu — which
  // is a long way to go for the thing a freshly installed engine needs.
  //
  // IT CONFIRMS, even though saving a trip through the menus is the point:
  // this is the one control in the rail that stops whatever is playing, and
  // the menu asks too. One click and one confirm is still three fewer.
  const restartButton = $("#restart");
  const restartPanel = $("#restartpanel") as HTMLElement;
  const restartWhy = $("#restartwhy");
  const showRestart = (on: boolean): void => {
    if (on) closeOtherPanels(restartToken);
    restartPanel.hidden = !on;
    restartButton.setAttribute("aria-expanded", String(on));
    if (!on) return;
    const owed = [...restartOwed];
    restartWhy.textContent =
      owed.length === 0
        ? "restart? what you have written is kept. whatever is playing stops."
        : `${owed.join(", ")} ${owed.length === 1 ? "needs" : "need"} it. what you have written is kept.`;
  };
  const restartToken = railPanel(() => restartPanel.hidden === false, () => showRestart(false));
  markRestart = (): void => {
    // The icon carries it: amber, like every other rail button that is ON,
    // and the tooltip says what is waiting rather than only "restart".
    const owed = restartOwed.size > 0;
    restartButton.setAttribute("aria-pressed", String(owed));
    restartButton.dataset["tip"] = owed ? `restart — ${[...restartOwed].join(", ")}` : "restart";
  };
  markRestart();
  restartButton.addEventListener("click", () => showRestart(restartPanel.hidden === true));
  $("#restartgo").addEventListener("click", () => {
    showRestart(false);
    doRestart();
  });
  $("#restartno").addEventListener("click", () => showRestart(false));

  // The arc is ATTACHED, not present: a norns with nothing plugged in has no
  // arc, and four empty circles on screen would say otherwise. The button is
  // the cable.
  const arcBox = $("#arcbox") as HTMLElement;
  const arcCanvas = $("#arc") as HTMLCanvasElement;
  const arcButton = $("#arcattach");
  let arcDevice: ReturnType<ArcManager["add"]> | null = null;
  let arcView: ArcView | null = null;
  arcButton.addEventListener("click", () => {
    if (arcDevice === null) {
      arcDevice = arcManager.add({ serial: "v0001", name: "monome arc 4" });
      arcBox.hidden = false;
      stage?.refresh();
      const d = arcDevice;
      arcView = new ArcView({
        canvas: arcCanvas,
        descriptor: d.descriptor,
        onDelta: (ring, delta) => d.delta(ring, delta),
        onKey: (ring, state) => d.key(ring, state),
      });
      d.addTransport(arcView);
      requestAnimationFrame(() => arcView?.layout());
      arcButton.setAttribute("aria-pressed", "true");
      log("arc: virtual arc attached");
    } else {
      arcView?.dispose();
      arcDevice.removeTransport(arcView!);
      arcManager.remove(arcDevice.id);
      arcDevice = null;
      arcView = null;
      arcBox.hidden = true;
      stage?.refresh();
      arcButton.setAttribute("aria-pressed", "false");
      log("arc: virtual arc detached");
    }
    dirty = true;
  });
  globalThis.addEventListener("resize", () => arcView?.layout());

  // --- the virtual MIDI keyboard -----------------------------------------
  //
  // A device you plug in, like the arc and the loopback, for the same
  // reason: one that is simply there is a surprise rather than a choice.
  // It is a MIDI INPUT and nothing else, so a script sees exactly what a
  // USB keyboard would — `Midi.add` on attach, note on and note off, and
  // `Midi.remove` when it goes.
  const keysBox = $("#keysbox") as HTMLElement;
  const keysButton = $("#keysattach");
  let keysPort: KeyboardMidiPort | null = null;
  let keysId = -1;
  let keysView: KeyboardView | null = null;
  keysButton.addEventListener("click", () => {
    if (keysPort === null) {
      keysPort = createKeyboardMidiPort();
      const d = midiManager.add(keysPort);
      keysPort.attach(d);
      keysId = d.id;
      keysBox.hidden = false;
      const port = keysPort;
      keysView = createKeyboardView({
        host: $("#keys") as HTMLElement,
        octave: settings.midiOctave,
        velocity: settings.midiVelocity,
        onNoteOn: (n, v) => port.noteOn(n, v),
        onNoteOff: (n) => port.noteOff(n),
      });
      stage?.refresh();
      refit();
      keysButton.setAttribute("aria-pressed", "true");
      log(`midi keyboard: attached, two octaves from C${settings.midiOctave}`);
    } else {
      // Release before removing: a note left on when its port disappears is
      // a voice a script can never turn off.
      keysView?.dispose();
      keysPort.allOff();
      midiManager.remove(keysId);
      keysPort = null;
      keysId = -1;
      keysView = null;
      keysBox.hidden = true;
      stage?.refresh();
      refit();
      keysButton.setAttribute("aria-pressed", "false");
      log("midi keyboard: detached");
    }
    dirty = true;
  });

  // --- `faders` and `knobs` ----------------------------------------------
  //
  // Two MIDI controllers of our own, inspired by the two the norns world
  // already speaks to: a sixteen-fader bank on the 16n's factory mapping,
  // and four banks of sixteen encoders on the Midi Fighter Twister's. A
  // page with no MIDI hardware had no way to reach any of that.
  //
  // THE BUTTON AND THE WIRE SAY DIFFERENT THINGS, on purpose. The buttons
  // are `faders` and `knobs`, which is what these are to somebody looking
  // at them. On the wire they answer "16n" and "Midi Fighter Twister",
  // because `flora.lua:110` and `cheat_codes_2.lua:2093` compare that
  // string exactly and set themselves up on finding it — a controller that
  // has to be assigned by hand before anything happens is a controller most
  // people never get working.
  //
  // Same shape as the keyboard and the arc: `Midi.add` on attach and
  // `Midi.remove` on detach, so a running script sees a hot-plug rather
  // than a device that was always there. Off and hidden until asked for.
  const fadersBox = $("#fadersbox") as HTMLElement;
  const fadersButton = $("#fadersattach");
  let fadersPort: FadersMidiPort | null = null;
  let fadersId = -1;
  let fadersView: FadersView | null = null;
  fadersButton.addEventListener("click", () => {
    if (fadersPort === null) {
      const port = createFadersMidiPort();
      const d = midiManager.add(port);
      port.attach(d);
      fadersPort = port;
      fadersId = d.id;
      fadersBox.hidden = false;
      fadersView = createFadersView({
        host: $("#faders") as HTMLElement,
        values: port.values(),
        onMove: (fader, value) => port.move(fader, value),
      });
      stage?.refresh();
      refit();
      fadersButton.setAttribute("aria-pressed", "true");
      log(`faders: attached as "${FADERS_MIDI_NAME}" — CC 32-47 on channel 1`);
    } else {
      fadersView?.dispose();
      midiManager.remove(fadersId);
      fadersPort = null;
      fadersId = -1;
      fadersView = null;
      fadersBox.hidden = true;
      stage?.refresh();
      refit();
      fadersButton.setAttribute("aria-pressed", "false");
      log("faders: detached");
    }
    dirty = true;
  });

  const knobsBox = $("#knobsbox") as HTMLElement;
  const knobsButton = $("#knobsattach");
  let knobsPort: KnobsMidiPort | null = null;
  let knobsId = -1;
  let knobsView: KnobsView | null = null;
  knobsButton.addEventListener("click", () => {
    if (knobsPort === null) {
      const port = createKnobsMidiPort();
      const d = midiManager.add(port);
      port.attach(d);
      knobsPort = port;
      knobsId = d.id;
      knobsBox.hidden = false;
      const redraw = (): void => {
        knobsView?.refresh(port.values(), port.colours(), port.bank());
        dirty = true;
      };
      knobsView = createKnobsView({
        host: $("#knobs") as HTMLElement,
        values: port.values(),
        bank: port.bank(),
        onTurn: (knob, value) => port.turn(knob, value),
        onPress: (knob, down) => port.press(knob, down),
        onBank: (bank) => {
          port.setBank(bank);
          redraw();
        },
      });
      // The host painting the face, which is half of what this device is
      // for: a script lights the rings as its own state moves.
      port.onPaint(redraw);
      stage?.refresh();
      refit();
      knobsButton.setAttribute("aria-pressed", "true");
      log(
        `knobs: attached as "${KNOBS_MIDI_NAME}" — 4 banks, CC 0-63 on ` +
          `channel 1, switches on channel 2`,
      );
    } else {
      knobsView?.dispose();
      midiManager.remove(knobsId);
      knobsPort = null;
      knobsId = -1;
      knobsView = null;
      knobsBox.hidden = true;
      stage?.refresh();
      refit();
      knobsButton.setAttribute("aria-pressed", "false");
      log("knobs: detached");
    }
    dirty = true;
  });

  // --- the exerciser (E5-23) ---------------------------------------------
  //
  // Exposed rather than wired to a button: it takes minutes, it drives the
  // page from underneath, and it is a measuring instrument, not a feature.
  // `__norns.exercise()` from the console, or `?exercise=1` to run it on
  // load and leave the report in `__norns.lastExercise`.
  const runExercise = async (o: ExerciseOptions = {}): Promise<unknown> => {
    const report = await exercise(
      {
        host,
        vfs,
        screen,
        peak: () => (window as unknown as { __norns: { peak?: () => number } }).__norns.peak?.() ?? null,
        grid: () => (gridDevice ? Uint8Array.from(gridDevice.front()) : null),
        gridKey: (x, y, z) => gridDevice?.key(x - 1, y - 1, z),
        key: (n, z) => void cb.key(n, z),
        enc: (n, d) => void cb.enc(n, d),
        // Through the SAME port a person plays, not through a back door:
        // a script that filters by channel or by device id must be asked
        // the question the hardware would ask. Absent when the keyboard is
        // not attached, and the sweep then reports no note rather than a
        // silent one.
        note: keysPort ? (n, v) => keysPort?.noteOn(n, v) : undefined,
        noteOff: keysPort ? (n) => keysPort?.noteOff(n) : undefined,
        log: (l) => log(l),
      },
      { onResult: () => void (dirty = true), ...o },
    );
    expose({ lastExercise: report });
    log(`exercise: ${report.ok} of ${report.total} ok`);
    return report;
  };
  expose({ exercise: runExercise, scripts: () => scriptsIn(vfs), diagnose });
  /**
   * E9-166 — AND FROM THE URL, which is the only control a phone has.
   *
   * `?diagnose` prints the block once the page has settled. Ten seconds:
   * past the engine, past crone's first VU windows, and past the six the
   * device latency needs — a block printed before those are in is a
   * block of "nothing reported yet".
   */
  if (new URLSearchParams(globalThis.location?.search ?? "").has("diagnose")) {
    setTimeout(diagnose, 10_000);
  }

  /** Turn the gamepad on or off to match the profile. */
  const applyMachine = (): void => {
    const kind = kindNow();
    document.body.dataset["machine"] = kind;
    if (kind === "steamdeck" && pad === null) {
      pad = createPadCore({ sensitivity: () => settings.encoderSensitivity });
      padAt = 0;
      log("machine: reading a gamepad — A/B/X are K3/K2/K1, sticks are E2 and E3, d-pad is E1");
    } else if (kind !== "steamdeck" && pad !== null) {
      // One last frame with no pad, so anything held is released.
      for (const a of pad.frame(null, 16)) if (a.a === "key") onKeyIn(a.n, a.z);
      pad = null;
    }
    stage?.refresh();
    refit();
  };

  // A PAD ARRIVES LATE, ALWAYS. Chrome does not expose a gamepad until one
  // of its buttons has been pressed -- it is a fingerprinting surface, so
  // the list is empty until the user proves there is a pad. That means the
  // strongest Steam Deck signal CANNOT exist at boot, and detecting once
  // would throw it away. So detection runs again when a pad appears, and
  // only a change does anything.
  globalThis.addEventListener("gamepadconnected", () => {
    const again = detect(readSignals());
    if (again.kind === detected.kind && again.confident === detected.confident) return;
    detected = again;
    log(`machine: ${kindNow()} — ${settings.machine === "auto" ? again.why : "set in the gear"}`);
    if (settings.machine === "auto") applyMachine();
  });

  // --- the gear (E6-10) --------------------------------------------------
  //
  // Last, because the stage has to be able to measure the devices and the
  // panel has to be able to tell the stage to re-place them.
  stage = createStage({
    stage: $("#stage"),
    devices: [
      { id: "norns", el: $("#nornsbox") },
      { id: "grid", el: gridBox },
      { id: "arc", el: arcBox },
      { id: "keys", el: keysBox },
      { id: "faders", el: fadersBox },
      { id: "knobs", el: knobsBox },
      { id: "console", el: consoleBox },
    ],
    kind: kindNow,
    settings,
    onResized: (id: DeviceId) => {
      // Each device measures itself from its box. The two canvases are
      // told; the screen is REFITTED HERE TOO, not only by its own
      // ResizeObserver.
      //
      // The observer alone was not enough and the failure was quiet: the
      // screen came up at scale 1 instead of 2 and stayed there until the
      // window was resized by hand — measured at phone width, where the
      // well is 299 device pixels and the canvas was 128 of them. Half the
      // resolution, no error, and on a small screen the difference between
      // legible and not. The stage is what decides how wide a device is, so
      // the stage is what has to say when it changed.
      if (id === "grid") gridView?.layout();
      if (id === "arc") arcView?.layout();
      if (id === "norns") refit();
      dirty = true;
    },
  });
  /**
   * Hand the user a file.
   *
   * An object URL and a click on an anchor the user never sees. It is the
   * only way a page can produce a file, and it only works because a real
   * click is what started it — which is also why export is a button and not
   * something the page decides to do.
   */
  const download = (bytes: Uint8Array, name: string): void => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // Not immediately: the navigation to the blob has to start first.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  // E9-149 — the profile started before this existed; give it the door now.
  offerFile = download;

  // The profile decides default widths and whether a gamepad is read, so it
  // is applied once the stage exists and again whenever the gear changes it.
  applyMachine();
  settings.subscribe((_st, what) => {
    if (what === "machine") applyMachine();
    // The two bodies are different SHAPES, so the stage has to place the
    // devices again and the screen canvas has to find its new integer
    // scale. Nothing else about the page changes.
    if (what === "panel") {
      applyPanel();
      stage?.refresh();
      refit();
    }
    // Zoom changes every device's size, so the canvases have to measure
    // themselves again -- the same work a window resize causes.
    if (what === "zoom") {
      applyZoom();
      stage?.refresh();
      refit();
      gridView?.layout();
      arcView?.layout();
      markZoom();
    }
    if (what === "midi") {
      keysView?.setOctave(settings.midiOctave);
      keysView?.setVelocity(settings.midiVelocity);
    }
  });

  // THE GEAR JOINS THE RAIL REGISTRY (E9-93), and it is the one that needed
  // joining: the four popovers already closed each other. It is not a
  // popover itself — it survives a click on a device, because arranging is
  // done out there with the panel open — so it is told when it opens
  // instead, and closes the rest from inside.
  const gearPanel = $("#settings") as HTMLElement;
  const gearToken = railPanel(() => gearPanel.hidden === false, () => gear.close());
  const gear = createSettingsPanel({
    button: $("#gear"),
    panel: gearPanel,
    onOpen: () => closeOtherPanels(gearToken),
    settings,
    stage,
    machine: { detected: () => detected, effective: kindNow },
    audio: {
      list: listAudioDevices,
      canChooseOutput,
      applyOutput: applyOutputDevice,
      applyInput: applyInputDevice,
      grant: async () => {
        const r = await grantDeviceAccess();
        audioError = r.ok ? "" : (r.why ?? "the microphone was refused");
        log(r.ok ? "audio: the sound cards can be named now" : `audio: ${audioError}`);
      },
      watch: watchDevices,
      lastError: () => audioError,
    },
    // Through closures, not direct references: the panel is built long
    // before these exist, and a direct one is a temporal dead zone waiting
    // to happen — which is exactly what the port list did (E9-16).
    loopback: { on: () => virtualMidi !== null, toggle: () => toggleLoopback() },
    midiPorts: listMidiPorts,
    files: {
      export: async (everything) => {
        const r = await exportTree(vfs, { everything });
        if (r.files === 0) {
          log("export: nothing has been changed yet — there is nothing to save");
          return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        download(r.bytes, `norns-js-dust-${stamp}.zip`);
        log(
          `export: ${r.files} files, ${(r.bytes.length / 1024).toFixed(0)} KB` +
            (r.skipped.length
              ? ` (${r.skipped.length} left out: downloaded files the build supplies again)`
              : ""),
        );
      },
      // A backup goes back at the paths it has. This is the inverse of
      // export and nothing else: it does not look for a script inside.
      restore: async (bytes, name) => {
        try {
          const r = await importTree(vfs, bytes);
          log(`restore: ${name} — ${r.written} files written`);
          for (const x of r.refused) log(`restore: refused ${x.path} (${x.why})`);
          // SELECT reads the tree when it is opened, so scripts appear
          // without a reload; `state.resume` does not, so a tree that
          // replaces the running script needs one. Said, not done.
          if (r.written > 0) log("restore: reload the page to resume into a restored script");
        } catch (err) {
          log(`restore failed: ${String((err as Error)?.message ?? err)}`);
        }
      },
      // One script, rehomed under code/<name>. The wrapper folder a zip
      // from GitHub carries is stripped, which is the whole difference
      // from restore — and the reason the old advice to "use import"
      // produced a script outside code/ that SELECT never found.
      addScript: async (bytes, name) => {
        try {
          const r = await installScript(vfs, bytes);
          log(`add: ${name} — ${r.name}, ${r.files} files, in code/${r.name}`);
          for (const x of r.refused) log(`add: refused ${x.path} (${x.why})`);
        } catch (err) {
          log(`add failed: ${String((err as Error)?.message ?? err)}`);
        }
      },
      addScriptFromUrl: async (url) => {
        try {
          const archive = await fetchArchive(url);
          const r = await installScript(vfs, archive);
          log(`add: ${r.name} — ${r.files} files, in code/${r.name}`);
          for (const x of r.refused) log(`add: refused ${x.path} (${x.why})`);
        } catch (err) {
          log(`add failed: ${String((err as Error)?.message ?? err)}`);
        }
      },
      /**
       * E9-142 — put `~/dust/code` back to what the build ships.
       *
       * REVERT WHERE THERE IS SOMETHING TO REVERT TO, remove where there
       * is not. `vfs.revert` only answers for a path the BUILD supplies
       * and returns false for anything else, so the pair is exactly
       * right: a bundled script comes back as the build has it, and an
       * installed one ceases to exist. On the published `--no-scripts`
       * build nothing is bundled and the folder simply empties, which is
       * what this is for.
       *
       * `.installing/` GOES TOO. Those are script files under another
       * name, and "swept N interrupted downloads" has been in every log
       * off that phone for a week — eight of them, still named after
       * installs that were abandoned days ago.
       *
       * THEN THE FLUSH, before anything else happens. The removals only
       * queue; the mirror is debounced and asynchronous. E9-135 and
       * E9-140 were both this, and a reset that came back after a reload
       * would be the same bug a third time.
       *
       * AND THEN A RESTART, because the Lua side has a script loaded and
       * SELECT has a list, and neither is told. `_norns.restart` runs
       * `cleanup()` and comes back with no script, which is where
       * somebody who has just removed everything wants to be.
       */
      installed: () =>
        vfs
          .list("/home/we/dust/code")
          .filter((e) => e.isDir && vfs.walk(`/home/we/dust/code/${e.name}`).length > 0).length,
      resetScripts: async () => {
        const code = "/home/we/dust/code";
        const staging = "/home/we/dust/.installing";
        const scripts = vfs
          .list(code)
          .filter((e) => e.isDir && vfs.walk(`${code}/${e.name}`).length > 0).length;
        let files = 0;
        for (const p of vfs.walk(code)) {
          if (!vfs.revert(p)) vfs.remove(p);
          files++;
        }
        // The folders themselves, which hold no files now but still list.
        for (const e of vfs.list(code)) if (e.isDir) vfs.remove(`${code}/${e.name}`);
        for (const p of vfs.walk(staging)) {
          vfs.remove(p);
          files++;
        }
        vfs.remove(staging);
        await mirror.flush();
        log(`reset: ${scripts} script(s) removed, ${files} file(s) — restarting`);
        doRestart();
        return { scripts, files };
      },
      /**
       * E9-143 — every script's presets and mappings, and nothing else.
       *
       * `~/dust/data` is where a script keeps what it was set to: its
       * `.pset` files, its `.pmap` MIDI mappings, and whatever its own
       * `init` wrote into its data folder. Emptying it is the honest
       * meaning of "reset the scripts' parameters" — the scripts
       * themselves stay installed and come back at their defaults.
       *
       * `system.state` AND `system.pset` ARE SPARED, and that is the
       * whole care in this function: they live in the same directory and
       * they are not a script's. They hold the clock tempo, the mixer
       * levels, the clock source and which devices are which. Taking
       * them here would make this button a different button, and the one
       * below is where that belongs.
       */
      resetParams: async () => {
        const data = "/home/we/dust/data";
        const keep = /^system\.[^/]*$/;
        let files = 0;
        for (const p of vfs.walk(data)) {
          if (keep.test(p.slice(data.length + 1))) continue;
          if (!vfs.revert(p)) vfs.remove(p);
          files++;
        }
        for (const e of vfs.list(data)) if (e.isDir) vfs.remove(`${data}/${e.name}`);
        await mirror.flush();
        log(`reset: ${files} preset/mapping file(s) removed — restarting`);
        doRestart();
        return { files };
      },
      /**
       * E9-143 — a page that has never been used.
       *
       * NOT a file-by-file revert. Every other reset here works through
       * the overlay, which is right when something is meant to survive;
       * this one is meant to leave NOTHING, and the overlay's own
       * bookkeeping — the tombstones, the reference and placeholder
       * lists — is part of what would otherwise survive. So the whole
       * `norns-dust` directory goes, and the settings this page keeps in
       * `localStorage` with it.
       *
       * THE MIRROR IS STOPPED FIRST and never restarted, because the
       * next thing that happens is a reload. Flushing would be exactly
       * wrong here: it would write the overlay — which still holds
       * everything — straight back into the directory just removed.
       * Every other reset in this file flushes; this one must not, and
       * that is why it says so.
       *
       * A reload rather than `_norns.restart`: the restart path saves
       * `system.state` on its way out, which would put the first file
       * back into an origin that is supposed to be empty.
       */
      factoryReset: async () => {
        mirror.stop();
        const gone = await wipeOpfs();
        try {
          const store = globalThis.localStorage;
          for (const k of Object.keys(store ?? {})) {
            if (k.startsWith("norns-js/")) store.removeItem(k);
          }
        } catch {
          // A private window has no storage to clear; the wipe is what matters.
        }
        log(gone ? "factory reset: storage erased — reloading" : "factory reset: the browser refused to erase its storage");
        if (!gone) return { ok: false };
        setTimeout(() => globalThis.location?.reload(), 50);
        return { ok: true };
      },
      /**
       * E9-143 — the clock tempo, reachable when the norns screen is not.
       *
       * It lives at PARAMS > CLOCK > tempo, which is one of four panels
       * you reach with E1 — confirmed in the page, with no script loaded:
       * `panels = MIX, TAPE, HOME, PARAMS` and `groups = LEVELS | REVERB
       * | COMPRESSOR | SOFTCUT | CLOCK`. It is NOT under SYSTEM, which is
       * where this file's author first sent somebody looking.
       *
       * It is here as well because of how it was found: a phone whose
       * tempo was at 220 and whose interface was too slow to navigate to
       * the one place that could change it. A setting you cannot reach
       * when the page is struggling is a setting that does not exist on
       * the day you need it, and this panel is HTML — it answers when the
       * norns screen does not.
       */
      tempo: {
        get: () => {
          // READ OFF THE STACK, NOT OUT OF THE LOG. The first version
          // printed the value and scraped `host.output`, which is the
          // NODE harness's buffer: in the page `print` goes to the
          // console sink and that array never grows, so the field came
          // up empty. Measured by opening the panel and finding it so.
          if (host.run(`__njs_tempo = params:get("clock_tempo")`)) return 0;
          lua.lua_getglobal(host.L, to_luastring("__njs_tempo"));
          const v = lua.lua_tonumber(host.L, -1);
          lua.lua_pop(host.L, 1);
          return Number.isFinite(v) && v > 0 ? v : 0;
        },
        set: (bpm: number) => {
          const n = Math.max(1, Math.min(300, Math.round(bpm)));
          host.run(`params:set("clock_tempo", ${n})`);
          log(`clock: tempo ${n}`);
        },
      },
    },
  });
  // --- the community catalogue (E6-11) -----------------------------------
  //
  // Read live from norns.community's own data file. Installing reads the
  // repository's files one at a time through a CDN, because GitHub will not
  // let a page download an archive — measured, see src/community/install.ts.
  // The devices have just been placed for the first time, and the screen's
  // well now has its real size. See `onResized` for why the observer alone
  // does not catch this.
  refit();

  // --- maiden, phase 1 ---------------------------------------------------
  //
  // The editor the page has had no way to be: a tree over the dust store,
  // Ace with the Lua mode, and save. See docs/08-MAIDEN.md for what it is
  // modelled on and what is still to come.
  //
  // `onToggle` is not decoration. The browser keyboard IS the norns panel
  // here — `q` and `w` turn encoder 1 — so typing Lua with the keymap live
  // would drive the instrument from the editor. The same switch the gear
  // and the community panel use.
  // sclang, once the audio graph has started. The repl reads it through a
  // closure for the same reason the stage reads the machine through one:
  // it exists later than the thing that wants it.
  let scEngine: Awaited<ReturnType<typeof createEngineHost>> | null = null;
  /**
   * The engine classes the SERVER has reported, for anything out here that
   * needs to know what exists.
   *
   * E9-109 — `engineState` is declared inside the audio boot, which is a
   * function away and several hundred lines down, and the list only exists
   * once scsynth has answered. A reader rather than the object: before the
   * engines are reported this is empty, which reads as "nobody told us" and
   * is exactly right.
   */
  let liveEngines: () => readonly string[] = () => [];
  const maidenButton = $("#maiden");
  const maiden = createMaidenPanel({
    host: $("#maidenpanel") as HTMLElement,
    // The restart the session has earned, asked about on the way OUT of
    // the panel — which is the moment it matters, because the next thing
    // anybody does after closing it is go and play the script.
    restart: {
      pending: () => (restartDeferred ? [] : [...restartOwed]),
      earned: restartEarned,
      now: doRestart,
      later: () => {
        restartDeferred = true;
        log("restart: deferred — the arrow in the rail still has it");
      },
    },
    store: createVfsStore(vfs),
    runner: createRunner(host),
    // The two consoles. `host.run` IS matron's standard input because the
    // page is matron, and `engine.runCode` is sclang's — the websockets
    // `ws-wrapper` puts on :5555 and :5556 exist to cross a machine
    // boundary that is not here. sclang is absent until the audio graph
    // starts, and a console that says so is better than a tab that is not
    // there yet.
    repl: [
      { name: "matron", lines: () => host.output, send: (code) => host.run(code) },
      {
        name: "sc",
        lines: () => scEngine?.scLog ?? [],
        send: (code) => {
          if (scEngine === null) return "sclang is not up yet";
          scEngine.runCode(code);
          return null;
        },
      },
    ],
    // The project activity, over the machinery the community panel already
    // had: there is no catalogue of our own and there will not be one.
    project: {
      // E9-69 — opening this IS "refresh the library in maiden", so it
      // leaves what a refresh leaves: `~/dust/data/catalogs/base.json`
      // and `community.json`, which is where `folio` reads the library
      // from. The community catalogue is fetched once and used twice.
      catalog: () => fetchAndStoreCatalogs(vfs, { log }),
      // E9-56 — a FOLDER is not a script. This listed every directory
      // under `~/dust/code`, and an empty one is a directory: 281 of the
      // 329 here were the leftovers of removed scripts, every one of them
      // offered as installed with an `update` and a `remove` button, and
      // nothing in SELECT to choose. Asked about by a user who could see
      // `terrarium` in the installed list and not in the menu.
      //
      // The bar is one file, not a `<name>.lua`: several of these ARE
      // installed and are libraries rather than scripts — `nb`,
      // `midigrid`, `passthrough` — and saying those are not installed
      // would be the same lie the other way round.
      installed: () =>
        vfs
          .list("/home/we/dust/code")
          .filter((e) => e.isDir && vfs.walk(`/home/we/dust/code/${e.name}`).length > 0)
          .map((e) => e.name),
      install: async (entry, signal, onProgress) => {
        const repo = parseRepoUrl(entry.url);
        if (!repo) throw new Error("that entry does not point at a GitHub repository");
        return installFromRepo(vfs, repo, {
          name: entry.name.toLowerCase(),
          signal: withStallTimeout(signal),
          onProgress: (p) => onProgress(p.done, p.total),
          // E9-72 — read at the moment of the install, not captured at
          // boot: somebody who raises the limit because a script was
          // refused expects the next attempt to use the new number.
          maxFiles: settings.installMaxFiles,
          // E9-140 — "installed" has to mean on disk. See install.ts.
          commit: () => mirror.flush(),
        });
      },
      installUrl: async (url, signal, onProgress) => {
        const repo = parseRepoUrl(url);
        if (!repo) throw new Error("that is not a GitHub repository url");
        return installFromRepo(vfs, repo, {
          signal: withStallTimeout(signal),
          onProgress: (p) => onProgress(p.done, p.total),
          maxFiles: settings.installMaxFiles,
          commit: () => mirror.flush(),
        });
      },
      onEngines: (names) => {
        for (const n of names) restartEarned(n);
      },
      // E9-32. The panel owns the sentence; the filesystem lives here.
      // E9-109 — and the engines the PAGE has, not only the ones a script
      // shipped. Without that list every script that asks for a built-in
      // engine was reported as short of it, in the same sentence as a
      // dependency that really was missing.
      needs: (name, entries, absent) =>
        needsOf(vfs, name, entries, "/home/we/dust", liveEngines(), absent ?? []),
      remove: (name) => {
        const dir = `/home/we/dust/code/${name}`;
        for (const p of vfs.walk(dir)) vfs.remove(p);
        vfs.remove(dir);
      },
      log: (l) => log(l),
    },
    prefs: settings.editor,
    onPrefs: (p) => settings.setEditor(p),
    log: (l) => log(l),
    onToggle: (on) => {
      dialogOpen = on;
      // The editor covers the page, rail and all, so a panel left open
      // under it would come back when the editor went away (E9-93).
      if (on) closeOtherPanels(null);
      maidenButton.setAttribute("aria-expanded", String(on));
    },
  });
  maidenButton.addEventListener("click", () => maiden.toggle());

  // --- the devices panel --------------------------------------------------
  //
  // The bottom row's buttons, moved rather than rewritten: they kept their
  // ids and their `data-size`, so everything that drives them is untouched
  // and this only decides when they are on screen.
  const devicesButton = $("#devices");
  const devicesPanel = $("#devicespanel") as HTMLElement;
  const showDevices = (on: boolean): void => {
    if (on) closeOtherPanels(devicesToken);
    devicesPanel.hidden = !on;
    devicesButton.setAttribute("aria-expanded", String(on));
  };
  const devicesToken = railPanel(() => devicesPanel.hidden === false, () => showDevices(false));
  devicesButton.addEventListener("click", () => showDevices(devicesPanel.hidden === true));
  // A click anywhere else puts it away, which is what a popover does — and
  // not a click INSIDE it, or choosing a grid size would close it before
  // you could rotate the grid, and dragging the level would close the panel
  // on the way past its edge.
  //
  // ONE PAIR OF LISTENERS FOR ALL FOUR. This is DISMISSAL and not
  // exclusion: what keeps one panel open at a time is `railPanels`
  // above, which each panel consults as it opens. The gear is not in
  // this list on purpose — it has to survive a click on a device, which
  // is what arranging is — and Escape is left to it too, because while it
  // is capturing a key binding Escape means cancel.
  const popovers: Array<[HTMLElement, (on: boolean) => void, HTMLElement]> = [
    [devicesPanel, showDevices, devicesButton],
    [soundPanel, showSound, soundButton],
    [zoomPanel, showZoom, zoomButton],
    [restartPanel, showRestart, restartButton],
  ];
  document.addEventListener("click", (e) => {
    for (const [panel, show, button] of popovers) {
      if (panel.hidden) continue;
      const t = e.target as Node;
      if (panel.contains(t) || button.contains(t)) continue;
      show(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const [panel, show] of popovers) if (!panel.hidden) show(false);
  });

  if (!settings.persisted) {
    log("settings: this browser is not keeping them — changes last for this page only");
  }

  // --- MIDI (E5-07) ------------------------------------------------------
  //
  // `startWebMidi` is NOT awaited. `requestMIDIAccess` can put a permission
  // prompt on the screen, and a page that waits for an answer before drawing
  // its first frame is a page that looks broken until you notice the prompt.
  // A device that arrives later is a hot-plug, which is a path that has to
  // work anyway.
  // --- the clock source (E3-09) -----------------------------------------
  //
  // The MIDI clock source is built HERE, before the audio block, because the
  // bytes arrive from MIDI and MIDI starts first. `liveClock` is filled in
  // when the worklet clock exists; until then a tick is measured and
  // discarded, which is what a norns does before its audio thread is up.
  let clockSource: ClockSource = "internal";
  let liveClock: Clock | null = null;
  const midiClock = new MidiClockSource({
    onReference: (ref) => {
      if (clockSource !== "midi") return;
      liveClock?.setSourceReference(ref.beat, ref.beatDuration);
    },
    onStart: () => {
      if (clockSource !== "midi") return;
      // `clock_start_from_source` resets the sync events and posts
      // EVENT_CLOCK_START. `transportStart` does both; its beat reset is a
      // no-op here because the first tick after 0xFA is beat 0 anyway.
      liveClock?.transportStart();
      const e = cb.clockStart();
      if (e) log(`clock.start: ${e.message}`);
    },
    onStop: () => {
      if (clockSource !== "midi") return;
      liveClock?.transportStop();
      const e = cb.clockStop();
      if (e) log(`clock.stop: ${e.message}`);
    },
  });

  const midiManager = new MidiManager({
    midiAdd: (id, name, dev) => {
      const e = cb.midiAdd(id, name, dev as never);
      if (e) log(`midi.add: ${e.message}`);
      dirty = true;
    },
    midiRemove: (id) => void cb.midiRemove(id),
    // E9-179 — no `dirty`: a controller sending a stream of CCs was
    // repainting the screen per message. What the script draws in
    // response reaches the canvas through `screen.update()`.
    midiEvent: (id, bytes) => {
      const e = cb.midiEvent(id, bytes);
      if (e) log(`midi.event: ${e.message}`);
    },
    // Every device with clock reception enabled feeds the same source, which
    // is matron's arrangement too: `clock_midi_handle_message` is global and
    // `Midi.update_clock_receive` is what narrows it to one device.
    clockByte: (_id, byte, at) => midiClock.handle(byte, at),
  });
  registerMidi(host.registry, midiManager, { log: (l) => log(l) });
  // crow and serial: not implemented, and saying so clearly (E5-10).
  registerSerial(host.registry, { log: (l) => log(l) });
  // Exposed whether or not the browser grants MIDI: the manager is how a
  // device gets attached at all, and SYSTEM > DEVICES (E5-08) will need it
  // on a machine that refused the permission just as much as on one that
  // granted it.
  expose({ midi: midiManager, opfs: mirror, arc: arcManager });
  void startWebMidi(midiManager, { log: (l) => log(l) }).then((w) => {
    if (w !== null) expose({ webmidi: w });
    // Kept so the gear can list the ports. The ACCESS and not a snapshot:
    // its `inputs` and `outputs` are live maps, so a device plugged in
    // while the panel is open appears without anything having to be told.
    webMidiAccess = w;
  });

  // The loopback, which is a cable you plug in rather than a device that is
  // there. `Midi.add` fires on attach and `Midi.remove` on detach, so a
  // running script sees it as a hot-plug — the same path a real device takes.
  let virtualMidi: VirtualMidiPort | null = null;
  let virtualMidiId = -1;
  /**
   * The virtual loopback: a cable with both ends in the same box.
   *
   * ITS BUTTON IS IN THE GEAR NOW, under `midi`, and not in the rail (user,
   * 2026-11-13). The icon was a cable looping back on itself, which reads as
   * a circular arrow — and the restart button added beside it IS a circular
   * arrow. Two round arrows in one column of six is a rail you have to read
   * instead of recognise, which is the whole argument for icons. This is
   * also the rarer of the two, and a setting rather than a gesture.
   */
  const toggleLoopback = (): void => {
    if (virtualMidi === null) {
      virtualMidi = createVirtualMidiPort();
      const d = midiManager.add(virtualMidi);
      virtualMidi.attach(d);
      virtualMidiId = d.id;
      log("midi: virtual loopback attached");
    } else {
      midiManager.remove(virtualMidiId);
      virtualMidi = null;
      virtualMidiId = -1;
      log("midi: virtual loopback detached");
    }
    dirty = true;
  };

  log(`booted, ${installed} community scripts in ~/dust/code.`);
  // Everything from here is somebody using the thing rather than it
  // starting up, and a profile ranks the two apart. E9-162.
  profileRun?.mark();
  if (probe !== null && profile !== null) {
    /**
     * E9-200 — WHAT THE NUMBERS BELOW WERE TAKEN WITH.
     *
     * Three lines that turn every later one from a reading into a
     * measurement: which machine, how fine its clock is and what reading
     * it costs, and which of the browser's own instruments exist here.
     * A profile from a phone that lacks one of them should say so at the
     * top rather than leave a line missing forty lines down.
     */
    const nav = navigator as unknown as { deviceMemory?: number };
    const sc = globalThis.screen;
    log(`profile machine: ${navigator.userAgent}`);
    log(
      `profile machine: ${navigator.hardwareConcurrency ?? "?"} core(s), ` +
        `${nav.deviceMemory ?? "?"} GB reported, dpr ${globalThis.devicePixelRatio ?? 1}, ` +
        `screen ${sc?.width ?? "?"}x${sc?.height ?? "?"}, ` +
        `isolated ${String(globalThis.crossOriginIsolated)}, ${batteryNote}`,
    );
    // What `timed()` adds to the account it keeps, and what it costs the
    // caller, so both can be taken off any path by its call count.
    const N = 20000;
    const noop = (): void => {};
    const t0 = performance.now();
    for (let i = 0; i < N; i++) timed("(calibration)", noop);
    const wallNs = ((performance.now() - t0) * 1e6) / N;
    const got = callCosts().find((c) => c.path === "(calibration)");
    const recordedNs = got === undefined ? 0 : (got.ms * 1e6) / got.calls;
    log(
      `profile clocks: performance.now() steps by ${(clockStepMs(() => performance.now()) * 1000).toFixed(1)} us · ` +
        `an empty span between two reads measures ${probe.pairNs.toFixed(0)} ns · ` +
        `timed() records ${recordedNs.toFixed(0)} ns for an empty call and costs its caller ${wallNs.toFixed(0)} ns ` +
        `(over ${N} calls, which appear below as "(calibration)")`,
    );
    const has = (ok: boolean): string => (ok ? "yes" : "NO");
    const types = (globalThis.PerformanceObserver?.supportedEntryTypes ?? []) as readonly string[];
    log(
      `profile has: js heap ${has((performance as unknown as { memory?: unknown }).memory !== undefined)} · ` +
        `long frames ${has(types.includes("long-animation-frame"))} · ` +
        `event timing ${has(types.includes("event"))} · ` +
        `pressure ${has(typeof (globalThis as unknown as { PressureObserver?: unknown }).PressureObserver === "function")} · ` +
        `lua sampling ${profile.lua ? "ON (&lua)" : "off"} · ` +
        `playback statistics are looked for when audio starts`,
    );
  }
  log("SELECT lists the scripts. The gear has the key bindings.");

  // --- audio -------------------------------------------------------------
  //
  // Deliberately last, and not awaited before the menu is usable: the two
  // wasm modules are 5.8 MB and sclang then compiles 2320 classes, so making
  // the first frame wait for them would put several seconds of blank screen
  // in front of a user for no reason.
  //
  // The clock is created on SCSYNTH'S AudioContext rather than one of its
  // own. Two contexts would mean two device callbacks, two sets of latency,
  // and a clock whose frames count a different stream from the one making
  // the sound — which is exactly the drift the frame-counting design exists
  // to avoid.
  void startAudio();

  async function startAudio(): Promise<void> {
    // LET THE SCREEN PAINT FIRST. Everything below is one long run of
    // synchronous work — instantiating two wasm modules and compiling
    // sclang's class library, which is 373 files and 2434 classes — and
    // the main thread does not yield inside it. Without this the menu is
    // drawn into the surface at boot and never reaches the canvas, so the
    // page sits black for as long as that takes. Reported as "the screen
    // stayed black at first, then appeared after a while": the screen was
    // fine, the browser simply never got a frame.
    //
    // E9-164 — AND NOT FOR EVER IF NO FRAME EVER COMES. A tab that is
    // occluded or backgrounded is painted no frames at all, while still
    // reporting itself visible, and this await then never resolves:
    // scsynth and sclang are never loaded, there is no engine and no
    // sound, and nothing says so because the line that would have is on
    // the other side of it. See `ui/first-paint.ts`.
    await afterPaint();

    let engineState: ReturnType<typeof registerEngine> | null = null;
    // Kept so the console tap below can reach it: crone is the only node
    // between the engine and the speakers, and measuring there is how
    // "does this script make a sound" gets answered without ears.
    let croneForConsole: Awaited<ReturnType<typeof startCrone>> | null = null;
    let croneLoad: import("./crone/crone.js").CroneLoad | null = null;
    // EVERY SCRIPT'S OWN SuperCollider CLASSES, not just norns'. This is
    // what makes `engine.name = "Amen"` resolve: norns puts `~/dust/code` on
    // sclang's class path, so an engine a script ships is compiled into the
    // class library at startup and appears in `engine.names`. Without it a
    // script with a custom engine loads, draws its splash, and has no
    // engine — and nothing says why, because from Lua's side the name is
    // simply not in the list.
    //
    // E9-55 — `.scd` TOO, because a class can load one. `Engine_R.sc` is
    // eleven lines; everything it does is
    //
    //     "r.scd".resolveRelative.load
    //
    // and with only the `.sc` staged that resolved to
    // `/sc/SCClassLibrary/dust/r/lib/r.scd`, which was not there:
    //
    //     file "/sc/SCClassLibrary/dust/r/lib/r.scd" does not exist.
    //     norns-js: engine Engine_R failed to allocate
    //     ERROR: Nil does not understand the message 'at'.
    //
    // `R` was in `engine.names`, loaded, and registered NOT ONE command, so
    // `moln` and `torii` died on their first `engine.new`. A `.scd` is not
    // compiled — sclang's class-library pass reads `.sc` and nothing else —
    // so writing them beside the classes costs a few kilobytes and no risk.
    const extraClasses = new Map<string, string | Uint8Array>();
    const decoder = new TextDecoder();
    for (const path of vfs.walk("/home/we/dust/code")) {
      if (!path.endsWith(".sc") && !path.endsWith(".scd")) continue;
      const bytes = vfs.read(path);
      if (bytes === null) {
        // A `.sc` that is DECLARED and not resident. The build packs text
        // inline, so this should not happen — and if it ever does, the
        // symptom is the one the comment above describes: a script with a
        // custom engine that loads, draws, and has no engine. Said, rather
        // than skipped in silence.
        if (vfs.remoteAt(path) !== null) {
          log(`engine: ${path} has not been fetched; its class is not compiled`);
        }
        continue;
      }
      // E9-66 — TWO BAD CHARACTERS COST THREE SCRIPTS THEIR AUDIO.
      //
      // The class library compiles as one unit, so a single malformed `.sc`
      // does not fail alone: it takes sclang down, and with it every engine
      // on the machine. `lissadron` ends on an unclosed `/*` and `sway`
      // carries a stray U+FEFF; both crash the compiler with no file named.
      // `repairScSource` fixes exactly those two, says which file it
      // touched, and leaves anything else byte for byte alone.
      const name = path.slice("/home/we/dust/code/".length);
      const { text, repairs } = repairScSource(name, decoder.decode(bytes));
      for (const line of repairs) log(`engine: ${line}`);
      extraClasses.set(name, repairs.length > 0 ? text : bytes);
    }

    // What every bundled sound file is, so sclang's `SoundFile.openRead` can
    // answer without libsndfile. The VFS already carries it: the dust build
    // measured channels, frames and rate for every audio asset because the
    // page needs them to decode.
    // WHAT `SoundFile.openRead` CAN SEE, and it used to be half of it.
    //
    // The build records frames, channels and rate for every sound file a
    // bundled script ships, so a file whose bytes have not been fetched can
    // still answer. But the table was built ONLY from those declarations —
    // so a file that is actually present, installed from the catalogue or
    // restored from OPFS, had no entry at all. sclang's `openRead` returned
    // nil and Timber refused it with "Could not open file": the one sample
    // the user chose was the one the sampler could not open.
    //
    // A resident file's header is right here, and the same parser the build
    // uses reads it. WAV only — a resident .aif or .flac is still invisible,
    // because nothing here can parse one synchronously, and `openRead` must
    // answer synchronously.
    const soundFiles = new Map<string, { frames: number; channels: number; sampleRate: number }>();
    let fromHeader = 0;
    for (const path of vfs.walk("/home/we/dust")) {
      const declared = vfs.remoteAt(path)?.audio;
      if (declared !== undefined) {
        soundFiles.set(path, declared);
        continue;
      }
      if (!/\.wav$/i.test(path)) continue;
      const bytes = vfs.read(path);
      if (bytes === null) continue;
      const parsed = parseWavHeader(bytes);
      if (parsed === null) continue;
      soundFiles.set(path, parsed);
      fromHeader++;
    }
    if (fromHeader > 0) log(`sound files: ${fromHeader} read from their own headers`);

    let engine = (scEngine = await createEngineHost({
      log: (l) => log(l),
      soundFiles,
      // E9-179 — no `dirty`: a poll reply is not a drawing. `engineState`
      // is read by Lua, and Lua redrawing ends in `screen.update()`.
      onMatron: (m) => void engineState?.onMatron(m.address, m.args),
      // The browser is holding the engine until somebody touches the page.
      // The log already says so, but a console nobody has opened is not an
      // answer to a page that looks stalled.
      onNeedsGesture: (waiting) => void (needsGesture = waiting, showGate()),
      extraClasses,
    }));

    const injected = await engine.injectNorns();
    // Counted separately, because they fail differently: a community class
    // that does not compile takes the WHOLE library with it, on hardware as
    // well as here, and "20 injected" with a library that refused to build
    // is a different situation from "20 injected" and a working one.
    log(
      `${injected} classes injected into MEMFS ` +
        `(${extraClasses.size} .sc/.scd from ~/dust/code)`,
    );

    // CAUGHT, not just checked. A class that crashes the compiler can
    // take sclang down two ways: the abort that leaves the boot waiting
    // until its own timeout, and a wasm `memory access out of bounds`
    // that REJECTS. The first draft of this retry handled only the
    // first, so batch 7 sat at eight keys for three minutes with no
    // retry line in the log.
    const sclangUp = await engine.bootSclang().catch(() => false);
    if (!sclangUp) {
      // E9-48 — ONE SCRIPT'S CLASS MUST NOT BRICK THE APP.
      //
      // `lissadron/lib/Engine_Lissadron.sc` crashes sclang's class-library
      // compiler outright — `worker sent an error! Uncaught 10236728`, then
      // ninety seconds of waiting and `sclang did not boot`. Measured by
      // bisecting a batch of twenty-five: put that one file back and the
      // crash returns every time.
      //
      // What the user saw was an app with no audio and no way to know why,
      // and no cure short of wiping storage — the file is restored from
      // OPFS on every load, so every reload fails the same way.
      //
      // So the second attempt leaves the scripts' own classes out. The
      // engine comes up, every bundled engine works, and the ones a script
      // brought are gone WITH A LINE SAYING SO. That is a worse norns than
      // the one with the classes and a far better one than none.
      if (extraClasses.size > 0) {
        log(
          `sclang did not boot — retrying without the ${extraClasses.size} ` +
            `class(es) from ~/dust/code`,
        );
        extraClasses.clear();
        engine = scEngine = await createEngineHost({
          log: (l) => log(l),
          soundFiles,
          onMatron: (m) => void engineState?.onMatron(m.address, m.args),
          onNeedsGesture: (waiting) => void (needsGesture = waiting, showGate()),
          extraClasses,
        });
        await engine.injectNorns();
        const again = await engine.bootSclang().catch(() => false);
        if (!again) {
          log("sclang did not boot, with or without them");
          return;
        }
        log(
          "sclang booted WITHOUT the installed scripts' SuperCollider " +
            "classes: one of them crashes its compiler. Scripts that bring " +
            "their own engine will report it missing until that script is " +
            "removed.",
        );
      } else {
        log("sclang did not boot");
        return;
      }
    }
    const { ready, ctx } = await engine.bootServerFromSclang();
    if (!ready || !ctx) {
      log("scsynth did not come up");
      return;
    }

    // THE MASTER, BETWEEN EVERYTHING AND THE SPEAKERS.
    //
    // One gain and one meter, and every path to the destination goes through
    // them -- crone's output when crone is there, scsynth's own node when it
    // is not. Two reasons, and the second is the one that matters:
    //
    //   * the gain is where muting happens, and the choice is remembered;
    //
    //   * the METER IS BEFORE THE GAIN, so a muted page can still be
    //     measured. That is what lets the exerciser (E5-23) answer "did this
    //     script make a sound" with the output turned down to nothing.
    // TAKEN BEFORE THE MASTER EXISTS, and that is the whole subtlety.
    // `captured.toDestination` is fed by a patched `AudioNode.prototype.
    // connect` (engine/capture.ts:54), so EVERY node that reaches the
    // destination lands in it — including the master we are about to make.
    // Re-routing the live list afterwards therefore unplugs the master and
    // wires it into crone's input: crone -> meter -> master -> crone, a
    // feedback loop, silent only because the mute is on. Measured as a
    // meter that read 0.000 for a 0.3 oscillator plugged straight into it.
    const scsynthOut = [...captured.toDestination];
    const master = ctx.createGain();
    const meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    meter.connect(master);
    master.connect(ctx.destination);
    // THE MUTE AND THE LEVEL ARE ONE NUMBER on this gain, which is why
    // there is one function rather than two: a mute that multiplied a level
    // would be a second gain node to keep in step, and the two would drift
    // the first time one of them was set from somewhere the other did not
    // know about.
    //
    // `setTargetAtTime` rather than an assignment, and 12 ms: a gain that
    // jumps mid-block is a step in the waveform, which is a click. Dragging
    // a fader is hundreds of those.
    const levelNow = (): number => (settings.muted ? 0 : dbToGain(settings.volumeDb));
    const setLevel = (): void => {
      master.gain.setTargetAtTime(levelNow(), ctx.currentTime, 0.012);
    };
    master.gain.value = levelNow();
    settings.subscribe((_st, what) => {
      if (what === "muted" || what === "volume") setLevel();
    });
    applyMute = () => setLevel();
    // The pickers in the gear have something to talk to now (E9-15). The
    // stored output is applied on the way past: a choice that only took
    // effect the next time you opened the panel would look like it had not
    // been remembered.
    audioContext = ctx;
    reportAudioLatency(ctx);
    /**
     * E9-165 — THE LAST GATE BEFORE THE SPEAKERS, said out loud.
     *
     * `__norns.peak()` is taken on crone's output, which is BEFORE this
     * gain — deliberately, so a muted page can still be measured. The
     * consequence is that every instrument in this project can report a
     * healthy signal for a page that is making no sound at all, because
     * nothing ever looked at the one number between the mixer and the
     * destination.
     */
    log(
      `audio: master at ${settings.muted ? "0 (muted)" : `${settings.volumeDb} dB`}` +
        `, context ${ctx.state}`,
    );
    if (settings.audioOut !== "") void applyOutputDevice();
    expose({ master, meter, peak: () => peakOf(meter) });

    // CRONE, BETWEEN scsynth AND THE SPEAKERS.
    //
    // This is norns' topology and not a refinement of it: the mixer, the
    // monitor, the reverb, the compressor, the sends to softcut and the six
    // softcut voices all live in crone. An engine wired straight to the
    // destination plays, and then `level_ext`, `level_monitor`, every
    // `softcut.*` call and the tape do nothing — which is most of what a
    // community script asks for. `amen` is 14 softcut calls in its `init`
    // alone.
    //
    // `captured.toDestination` is the node scsynth connected; the capture
    // shim in engine/capture.ts exists because sclang hands back emscripten
    // handles rather than objects.
    try {
      const tapePaths = createTapePaths();
      const tapeWriter = croneTapeWriter(vfs, tapePaths, ctx.sampleRate, cb, (l) => log(l));
      const crone = await startCrone({
        context: ctx,
        log: (l) => log(l),
        /**
         * E9-166 — AND THE LEVELS GO PAST A WATCHER ON THE WAY.
         *
         * `croneEvents` hands the twelve peaks to matron, which draws
         * them on an overlay. They are also the only measurement in this
         * project taken INSIDE the audio thread, at the points where
         * sound is actually lost — so they go past `output-watch.ts`
         * first. Wrapped rather than replaced: matron must still get
         * every reading, on time, or the overlay stops moving.
         */
        events: (() => {
          const base = croneEvents(cb, (l) => log(l));
          return {
            ...base,
            vu: (levels: number[]) => {
              watchVu(levels);
              base.vu?.(levels);
            },
          };
        })(),
        onFileWritten: croneFileWriter(vfs, (l) => log(l)),
        onTapeData: (pcm) => tapeWriter.onTapeData(pcm),
        onTapeFinished: (d) => tapeWriter.onTapeFinished(d),
        // E4-14. Kept, not logged: one line a second would bury everything
        // else. `__norns.load` is where to read it.
        onLoad: (l) => {
          croneLoad = l;
          // E9-183 — and into the phase window, which is the only place
          // softcut's cost has ever been visible from.
          foldCrone(dspPhase, l);
          // What `_norns.audio_get_cpu_load` and `_norns.audio_get_xrun_count`
          // answer with (E5-24). The xruns accumulate and are cleared by a
          // read, because that is what jack's counter does.
          audioLoad = { meanMs: l.meanMs, budgetMs: l.budgetMs };
          hardware.noteXruns(l.over);
          if (l.over > 0) log(`audio: ${l.over} of ${l.blocks} blocks over budget`);
        },
      });
      registerCrone(host.registry, crone, {
        log: (l) => log(l),
        /**
         * E9-173 — SAID ONCE, WHEN A SCRIPT ASKS FOR AN INPUT THAT IS OFF.
         *
         * `mlr` and `oooooo` are live loopers: they record whatever is
         * coming in and play that back, and they ship no sound of their
         * own. On a norns there is always an input. Here it is off until
         * somebody turns it on, so both load perfectly, draw their
         * interface, answer every key, and are silent for ever — which
         * was reported twice as "no sound, but maybe I don't know how to
         * use it". Both times the answer was that the instrument was
         * right and nothing told them.
         *
         * Once per script, because these call it per voice and per
         * channel — `oooooo` does it twelve times in one pass.
         */
        onWantsInput: () => {
          if (settings.audioInOn || saidInputIsOff) return;
          saidInputIsOff = true;
          log(
            "audio: this script records from the audio INPUT, and the input is off — " +
              "it will stay silent until you turn it on in the gear (the browser will " +
              "ask for a microphone). A looper ships no sound of its own.",
          );
        },
        files: {
          vfs,
          paths: tapePaths,
          callbacks: cb,
          decode: async (bytes) => await ctx.decodeAudioData(bytes.slice().buffer),
        },
      });

      // Re-route: scsynth -> crone input 0 (ext) -> destination. The
      // disconnect has to happen or the engine is heard twice, once through
      // the mixer and once around it, and `level_ext` would only move half
      // of it.
      for (const node of scsynthOut) {
        try {
          node.disconnect(ctx.destination);
        } catch {
          /* already gone */
        }
        node.connect(crone.node, 0, 0);
      }
      /**
       * E9-165 — AND HOW MANY, because none is the interesting number.
       *
       * The line below said "scsynth routed through the mixer" whether
       * this loop moved two nodes or none of them. `scsynthOut` is a
       * SNAPSHOT taken before the master exists, of whatever had already
       * connected itself to the destination — so a scsynth that reaches
       * the destination a moment later is never in it, never re-routed,
       * and never heard, while the log says it was routed.
       *
       * What that looks like from the outside is a page that boots
       * perfectly: the engine loads, the script runs, the clock keeps
       * time, the loop cycles, and there is no sound and nothing says
       * why. Reported on 2026-11-20 — `amen` installed after a factory
       * reset, every line in the log right, silence.
       *
       * It is also the only part of the chain nothing could see. The
       * meter is on crone's output, so `__norns.peak()` answers "did the
       * engine make a signal" — not "did it reach the mixer", which is
       * this, and not "did it leave the page", which is the master gain
       * below it.
       */
      if (scsynthOut.length === 0) {
        log(
          "audio: NOTHING was routed into the mixer — scsynth had not reached " +
            "the speakers when the mixer was built, so the engine plays into nothing",
        );
      }
      // CRONE INPUT 1 IS THE ADC (processor.js:16), kept apart from input 0
      // which carries the engine. A microphone summed into the engine bus
      // would make `level_adc` and `level_ext` the same control, which is
      // exactly what crone's two-input topology exists to prevent.
      adcInput = crone.node;
      if (settings.audioInOn) void applyInputDevice();
      crone.node.connect(meter);
      void crone.poll("vu", true);
      croneForConsole = crone;
      log(
        `crone: ${crone.voices} softcut voices, ${scsynthOut.length} scsynth output(s) ` +
          `routed through the mixer`,
      );
    } catch (err) {
      // A page without crone is still a usable norns: the engine reaches
      // the speakers, and softcut and the tape stay stubs. Saying so beats
      // a boot that stops here.
      log(`crone did not start: ${String((err as Error)?.message ?? err)}`);
      log("the engine goes straight to the speakers; softcut and the tape are stubs");
      // Still through the master, or the mute would be a lie on exactly the
      // path that is left when the mixer fails.
      for (const node of scsynthOut) {
        try {
          node.disconnect(ctx.destination);
        } catch {
          /* already gone */
        }
        node.connect(meter);
      }
    }

    engineState = registerEngine(host.registry, engine, {
      callbacks: cb,
      log: (l) => log(l),
      // Sound files into scsynth's buffers. scsynth has no libsndfile and
      // its MEMFS is not the VFS, so the browser decodes and the samples go
      // in over OSC. See src/engine/buffers.ts.
      buffers: createBufferLoader({
        vfs,
        context: ctx,
        sendToServer: (a, g) => engine.sendToServer(a, g as never),
        sendToLang: (a, g) => engine.sendToLang(a, g as never),
        // E9-171 — so "the buffer is ready" means the server has it.
        syncServer: (ms) => engine.syncServer(ms),
        peekBuffer: (b, i, n, ms) => engine.peekBuffer(b, i, n, ms),
        log: (l) => log(l),
      }),
      onReady: () => {
        log("audio ready");
      },
    });

    if (probe !== null) {
      /**
       * E9-200 — THE OSC, WATCHED FROM OUTSIDE THE HOST.
       *
       * Everything in or out of either wasm module goes through four
       * properties: `sendOsc` and the reply callback, on each. Wrapping
       * those here sees every packet whatever sent it — `register.ts`
       * calls `sclang.sendOsc` directly and never passes `sendToLang` —
       * and leaves `host.ts` exactly as it is when nobody is profiling.
       */
      type Wasm = {
        sendOsc(b: Uint8Array): void;
        onOsc?: (b: Uint8Array) => void;
        onOscReply?: (b: Uint8Array) => void;
        runCode?(code: string, silent?: boolean): void;
      };
      const lang = engine.sclang as Wasm;
      const synth = engine.scsynth as Wasm;
      const ctxNow = ctx as unknown as { playbackStats?: unknown; playoutStats?: unknown };
      log(
        `profile has: playback statistics ${
          ctxNow.playbackStats !== undefined || ctxNow.playoutStats !== undefined
            ? "yes"
            : "NO — underruns will not be counted in this browser"
        } · sample rate ${ctx.sampleRate} Hz`,
      );

      /** What the flood below is waiting to hear, if anything. */
      let flood: { id: number; n: number; startedAt: number; sentAt: number } | null = null;
      let pingId = 0;

      const toLang = lang.sendOsc.bind(lang);
      lang.sendOsc = (b: Uint8Array): void => {
        probe.osc("to-lang", b);
        // `/command/…` — what a script sends an engine. The next packet
        // sclang produces is taken to be its answer.
        if (b.length > 9 && b[1] === 0x63 && b[2] === 0x6f && b[8] === 0x2f) probe.commandSent();
        toLang(b);
      };
      const toSynth = synth.sendOsc.bind(synth);
      synth.sendOsc = (b: Uint8Array): void => {
        probe.osc("to-server", b);
        toSynth(b);
      };
      const fromSynth = synth.onOscReply;
      synth.onOscReply = (b: Uint8Array): void => {
        probe.osc("from-server", b);
        fromSynth?.(b);
      };
      const fromLang = lang.onOsc;
      lang.onOsc = (b: Uint8Array): void => {
        // The two answers this probe asked for stop here. They are not
        // traffic and the router has no use for them.
        if (b.length > 12 && b[0] === 0x2f && b[1] === 0x6e && b[9] === 0x2f) {
          const name = oscName(b);
          if (name === "/norns-js/pong" || name === "/norns-js/scbench") {
            let args: Array<number | string> = [];
            try {
              args = (decodeOsc(b) as { args?: Array<number | string> }).args ?? [];
            } catch {
              /* an answer that cannot be read is not an answer */
            }
            if (name === "/norns-js/scbench") {
              const seconds = Number(args[0] ?? 0);
              const n = Number(args[1] ?? 0);
              log(
                `probe sclang bench: ${n} iterations in ${(seconds * 1000).toFixed(2)} ms by sclang's own clock ` +
                  `(${n > 0 ? ((seconds * 1e9) / n).toFixed(1) : "?"} ns each)`,
              );
              return;
            }
            const id = Number(args[0] ?? -1);
            if (flood !== null && id === flood.id) {
              const at = performance.now();
              const sendMs = flood.sentAt - flood.startedAt;
              const afterMs = at - flood.sentAt;
              log(
                `probe sclang flood: ${flood.n} commands sent in ${sendMs.toFixed(2)} ms ` +
                  `(${((sendMs * 1000) / flood.n).toFixed(2)} us each on this thread), ` +
                  `answered ${afterMs.toFixed(2)} ms after the last, ` +
                  `${(((at - flood.startedAt) * 1000) / flood.n).toFixed(2)} us a command end to end`,
              );
              flood = null;
              return;
            }
            probe.pong(id);
            return;
          }
        }
        probe.osc("from-lang", b);
        fromLang?.(b);
      };

      // The answering half, defined in sclang once. An internal port, so
      // `NornsJsOscPortOverride` leaves the address alone.
      lang.runCode?.(
        'OSCdef(\\njsPing, { |msg| NetAddr("127.0.0.1", 57120).sendMsg("/norns-js/pong", msg[1]) }, "/norns-js/ping");',
        true,
      );
      // Four a second: enough for a histogram over a five-second level,
      // and far below what sclang already does to itself with `/status`.
      setInterval(() => {
        if (globalThis.document?.hidden === true) return;
        const id = ++pingId;
        probe.pingSent(id);
        toLang(encodeOsc("/norns-js/ping", [id]));
      }, 250);

      probeRun = (what, n, text) => {
        if (what === "sclang_bench") {
          const iterations = Math.max(1000, Math.min(2_000_000, Math.floor(n) || 200_000));
          lang.runCode?.(
            `{ var t = Main.elapsedTime; var x = 0; ${iterations}.do { |i| x = x + (i % 7) }; ` +
              `NetAddr("127.0.0.1", 57120).sendMsg("/norns-js/scbench", Main.elapsedTime - t, ${iterations}) }.value;`,
            true,
          );
          return;
        }
        if (what === "sclang_flood") {
          // Commands as a script sends them, back to back, then one ping:
          // how long after the last send the ping comes home says whether
          // the interpreter kept up with this thread or fell behind it.
          const count = Math.max(1, Math.min(20000, Math.floor(n) || 2000));
          const address = `/command/${text === "" ? "cutoff" : text}`;
          const packets: Uint8Array[] = [];
          for (let i = 0; i < 50; i++) packets.push(encodeOsc(address, [800 + i]) as Uint8Array);
          const startedAt = performance.now();
          for (let i = 0; i < count; i++) toLang(packets[i % 50]!);
          const sentAt = performance.now();
          const id = ++pingId;
          flood = { id, n: count, startedAt, sentAt };
          toLang(encodeOsc("/norns-js/ping", [id]));
          return;
        }
        log(`probe ${what}: not a probe this page knows`);
      };
    }

    // The clock, on the engine's context.
    const clock = await createWorkletClock({
      context: ctx,
      // E9-179 — NO `dirty` HERE, and this pair is why the rule exists.
      // A metro fires up to a hundred times a second and draws nothing;
      // the Lua it calls draws, and Lua that draws ends in
      // `screen.update()`. See `present` for the measurement.
      onMetro: (idx, stage) => void cb.metro(idx, stage),
      onClock: (id, beat) => void cb.clockResume(id, beat),
      onStall: (seconds) => {
        // E9-112 — A STALL IS WHAT AN XRUN IS HERE.
        //
        // `_norns.audio_get_xrun_count()` was stubbed at zero, so the
        // `!!!` warning on norns' home overlay could never appear. On
        // hardware it counts jack's dropouts; here the equivalent is the
        // clock noticing wall time that no audio went with, which is the
        // same event seen from the other side.
        xruns++;
        log(`clock: ${seconds.toFixed(2)} s of wall time with no audio behind it`);
      },
      /**
       * E9-182 — SAID ONCE A RUN OF THEM, not once a drain.
       *
       * A page that is being throttled produces one of these every time
       * it is allowed to wake, so the honest report is the total over
       * the run rather than a line a second. The first is immediate,
       * because the first is the one that explains a script that has
       * just jumped; the rest are summed and said when it settles.
       */
      // E9-200 — only a profile asks how late each event arrived.
      ...(probe !== null ? { onLate: (ms: number) => probe.clockLate(ms) } : {}),
      onBacklog: (dropped, gapMs) => {
        backlogDropped += dropped;
        backlogRuns++;
        if (backlogRuns === 1) {
          log(
            `clock: ${(gapMs / 1000).toFixed(1)} s with nothing reading the clock — ` +
              `${dropped} metro tick(s) skipped rather than fired in a burst`,
          );
        }
        backlogAt = performance.now();
      },
    });
    liveClock = clock;
    registerClock(host.registry, clock, {
      onStub: (name, why) => log(`${name}: ${why}`),
      onSource: (source) => {
        clockSource = source;
        log(`clock source: ${source}`);
      },
    });
    expose({
      clock,
      engine,
      engineState,
      audio: ctx,
      crone: croneForConsole,
      load: () => croneLoad,
    });

    // Crone's own boot, which ends in /crone/ready and the boot gate.
    engine.runCode(`Crone.remoteAddr = NetAddr("127.0.0.1", 8888);
Crone.startBoot;`);
    log("crone booting…");

    // Ask, repeatedly, until Crone answers. `/crone/ready` is a REPLY and
    // nothing sends it unprompted.
    liveEngines = () => engineState?.engines ?? [];
    // The server exists now, so the status poll has something to ask.
    pollServer = () => engine.pollStatus();
    // E9-162 — and the reply it fetches is readable by the log now, not
    // only by `audio_get_cpu_load`. See `reportFrames`.
    audioStatus = () => engine.status;
    engineState.queryStartup();
  }
}

main().catch((e) => {
  log("failed");
  log(String(e?.stack ?? e));
  // A failure the console is closed for is a blank page with no explanation,
  // so this is the one thing that opens it by itself.
  const box = document.querySelector("#consolebox");
  if (box instanceof HTMLElement) box.hidden = false;
  document.querySelector("#consoletoggle")?.setAttribute("aria-pressed", "true");
});
