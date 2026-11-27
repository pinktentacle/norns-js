// D-02/D-03 — norns-js as an application.
//
//   npm run desktop            # run it from this checkout
//   npm run desktop:probe      # run it, self-check, print a report, exit
//   npm run desktop:dist       # build the Windows artefacts
//
// WHAT THIS IS, AND WHAT IT IS NOT. It is a window, an origin and a
// permission handler. It is NOT a second copy of norns-js: it serves the
// same `vite build` output the browser and the portable copy are served, and
// the day it needs a page of its own is the day this was the wrong idea.
// Everything the instrument does is still the page's.
//
// WHY IT CANNOT JUST OPEN THE FILE. scsynth is compiled with pthreads and
// needs `SharedArrayBuffer`, which only exists in a CROSS-ORIGIN ISOLATED
// document, which is granted by two response headers — and `file://` has no
// response headers at all. A native window changes none of that.
//
// WHY A CUSTOM SCHEME AND NOT A LOOPBACK SERVER, which is what this was
// first and which cost a user their scripts.
//
//   The dust tree does not live on the disk. It lives in the page's OPFS,
//   and OPFS is keyed BY ORIGIN. A loopback server has to choose a port; a
//   fixed port is a port something else may already hold, so this asked the
//   OS for a free one — and a free one is a DIFFERENT one each launch.
//   `http://127.0.0.1:62387` and `http://127.0.0.1:49711` are two origins
//   and therefore two separate, empty stores. Every launch opened a fresh
//   instrument and the scripts installed into the last one were still on the
//   disk, in a storage bucket nothing would ever ask for again.
//
//   A custom scheme has no port and no host to vary: `norns://app/` is the
//   same origin on this machine forever. Registered `standard` so it has a
//   real origin at all, and `secure` so it is a trustworthy one — isolation
//   and OPFS both require that. The bytes come from `respond()` in
//   `tools/serve.mjs`, the same function the portable copy's server calls,
//   so there is one answer rather than two that drift.
//
// NOTHING LISTENS. There is no socket, so there is no port to collide with
// and nothing offered to the network.

import { app, BrowserWindow, Menu, net, protocol, session, shell } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { respond } from "../tools/serve.mjs";
import { RELAY_PREFIX, relayRelease } from "../tools/gh-release.mjs";
import { INFO_PREFIX, relayInfo } from "../tools/info-relay.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "..");

/**
 * What gets served.
 *
 * Packaged, it is the portable copy's `app/` — the pruned build WITH its
 * `source/` tree inside it, because norns-js is AGPL and a distributed
 * binary is conveying under §6. The source offer has to be reachable from
 * the running app, and `tools/build-portable.mjs` already assembles exactly
 * that folder. From a checkout it is `dist/`, so `npm run desktop` shows you
 * what you just built.
 */
const PAYLOAD = app.isPackaged ? join(process.resourcesPath, "app") : join(ROOT, "dist");

/**
 * The one origin, for as long as this application exists.
 *
 * Changing either half of it abandons everything anybody has installed, so
 * it is a constant with a warning on it rather than a configurable.
 */
const SCHEME = "norns";
const ORIGIN = `${SCHEME}://app`;

// BEFORE `app.whenReady()`, which is not a style choice: schemes have to be
// registered before the protocol machinery starts, and a `registerSchemes`
// call afterwards is ignored in silence.
//
//   standard        — gives it a real origin. Without it every page is
//                     opaque, and an opaque origin has no storage at all.
//   secure          — a trustworthy origin. Isolation, OPFS, Web MIDI and
//                     the AudioContext all require one.
//   supportFetchAPI — the page fetches the dust tree and the wasm.
//   stream          — a `Response` with a body, rather than one buffer.
//   codeCache       — let Chromium cache the compiled JavaScript.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

/** Self-check and quit: the D-01 spike, kept as a mode of the real shell. */
const PROBE = process.argv.includes("--probe");
/** Open the dev tools on start. */
const DEBUG = process.argv.includes("--debug");
/**
 * Exercise ONE named script instead of whatever the probe would choose.
 *
 *   norns-js.exe --probe --script code/amen/amen.lua
 *
 * The probe picks `awake` when the tree has scripts and a bare sine when it
 * has none, which answers "does this build make a sound". It does not answer
 * "does THIS script work in a packaged application", and that is the question
 * a bug report asks. Installing still happens through the application; this
 * only runs what is already there, which is what makes two separate launches
 * a faithful test rather than a shortcut.
 */
const SCRIPT = (() => {
  const i = process.argv.indexOf("--script");
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
})();
/**
 * Play a tone for six seconds, loudly, and say what the meter read.
 *
 *   norns-js.exe --probe --tone
 *
 * FOR THE ONE QUESTION A METER CANNOT ANSWER. The exerciser's `peak` is
 * read BEFORE the master gain — deliberately, so that "did this script make
 * a sound" can be answered with the output turned down to nothing — so a
 * report of `peak 0.63` is entirely consistent with a person hearing
 * silence. Everything between the master and the speakers is outside this
 * program: the Windows per-application volume mixer, the default output
 * device, the headphones that are plugged into the other socket.
 *
 * So this makes a noise on purpose, with the master forced open, and the
 * only instrument that can finish the measurement is a pair of ears.
 */
const TONE = process.argv.includes("--tone");
/** Record a sine into a softcut voice and play it back. See probe.js. */
const SOFTCUT = process.argv.includes("--softcut");
/** Fill a buffer in scsynth with a constant and read it back. See probe.js. */
const BUFFERS = process.argv.includes("--buffers");
/** Ask the GitHub release relay for one file and report only that (E9-227). See probe.js. */
const RELAY = process.argv.includes("--relay");
/**
 * Queue several scripts through the real panel: `--install a,b,c`.
 *
 * Through the UI and not through the installer, which is the point — the
 * question is whether queueing works in the PACKAGED application, and an
 * installer called directly would skip the panel that drives it.
 */
const INSTALL = (() => {
  const i = process.argv.indexOf("--install");
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
})();
/** Load the named script and listen to it without touching anything. */
const LISTEN = (() => {
  const i = process.argv.indexOf("--listen");
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : 12;
})();

const line = (s) => process.stdout.write(`${s}\n`);

// ---------------------------------------------------------------------------
// The window's size and position, remembered.
//
// In `userData`, which is the whole point of an application: the page's own
// storage already survives here in a way a browser's "clear site data" cannot
// reach, and the window should not be the one thing that forgets.
// ---------------------------------------------------------------------------

const statePath = () => join(app.getPath("userData"), "window.json");

async function loadBounds() {
  try {
    const raw = JSON.parse(await readFile(statePath(), "utf8"));
    if (typeof raw?.width === "number" && typeof raw?.height === "number") return raw;
  } catch {
    // No file, or a broken one. A default window is the right answer to both.
  }
  return { width: 1280, height: 900 };
}

async function saveBounds(win) {
  if (win.isDestroyed()) return;
  const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  try {
    await mkdir(dirname(statePath()), { recursive: true });
    await writeFile(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    // A layout that could not be written is not worth a dialogue.
  }
}

// ---------------------------------------------------------------------------
// Security, which here means: say yes to two things and no to everything else.
// ---------------------------------------------------------------------------

/**
 * BOTH HANDLERS, and D-01 is why.
 *
 * Electron asks `setPermissionRequestHandler` for `midiSysex` and asks
 * `setPermissionCheckHandler` for BOTH `midi` and `midiSysex`. A shell with
 * only the first answers the check with its default, and the default is no —
 * which is the shape of the unresolved reports of `requestMIDIAccess`
 * failing inside Electron.
 *
 * Everything else is refused. The page has no use for a camera, a microphone
 * or a location, so a prompt for one would mean something had gone wrong.
 */
/**
 * `media` IS ON THE LIST NOW, and the reason is not "the page asked".
 *
 * A sound-card picker cannot exist without it. Measured in this shell both
 * ways: refused, `enumerateDevices` returns ONE output and ONE input with an
 * empty id and no label — a list with nothing in it, and nothing
 * `setSinkId` could be given; granted, three of each with real names. The
 * native picker that would avoid this, `selectAudioOutput()`, is undefined
 * in Chromium 156. So the choice is a microphone permission or no choice of
 * speaker at all, and E9-15 took the permission.
 *
 * WHAT MAKES THAT ACCEPTABLE HERE AND NOT IN A TAB: this window loads one
 * origin, `norns://app`, which is this application's own page. There is no
 * third-party content and no navigation away — `sendLinksOutside` makes
 * sure of the second. The gate that matters is therefore the button in the
 * gear, which is ours, and a second prompt from the shell would be asking
 * the same person the same question twice. Nothing captures until that
 * button is pressed: granting the permission only lets the page ASK.
 *
 * `setDevicePermissionHandler` has to agree as well, which is its own gate
 * on which devices a granted page may see — measured, because allowing one
 * without the other still produced an empty list.
 */
const ALLOWED = new Set(["midi", "midiSysex", "media", "audioCapture", "serial"]);

// ---------------------------------------------------------------------------
// E9-205 — a serial port, which is how a real grid, arc or crow is reached.
//
// ELECTRON HAS NO PORT PICKER. Chrome answers `navigator.serial.requestPort()`
// with a window of its own; here `select-serial-port` is raised instead and
// nothing happens until this file says which port. So the list is handed to
// the page, which shows it in the panel the `usb` button is in
// (`src/ui/port-chooser.ts`), and the id that was clicked comes back.
//
// USB ONLY. A machine's serial ports include Bluetooth ones, and none of
// them is a grid.
//
// WHAT IS REMEMBERED is the port that was CHOSEN, by its USB ids and serial
// number, in `serial-ports.json` beside the window's position. The device
// handler answers yes for those and for nothing else — answering yes for
// every serial port would hand the page the whole machine's, and it opens
// what it is given at start to see whether a grid is there.
// ---------------------------------------------------------------------------

const portsPath = () => join(app.getPath("userData"), "serial-ports.json");
let chosenPorts = [];
const portKey = (p) => `${p?.vendorId ?? ""}:${p?.productId ?? ""}:${p?.serialNumber ?? ""}`;
const isUsb = (p) => p?.vendorId !== undefined && p.vendorId !== "";

async function loadChosenPorts() {
  try {
    const raw = JSON.parse(await readFile(portsPath(), "utf8"));
    chosenPorts = Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : [];
  } catch {
    chosenPorts = [];
  }
}

async function rememberPort(port) {
  const key = portKey(port);
  if (!isUsb(port) || chosenPorts.includes(key)) return;
  chosenPorts.push(key);
  try {
    await mkdir(dirname(portsPath()), { recursive: true });
    await writeFile(portsPath(), JSON.stringify(chosenPorts));
  } catch {
    // Not remembered: the list is shown again next time, which is all it costs.
  }
}

/** A USB id as Electron gives it: a string, decimal. Hex is taken too. */
const usbId = (s) => (/^[0-9]+$/.test(String(s)) ? Number(s) : parseInt(String(s), 16));

function describePort(p) {
  const what = p.displayName || "serial device";
  const name = p.portName && !what.includes(p.portName) ? `${what} (${p.portName})` : what;
  const vid = usbId(p.vendorId);
  const pid = usbId(p.productId);
  const hint =
    vid === 0x0403
      ? "an FTDI serial chip — most grids and arcs are one"
      : vid === 0x0483 && pid === 0x5740
        ? "an STM32 serial port — a crow is one"
        : undefined;
  return { id: p.portId, name, ...(hint ? { hint } : {}) };
}

/** The ports worth showing, the likely ones first. */
function portsToShow(list) {
  const likely = (p) => (usbId(p.vendorId) === 0x0403 || usbId(p.vendorId) === 0x0483 ? 0 : 1);
  return list.filter(isUsb).sort((a, b) => likely(a) - likely(b)).map(describePort);
}

/** What the probe reads back: was the question raised, and with how many ports. */
const serialSeen = { raised: 0, ports: 0, usb: 0 };

function offerSerialPorts(ses) {
  /** The question in front of the user, if there is one. */
  let asking = null;
  const refresh = () => {
    if (asking === null) return;
    const list = JSON.stringify(portsToShow(asking.ports));
    asking.webContents
      .executeJavaScript(`window.__nornsPortList && window.__nornsPortList(${list})`)
      .catch(() => {});
  };

  ses.on("select-serial-port", (event, portList, webContents, callback) => {
    event.preventDefault();
    // A second question closes the first unanswered.
    asking?.answer("");
    const ports = [...portList];
    serialSeen.raised++;
    serialSeen.ports = ports.length;
    serialSeen.usb = ports.filter(isUsb).length;
    let done = false;
    const answer = (id) => {
      if (done) return;
      done = true;
      if (asking?.answer === answer) asking = null;
      // ONLY AN ID THAT WAS OFFERED. The page returns a string, and a
      // string is not a port until it is one of these.
      const port = ports.filter(isUsb).find((p) => p.portId === id);
      if (port !== undefined) void rememberPort(port);
      callback(port !== undefined ? port.portId : "");
    };
    asking = { ports, webContents, answer };
    webContents
      .executeJavaScript(`window.__nornsChoosePort(${JSON.stringify(portsToShow(ports))})`, true)
      .then(
        (id) => answer(typeof id === "string" ? id : ""),
        () => answer(""),
      );
  });

  // Plugged in or pulled out while the list is open: the list follows.
  ses.on("serial-port-added", (_event, port) => {
    if (asking === null || asking.ports.some((p) => p.portId === port.portId)) return;
    asking.ports.push(port);
    refresh();
  });
  ses.on("serial-port-removed", (_event, port) => {
    if (asking === null) return;
    const at = asking.ports.findIndex((p) => p.portId === port.portId);
    if (at < 0) return;
    asking.ports.splice(at, 1);
    refresh();
  });
}

function lockDown(ses, origin, asked = new Set()) {
  ses.setPermissionRequestHandler((_wc, permission, done) => {
    asked.add(`request:${permission}`);
    done(ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    asked.add(`check:${permission}`);
    return ALLOWED.has(permission);
  });
  // This handler gates USB, serial and HID. E9-205: a SERIAL port the user
  // has chosen from the list is allowed — that is a grid, an arc or a crow
  // — and that is the only way in; USB and HID are still refused whole.
  ses.setDevicePermissionHandler(
    (d) =>
      d.deviceType === "audioOutput" ||
      d.deviceType === "audioInput" ||
      (d.deviceType === "serial" && String(d.origin ?? "").startsWith(origin) && chosenPorts.includes(portKey(d.device))),
  );

  // A Content-Security-Policy, added HERE rather than in `tools/serve.mjs`:
  // that file is the portable copy's server as well, and a policy that suits
  // an application window is not one to impose on whatever someone has
  // pointed a browser at.
  //
  // `unsafe-eval` IS REQUIRED, AND IT WAS MEASURED RATHER THAN ASSUMED. The
  // policy was written with `wasm-unsafe-eval` first, on the reasoning that
  // four WebAssembly modules are compiled and nothing is `eval`ed. The audio
  // engine then never arrived, with one line in the console to say why:
  //
  //   EvalError: Evaluating a string as JavaScript violates the following
  //   Content Security Policy directive … @scsynth.js:1
  //
  // Emscripten's own glue does it, so it is not ours to remove: the choice
  // is this directive or no scsynth. Stated here rather than left as a
  // mysterious keyword — and the rest of the policy is tight BECAUSE of it.
  //
  // The `connect-src` list is the community catalogue and the routes an
  // install takes through a CDN, as a list rather than `*`, so a script
  // bringing its own URL cannot quietly reach it.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    [
      "connect-src 'self' blob: data:",
      "https://norns.community",
      "https://api.github.com",
      "https://codeload.github.com",
      "https://raw.githubusercontent.com",
      "https://cdn.jsdelivr.net",
      "https://data.jsdelivr.com",
      // E9-203 — the three services a catalogue script reads with `curl`
      // and that answer a page: avonlea's weather, ppm_norns' CO2 reading,
      // ufo's space station. STILL A LIST. A script bringing some other
      // URL is refused here and the log says it was this policy that did.
      "https://api.open-meteo.com",
      "https://global-warming.org",
      "https://api.wheretheiss.at",
    ].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  ses.webRequest.onHeadersReceived((details, done) => {
    if (!details.url.startsWith(origin)) return done({});
    done({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

/**
 * Links leave. `details` and `code` in the catalogue point at
 * norns.community and at people's repositories, and an application that
 * opened those in itself would be a browser with no address bar — the one
 * place a link's destination cannot be checked.
 */
function sendLinksOutside(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (url.startsWith(origin)) return;
    e.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });
}

// ---------------------------------------------------------------------------
// The report, when run with --probe.
// ---------------------------------------------------------------------------

function printReport(report, asked, packaged) {
  const ok = {
    isolation: report.isolated === true && report.sharedArrayBuffer === true,
    midi: report.midi?.ok === true,
    audioWithoutGesture: report.audio?.state === "running" && report.audio?.gate !== "gesture",
    playsAScript: report.script?.ok === true && (report.script?.peak ?? 0) > 0,
    catalogueReachable: report.catalog?.ok === true,
    // THE ONE-RUN TEST FOR THE BUG THAT LOST A USER THEIR SCRIPTS. Whether
    // anything survived is a two-run question and is reported above; whether
    // it CAN survive is decidable here, because a loopback port can never
    // be the same origin twice.
    stableOrigin: report.origin === ORIGIN,
    // The store opened, has scripts on its shelves, their pictures on them
    // and the charts they are ordered by.
    scriptStore: report.store?.cards > 0 && report.store?.covers > 0 && report.store?.charted > 0,
    // The question reached this file, the page showed the list, and closing
    // it gave the page the refusal a closed picker gives.
    serialPortList:
      report.serial?.raised === 1 &&
      report.serial?.shown === true &&
      report.serial?.listed === report.serial?.usb &&
      report.serial?.outcome === "NotFoundError",
    // Only in a package. From a checkout the payload is `dist/`, which has
    // no source tree in it — `build-portable` is what assembles one, and
    // asserting it here would be asserting that somebody ran a build step
    // that this mode does not need.
    ...(packaged ? { sourceOffered: report.source?.ok === true } : {}),
  };
  line("");
  line(`  norns-js — ${packaged ? "packaged" : "from the checkout"}`);
  line(`  electron ${process.versions.electron} · chromium ${process.versions.chrome}`);
  line("");
  line(`  cross-origin isolated   ${report.isolated}   SharedArrayBuffer ${report.sharedArrayBuffer}`);
  line(`  midi                    ${report.midi?.ok} — ${report.midi?.inputs.length} in, ${report.midi?.outputs.length} out`);
  line(`                          sysex asked ${report.midi?.sysex}, granted ${report.midi?.sysexEnabled}, permission "${report.midi?.permission}"`);
  line(`                          the app took it: ${report.midi?.webmidiExposed}, it sees ${report.midi?.appPorts} port(s)`);
  if (report.midi?.inputs.length) line(`                          in:  ${report.midi.inputs.join(", ")}`);
  if (report.midi?.outputs.length) line(`                          out: ${report.midi.outputs.join(", ")}`);
  line(`  state resumed first     ${report.resumeSeen}`);
  line(`  permissions asked       ${[...asked].join(", ") || "none"}`);
  line(`  audio                   ${report.audio?.state} at ${report.audio?.sampleRate} Hz, gate "${report.audio?.gate}"`);
  line(`                          base ${report.audio?.baseLatencyMs} ms, output ${report.audio?.outputLatencyMs} ms, still ${report.audio?.stateAfter} after 8 s`);
  line(`                          sound cards ${report.audio?.devices?.outputs} out, ${report.audio?.devices?.inputs} in (${report.audio?.devices?.placeholders} unnamed), setSinkId ${report.audio?.devices?.canChoose}`);
  line(`                          master gain ${report.audio?.masterGain} (the button offers "${report.audio?.soundButton}"), out to ${report.audio?.sinkId}, ${report.audio?.destinationChannels} ch`);
  if (report.script) {
    const s = report.script;
    line(`  sound                   ${s.ok ? "ok" : "FAIL"} — ${s.script}, engine ${s.engine}, ${s.pixels} px, peak ${s.peak}`);
    line(`                          ${s.mode}; ${report.scriptsHere} script(s) in the tree`);
    line(`                          responds: ${s.responds?.join(" ") || "nothing"}`);
    if (s.errors?.length) line(`                          errors: ${s.errors.join(" | ")}`);
  }
  line(`  script store            ${report.store?.cards} card(s) on the front page, ${report.store?.covers} picture(s) shown, ${report.store?.charted} with stars or a date, kept in a cache: ${report.store?.kept}${report.store?.why ? " — " + report.store.why : ""}`);
  line(`  serial ports            api ${report.serial?.api}, button enabled ${report.serial?.button} — the list ${report.serial?.shown ? "opened" : "DID NOT OPEN"}`);
  line(`                          with ${report.serial?.listed} of ${report.serial?.usb} usb port(s), ${report.serial?.ports} serial port(s) in all; closed: ${report.serial?.outcome}`);
  line(`  origin                  ${report.origin}`);
  line(`  survives a restart      ${report.persisted?.found} — ${report.persisted?.found ? "SELECT lists the script left at" + report.persisted.was : "no marker yet; one has been left for the next run"}`);
  if (report.logTail && report.logTail.length) {
    line("");
    line("  what the script said");
    for (const l of report.logTail) line("    " + String(l).slice(0, 160));
  }
  if (report.listen) {
    const L = report.listen;
    line("");
    if (L.why) line("  LISTEN                  " + L.why);
    else {
      line("  LISTEN                  " + (L.ok ? "it plays" : "SILENT") + " — over " + L.seconds + " s with nothing pressed:");
      line("                          max " + L.max + ", mean " + L.mean + ", " + L.aboveSilence + " above silence.");
    }
    line("");
  }
  if (report.install) {
    const I = report.install;
    line("");
    line(`  INSTALL                 asked ${I.asked.length}, queued ${I.queued.length}; the tree went ${I.scriptsBefore} → ${I.scriptsAfter}`);
    for (const r of I.strip) line(`                          ${r}`);
    line(`                          note: ${I.note}`);
    line(`                          left behind: ${I.stagingLeft.length === 0 ? "nothing" : I.stagingLeft.join(", ")}`);
    line("");
  }
  if (report.buffers) {
    const B = report.buffers;
    line("");
    line("  BUFFERS                 " + (B.ok ? "intact" : B.holes + " HOLE(S)") + " — " + B.chunks + " chunks of a stereo sample");
    for (const r of B.readings) line("                          at " + String(r.at).padStart(7) + "  " + (r.got ? r.got.join(" ") : "no reply"));
    line("");
  }
  if (report.softcut) {
    const c = report.softcut;
    line("");
    line(`  SOFTCUT                 ${c.ok ? "ok" : "SILENT"} — ${c.whileRecording} while recording a sine,`);
    line(`                          ${c.playingBack} playing it back with the sine stopped.`);
    line("                          amen plays through softcut, not through the engine.");
    line("");
  }
  if (report.tone) {
    line("");
    line(`  TONE                    a 440 Hz sine played for ${report.tone.seconds} s with the master open.`);
    line(`                          the meter read ${report.tone.peak}. Did you HEAR it? That is the`);
    line(`                          half of the measurement this program cannot take.`);
    line("");
  }
  line(`  catalogue               ${report.catalog?.ok} — ${report.catalog?.entries ?? report.catalog?.why} entries through the CSP`);
  line(`  source offer            ${report.source?.ok} — ./source/ answers ${report.source?.status ?? report.source?.why}${packaged ? "" : " (a checkout serves dist/, which has none)"}`);
  if (!report.load) {
    line(`  audio thread            not measurable — Chromium has no performance.now() in an`);
    line(`                          AudioWorklet, so crone turns its own timing off. Null in a`);
    line(`                          tab too, so there is nothing here the shell made worse.`);
  } else {
    line(`  audio thread            ${report.load.over} dropouts in ${report.load.blocks} blocks`);
  }
  if (report.fatal) line(`  FATAL                   ${report.fatal}`);
  line("");
  for (const [k, v] of Object.entries(ok)) line(`  ${v ? "pass" : "FAIL"}  ${k}`);
  line("");
  return Object.values(ok).every(Boolean);
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(PAYLOAD)) {
    line(`norns-js: nothing to serve at ${PAYLOAD}`);
    line(app.isPackaged ? "  the package is incomplete" : "  run `npm run build` first");
    app.exit(2);
    return;
  }

  // The origin, out of a folder. `respond` is the portable copy's server
  // core, so this and `node serve.mjs` answer identically — including the
  // two isolation headers and the directory listing that makes the AGPL
  // source offer at `/source/` real rather than a 404.
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // The host is part of the origin, so anything other than `app` is a
    // different origin with a different store, and answering it would be
    // quietly handing out a second instrument.
    if (url.host !== "app") return new Response("forbidden", { status: 403 });
    // E9-227 — a GitHub release file the page cannot fetch itself (no CORS
    // on github.com's answer), fetched here through Chromium's own network
    // stack, so a proxy the machine is set up for is used. The CSP's
    // `connect-src` does not have to name GitHub: to the page this is its
    // own origin. See tools/gh-release.mjs.
    if (url.pathname.startsWith(RELAY_PREFIX)) {
      return relayRelease(url.pathname, {
        fetch: (u, init) => net.fetch(u, init),
        method: request.method,
        site: request.headers.get("sec-fetch-site"),
      });
    }
    // E9-277 — the info sheet's lines thread and README pictures, the same
    // way: this policy allows no outside image, and lines sends no CORS.
    if (url.pathname.startsWith(INFO_PREFIX)) {
      return relayInfo(url.pathname, {
        fetch: (u, init) => net.fetch(u, init),
        method: request.method,
        site: request.headers.get("sec-fetch-site"),
      });
    }
    const { status, headers, body } = await respond(PAYLOAD, url.pathname);
    if (status === 301) return Response.redirect(`${ORIGIN}${headers.Location}`, 301);
    return new Response(body, { status, headers });
  });

  const asked = new Set();
  await loadChosenPorts();
  lockDown(session.defaultSession, ORIGIN, asked);
  offerSerialPorts(session.defaultSession);

  const bounds = await loadBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 420,
    show: false,
    backgroundColor: "#0b0b0d",
    title: "norns-js",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // A tab will not start an AudioContext before a click, which is what
      // the veil in the page exists to explain (E7-21). An application
      // should not have to ask, and D-01 measured that it does not.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  if (bounds.maximized) win.maximize();

  // NO APPLICATION MENU, and that is not an omission. THE KEYBOARD IS THE
  // INSTRUMENT here — `1 2 3` are the keys, `q w a s z x` are the encoders,
  // and all of it is remappable — so every accelerator a menu installs is a
  // control taken away from the player. The three things a menu would have
  // been for are bound directly below, and the gear holds the rest.
  Menu.setApplicationMenu(null);
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (key === "f12" || (input.control && input.shift && key === "i")) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    } else if (key === "f11") {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.control && key === "r") {
      // Deliberately allowed: a reload is how a script that brought its own
      // SuperCollider engine gets one, and it costs a boot rather than data.
      win.webContents.reload();
      e.preventDefault();
    }
  });

  sendLinksOutside(win.webContents, ORIGIN);

  // Kept in probe mode, because the first thing a Content-Security-Policy
  // breaks, it breaks in the console and nowhere else.
  const noise = [];
  if (PROBE) {
    win.webContents.on("console-message", (e) => {
      if (e.level === "error" || e.level === "warning") noise.push(e.level + ": " + e.message + "  @" + (e.sourceId||"").split("/").pop() + ":" + e.lineNumber);
    });
  }

  let saving = null;
  const remember = () => {
    clearTimeout(saving);
    saving = setTimeout(() => void saveBounds(win), 400);
  };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("close", () => void saveBounds(win));

  win.once("ready-to-show", () => {
    // SHOWN EVEN WHILE PROBING, unless asked otherwise, and that is a
    // correctness decision rather than a convenience. Chromium throttles a
    // hidden window — timers, rAF, and the pacing of anything that chunks
    // work across them — so a probe that measures audio from behind a
    // hidden window is measuring the throttle. A measurement taken in
    // conditions nobody uses is not a measurement of the thing people use.
    if (!PROBE || !process.argv.includes("--hidden")) win.show();
    if (DEBUG) win.webContents.openDevTools({ mode: "detach" });
  });

  await win.loadURL(`${ORIGIN}/`);
  if (!PROBE) {
    line(`norns-js: serving ${PAYLOAD}`);
    line(`norns-js: ${ORIGIN}/`);
    return;
  }

  let probe = await readFile(join(HERE, "probe.js"), "utf8");
  if (SCRIPT !== null) {
    probe = `globalThis.__PROBE_SCRIPT = ${JSON.stringify(SCRIPT)};\n` + probe;
  }
  if (TONE) probe = "globalThis.__PROBE_TONE = true;\n" + probe;
  if (SOFTCUT) probe = "globalThis.__PROBE_SOFTCUT = true;\n" + probe;
  if (BUFFERS) probe = "globalThis.__PROBE_BUFFERS = true;\n" + probe;
  if (RELAY) probe = "globalThis.__PROBE_RELAY = true;\n" + probe;
  if (INSTALL !== null) {
    probe = `globalThis.__PROBE_INSTALL = ${JSON.stringify(INSTALL)};\n` + probe;
  }
  if (LISTEN !== null) probe = `globalThis.__PROBE_LISTEN = ${LISTEN};\n` + probe;
  let report;
  try {
    report = await win.webContents.executeJavaScript(probe, true);
  } catch (e) {
    report = { fatal: String(e?.message ?? e) };
  }
  if (RELAY) {
    const r = report.relay ?? { error: report.fatal ?? "no report" };
    line("");
    line(`  RELAY                   ${r.ok ? "works" : "BROKEN"} — ${r.path}`);
    line(`                          status ${r.status}, marked ${r.marked}, ${r.bytes} bytes (Content-Length ${r.length}), zip ${r.zip}${r.error ? ", error " + r.error : ""}`);
    line(`                          a path that is not a release: ${r.refused}`);
    line(`                          the same file from github.com directly: ${r.direct}`);
    line("");
    app.exit(r.ok ? 0 : 1);
    return;
  }
  // E9-208 — the script store, opened the way its button opens it. What
  // this application could break and a browser could not: the pictures are
  // another site's, fetched under this window's policy and shown from a
  // blob, and they are kept in a cache that has to exist on `norns://`.
  try {
    report.store = await win.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const button = document.querySelector("#scripts");
        if (button === null) return { button: false, cards: 0, covers: 0, charted: 0, kept: false };
        button.click();
        let covers = 0;
        for (let i = 0; i < 48 && covers === 0; i++) {
          await sleep(250);
          covers = document.querySelectorAll(".st-cover[data-has=yes]").length;
        }
        const out = {
          button: true,
          cards: document.querySelectorAll(".st-card").length,
          covers,
          // E9-209 — the stars and dates are a file shipped beside the
          // page: a card with a number in its corner is that file read
          // under this application's own address.
          charted: document.querySelectorAll(".st-meta").length,
          kept: typeof caches !== "undefined" && (await caches.keys()).includes("norns-js-covers-1"),
        };
        window.__norns?.store?.hide();
        return out;
      })()`,
      true,
    );
  } catch (e) {
    report.store = { button: false, cards: 0, covers: 0, charted: 0, kept: false, why: String(e?.message ?? e) };
  }
  // E9-205 — the port list, asked for the way the `usb` button asks, in a
  // call of its own because the picker needs a gesture and this carries
  // one. Nothing is chosen: the list is looked at and closed, so no port
  // is opened and nothing is sent to anybody's device.
  try {
    report.serial = await win.webContents.executeJavaScript(
      `(async () => {
        const button = document.querySelector("#hwattach");
        const out = {
          api: "serial" in navigator,
          button: button !== null && !button.hasAttribute("disabled"),
          shown: false,
          listed: 0,
        };
        setTimeout(() => {
          const host = document.querySelector("#portchooser");
          out.shown = host !== null && host.hidden === false;
          out.listed = host === null ? 0 : host.querySelectorAll("button[data-port]").length;
          host?.querySelector("[data-cancel]")?.click();
        }, 800);
        try {
          await navigator.serial.requestPort();
          out.outcome = "a port was returned with nothing chosen";
        } catch (e) {
          out.outcome = e.name;
        }
        return out;
      })()`,
      true,
    );
  } catch (e) {
    report.serial = { outcome: String(e?.message ?? e) };
  }
  report.serial.raised = serialSeen.raised;
  report.serial.ports = serialSeen.ports;
  report.serial.usb = serialSeen.usb;
  const pass = printReport(report, asked, app.isPackaged);
  for (const n of noise.slice(0, 12)) line("  " + n.slice(0, 300));
  if (noise.length) line("");
  app.exit(pass ? 0 : 1);
}

// One copy at a time. Two would be two instruments fighting over one store:
// the dust tree lives in this origin's OPFS, and the second to write wins.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(main).catch((e) => {
    line(`norns-js failed to start: ${e?.stack ?? e}`);
    app.exit(2);
  });
  app.on("window-all-closed", () => app.quit());
}
