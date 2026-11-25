// Everything the D-01 spike asks the running page, in one evaluation.
//
// A FILE OF ITS OWN, not a template literal in `spike.mjs`, and that is not
// tidiness. It was a template literal first, and the two backticks in a
// comment inside it closed the string: the shell died before the window
// opened with `SyntaxError: Unexpected identifier 'requestMIDIAccess'` in a
// Windows modal, pointing at a line that was perfectly correct. Here it is
// ordinary JavaScript — it parses on its own, a stray backtick is just a
// backtick, and `node --check desktop/probe.js` says so before Electron
// runs.
//
// It is read with `readFile` and handed to `webContents.executeJavaScript`,
// so the last expression is what comes back: the trailing IIFE call is the
// whole contract.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {
    isolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    midi: { ok: false, why: null, inputs: [], outputs: [], sysex: false },
    audio: { state: null, sampleRate: null, gate: null },
    script: null,
    load: null,
  };

  // `--relay` (E9-227): ask the shell's GitHub release relay for a file,
  // and nothing else. The master is held at zero from the moment it exists,
  // because a resumed script would otherwise play while this looks; no
  // script is loaded, and the report is this alone.
  if (globalThis.__PROBE_RELAY) {
    let muting = true;
    void (async () => {
      while (muting) {
        if (globalThis.__norns && globalThis.__norns.master) globalThis.__norns.master.gain.value = 0;
        await sleep(20);
      }
    })();
    const path = "/gh-release/schollz/mx.samples/releases/download/samples/cello_pad.zip";
    const relay = { path };
    try {
      const r = await fetch(path);
      const b = new Uint8Array(await r.arrayBuffer());
      relay.status = r.status;
      relay.marked = r.headers.get("X-Norns-Relay") === "1";
      relay.length = r.headers.get("Content-Length");
      relay.bytes = b.length;
      relay.zip = b[0] === 0x50 && b[1] === 0x4b;
    } catch (e) {
      relay.error = String((e && e.message) || e);
    }
    try {
      relay.refused = (await fetch("/gh-release/o/r/archive/main.zip")).status;
    } catch (e) {
      relay.refused = String((e && e.message) || e);
    }
    // The same file asked of github.com directly: what the relay is for.
    try {
      const d = await fetch("https://github.com/schollz/mx.samples/releases/download/samples/cello_pad.zip");
      relay.direct = "answered " + d.status;
    } catch (e) {
      relay.direct = "refused: " + String((e && e.message) || e);
    }
    relay.ok = relay.status === 200 && relay.marked === true && relay.zip === true && relay.refused === 404;
    await sleep(500);
    muting = false;
    return { ...out, relay };
  }

  // 1. MIDI, asked the way the app asks it: sysex first, then without.
  try {
    let access = null;
    try {
      access = await navigator.requestMIDIAccess({ sysex: true });
      out.midi.sysex = true;
    } catch (e) {
      out.midi.why = String((e && e.message) || e);
      access = await navigator.requestMIDIAccess();
    }
    out.midi.ok = true;
    out.midi.sysexEnabled = access.sysexEnabled === true;
    out.midi.inputs = [...access.inputs.values()].map((p) => p.name);
    out.midi.outputs = [...access.outputs.values()].map((p) => p.name);
  } catch (e) {
    out.midi.ok = false;
    out.midi.why = String((e && e.message) || e);
  }
  out.midi.permission = await navigator.permissions
    .query({ name: "midi", sysex: true })
    .then((p) => p.state, (e) => "query failed: " + (e && e.message));

  // 2. The boot. Wait for the page to expose its audio context, which only
  //    happens once sclang and scsynth are up.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !(globalThis.__norns && globalThis.__norns.audio)) {
    await sleep(250);
  }
  const n = globalThis.__norns;
  if (!n || !n.audio) return { ...out, fatal: "the audio graph never arrived" };
  out.audio.state = n.audio.state;
  out.audio.sampleRate = n.audio.sampleRate;
  // What a player actually feels, and the one audio number that IS exposed
  // here. See out.load below for the one that is not.
  out.audio.baseLatencyMs = Number((n.audio.baseLatency * 1000).toFixed(2));
  out.audio.outputLatencyMs = Number(((n.audio.outputLatency ?? 0) * 1000).toFixed(2));
  // PRODUCED IS NOT THE SAME AS AUDIBLE, and the probe could not tell them
  // apart. `peak` is read from the meter, which sits BEFORE the master gain
  // on purpose — that is what lets the exerciser answer "did this script
  // make a sound" with the output turned down to nothing. So a report of
  // `peak 0.63` is consistent with a user hearing silence, and the gain is
  // the missing half of it.
  out.audio.masterGain = n.master ? n.master.gain.value : null;
  const soundButton = document.querySelector("#sound");
  out.audio.soundButton = soundButton ? soundButton.dataset.tip ?? null : null;
  // And where it is actually going. A browser picks an output device and
  // never says which; `setSinkId` is how one is chosen, and `sinkId` is
  // empty when it is the system default.
  out.audio.sinkId = typeof n.audio.sinkId === "string" ? n.audio.sinkId || "(default)" : "n/a";
  // WHICH SOUND CARDS THIS BUILD CAN SEE, which is half of "I hear nothing".
  // A device with an empty id is the browser's placeholder for "there is
  // something here and you may not know what" — it is counted separately,
  // because one nameless entry and three named ones are different answers.
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const count = (k) => all.filter((d) => d.kind === k);
    const named = (k) => count(k).filter((d) => d.deviceId !== "");
    out.audio.devices = {
      outputs: named("audiooutput").length,
      inputs: named("audioinput").length,
      placeholders: all.filter((d) => d.deviceId === "").length,
      canChoose: typeof AudioContext.prototype.setSinkId === "function",
    };
  } catch (e) {
    out.audio.devices = { why: String(e && e.message) };
  }
  out.audio.destinationChannels = n.audio.destination ? n.audio.destination.channelCount : null;
  // The APP's verdict on MIDI rather than the probe's: it exposes its own
  // MIDIAccess only when its own requestMIDIAccess succeeded.
  out.midi.webmidiExposed = Boolean(n.webmidi);
  out.midi.appPorts = n.midi && n.midi.list ? n.midi.list().length : null;
  // 3. A script, through the exerciser: engine, pixels, peak, inputs.
  //
  //    WAIT FOR `state.resume()` FIRST, which is a race this spike lost on
  //    its second run and won on its first. The audio graph arriving is not
  //    the end of the boot: `core/state.lua:80` resumes whatever was running
  //    at the last clean shutdown, and when there is nothing — or when the
  //    last run was killed — it calls `norns.script.clear()` and raises
  //    `NO SCRIPT`. Land the exerciser in the middle of that and the clear
  //    takes away the script it has just loaded: `engine null, 0 px,
  //    errors: NO SCRIPT`, which reads like awake failing and is not.
  //
  //    Waited for by reading what the person reads — the console — rather
  //    than by sleeping a guessed number of milliseconds.
  const resumed = () => {
    const log = document.querySelector("#consolebox");
    const text = log ? log.textContent || "" : "";
    return /NO SCRIPT|last file loaded/.test(text);
  };
  const settle = Date.now() + 30000;
  while (Date.now() < settle && !resumed()) await sleep(250);
  out.resumeSeen = resumed();
  await sleep(500);

  // The veil says what it is waiting for, and it is read HERE rather than
  // the moment the audio graph appeared: "loading" is a stage of the boot
  // and "off" is the end of it. "gesture" is where a tab sits until it is
  // clicked, and seeing anything else is the autoplay claim holding.
  const gate = document.querySelector("#gate");
  out.audio.gate = gate ? gate.dataset.state ?? null : null;

  //    AND A PACKAGED BUILD HAS NO SCRIPTS, which is not a fault: the
  //    package carries the portable copy's `app/`, and `build-portable`
  //    strips everything under `dust/code/` so that nobody else's work is
  //    redistributed — seventeen of the thirty-five scripts this project
  //    tested with carry no licence at all. Asking a package for `awake`
  //    therefore gets `engine null, peak 0`, which reads like a broken
  //    build and is a correct one.
  //
  //    So the question is asked twice over, and which one depends on what
  //    is there. With scripts: the exerciser, which is the real thing. With
  //    none: a sine from SuperCollider's own classes, through sclang, down
  //    the same path to the same meter — nobody's work but SuperCollider's,
  //    and it still proves that scsynth is up and audible.
  // `--tone`: make a noise on purpose, with the master forced open, because
  // the meter is before the gain and cannot tell "produced" from "audible".
  // Everything past the master — the per-application volume mixer, the
  // default output device, which socket the headphones are in — is outside
  // this program, and ears are the only instrument that reaches it.
  if (globalThis.__PROBE_TONE) {
    if (n.master) n.master.gain.value = 1;
    n.engine.runCode("~njsTone = { SinOsc.ar([440, 441], 0, 0.25) }.play;");
    let peak = 0;
    for (let i = 0; i < 48; i++) {
      await sleep(125);
      peak = Math.max(peak, n.peak() ?? 0);
    }
    n.engine.runCode("~njsTone.free; ~njsTone = nil;");
    out.tone = { peak: Number(peak.toFixed(5)), seconds: 6 };
  }

  // `--buffers`: does a sample actually ARRIVE in scsynth?
  //
  // THE QUESTION THE TONE COULD NOT ASK. A sine is generated inside
  // scsynth; a sample has to be carried into it — `/b_alloc` and then one
  // `/b_setn` per 8192 values, 52 of them for four seconds of stereo. The
  // carrier is a SharedArrayBuffer ring (`supersonic-scsynth`'s
  // `osc_channel.js`), and its `send` ends `if (_ > I) return false` with a
  // counter for "ring full": **a message that does not fit is dropped, and
  // the only sign is a return value our code discards.** A sample with
  // holes in it does not fail. It plays quietly.
  //
  // So: fill a buffer with a known constant, ask scsynth to read it back at
  // six places, and see whether what comes back is the constant. Measured
  // in a browser tab first, where all six read 0.1.
  if (globalThis.__PROBE_BUFFERS) {
    const e = n.engine;
    const sc = e.scsynth;
    const parse = (b) => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const rd = (o) => {
        let i = o;
        while (b[i] !== 0) i++;
        return [new TextDecoder().decode(b.slice(o, i)), (i + 4) & ~3];
      };
      const [addr, o] = rd(0);
      if (addr !== "/b_setn") return null;
      const [tt, start] = rd(o);
      let p = start;
      const out = [];
      for (const t of tt.slice(1)) {
        if (t === "i") { out.push(dv.getInt32(p)); p += 4; }
        else if (t === "f") { out.push(Number(dv.getFloat32(p).toFixed(4))); p += 4; }
      }
      return out;
    };
    const got = [];
    const prev = sc.onOscReply;
    sc.onOscReply = (bytes) => { const v = parse(bytes); if (v) got.push(v); if (prev) prev(bytes); };
    const FRAMES = 211764;
    const CHUNK = 8192;
    const total = FRAMES * 2;
    e.sendToServer("/b_alloc", [99, FRAMES, 2]);
    const chunk = new Array(CHUNK).fill(0.1);
    for (let at = 0; at < total; at += CHUNK) {
      e.sendToServer("/b_setn", [99, at, Math.min(CHUNK, total - at), ...chunk]);
    }
    await sleep(700);
    const spots = [0, 50000, 100000, 200000, 300000, 400000, total - 8];
    for (const at of spots) e.sendToServer("/b_getn", [99, at, 3]);
    await sleep(1000);
    sc.onOscReply = prev;
    e.sendToServer("/b_free", [99]);
    const readings = spots.map((at) => {
      const row = got.find((r) => r[1] === at);
      return { at, got: row ? row.slice(3) : null };
    });
    const holes = readings.filter((r) => r.got === null || r.got.some((v) => v !== 0.1));
    out.buffers = {
      chunks: Math.ceil(total / CHUNK),
      readings,
      holes: holes.length,
      ok: holes.length === 0,
    };
  }

  // `--install a,b,c`: queue several scripts through the real panel.
  //
  // THROUGH THE UI AND NOT THROUGH THE INSTALLER, which is the point: the
  // question is whether queueing several works in the PACKAGED application
  // — the custom scheme, the Content-Security-Policy's `connect-src`, the
  // staging directory, OPFS underneath — and an installer called directly
  // would skip the panel that drives all of it. The buttons are pressed the
  // way a finger presses them.
  if (globalThis.__PROBE_INSTALL) {
    const names = String(globalThis.__PROBE_INSTALL).split(",").map((s) => s.trim());
    const q = (sel) => document.querySelector(sel);
    const before = n.scripts().length;
    q("#maiden").click();
    await sleep(900);
    [...document.querySelectorAll(".mdn-act")][2].click();
    await sleep(2500);
    [...document.querySelectorAll(".mdn-proj-tab")].find((b) => b.textContent === "available").click();
    await sleep(3000);
    const search = q(".mdn-proj-search");
    const queued = [];
    for (const name of names) {
      search.value = name;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(400);
      const row = [...document.querySelectorAll(".mdn-proj-row")].find(
        (r) => r.querySelector(".mdn-proj-name")?.textContent === name,
      );
      if (!row) continue;
      row.querySelector(".mdn-proj-act")?.click();
      queued.push(name);
      await sleep(150);
    }
    // Watch the strip rather than a clock: it is the thing a person watches.
    const settled = () =>
      [...document.querySelectorAll(".mdn-proj-job")].every(
        (r) => !/starting|of |queued/.test(r.innerText),
      );
    for (let i = 0; i < 240 && !settled(); i++) await sleep(500);
    out.install = {
      asked: names,
      queued,
      strip: [...document.querySelectorAll(".mdn-proj-job")].map((r) =>
        r.innerText.replace(/\n/g, " ").trim(),
      ),
      note: q(".mdn-proj-note")?.textContent ?? null,
      scriptsBefore: before,
      scriptsAfter: n.scripts().length,
      stagingLeft: n.vfs.list("/home/we/dust/.installing").map((e) => e.name),
    };
    q(".mdn-close")?.click();
    await sleep(400);
    q(".mdn-close")?.click();
    await sleep(400);
  }

  // `--softcut`: the path amen actually plays through, isolated.
  //
  // WHY THIS IS A DIFFERENT TEST FROM `--tone`. A sine from sclang is
  // scsynth straight to the output. amen is not: it routes the ENGINE'S
  // output into softcut (`level_input_cut`), records it, and plays the
  // recording back as a loop — 57 softcut calls in `amen.lua` and two
  // `engine.` ones. So "the tone is audible and amen is not" narrows to one
  // question, and this asks it: record two seconds of a sine into a softcut
  // voice, stop the sine, and see whether the voice plays anything back.
  if (globalThis.__PROBE_SOFTCUT) {
    if (n.master) n.master.gain.value = 1;
    const h = n.host;
    h.run([
      "softcut.buffer_clear()",
      "softcut.enable(1,1)",
      "softcut.buffer(1,1)",
      "softcut.level(1,1)",
      "softcut.pan(1,0)",
      // The engine into the voice, which is the line amen leans on.
      "softcut.level_input_cut(1,1,1)",
      "softcut.level_input_cut(2,1,1)",
      "softcut.rate(1,1)",
      "softcut.loop_start(1,0)",
      "softcut.loop_end(1,2)",
      "softcut.loop(1,1)",
      "softcut.position(1,0)",
      "softcut.rec_level(1,1)",
      "softcut.pre_level(1,0)",
      "softcut.rec(1,1)",
      "softcut.play(1,1)",
    ].join("\n"));
    await sleep(300);
    n.engine.runCode("~njsCut = { SinOsc.ar([330, 331], 0, 0.3) }.play;");
    let whileRecording = 0;
    for (let i = 0; i < 16; i++) {
      await sleep(125);
      whileRecording = Math.max(whileRecording, n.peak() ?? 0);
    }
    // The sine stops and recording stops; anything heard now came OUT of
    // the softcut buffer.
    n.engine.runCode("~njsCut.free; ~njsCut = nil;");
    h.run("softcut.rec(1,0)\nsoftcut.position(1,0)");
    await sleep(400);
    let afterwards = 0;
    for (let i = 0; i < 24; i++) {
      await sleep(125);
      afterwards = Math.max(afterwards, n.peak() ?? 0);
    }
    h.run("softcut.play(1,0)\nsoftcut.enable(1,0)\nsoftcut.buffer_clear()");
    out.softcut = {
      whileRecording: Number(whileRecording.toFixed(5)),
      playingBack: Number(afterwards.toFixed(5)),
      ok: afterwards > 0.01,
    };
  }

  const here = typeof n.scripts === "function" ? n.scripts() : [];
  // `--script code/amen/amen.lua` names one, for the question a bug report
  // asks. Matched by suffix so the caller does not have to type the whole
  // `/home/we/dust/` prefix.
  const wanted = globalThis.__PROBE_SCRIPT ?? null;

  // `--listen`: load it and TOUCH NOTHING, then watch the meter.
  //
  // WHY NOT THE EXERCISER, which is the obvious instrument and the wrong
  // one here. It presses every key, and `amen` RECORDS A LOOP when you press
  // keys — from an audio input that does not exist in a browser, so the loop
  // is four seconds of silence, which it then saves, selects and plays. The
  // exerciser was manufacturing the symptom it was sent to measure: on a
  // brand-new store its first run already came back having loaded
  // `loop1_bpm90.wav` instead of the amen break. A sampler has to be
  // listened to, not poked.
  if (wanted && globalThis.__PROBE_LISTEN) {
    const path = here.find((p) => p === wanted || p.endsWith("/" + wanted.replace(/^\/+/, "")));
    if (!path) {
      out.listen = { ok: false, why: `${wanted} is not in the tree` };
    } else {
      // Through the menu, which is how a person loads a script and which is
      // what keeps cairo's gstate stack balanced (E5-27).
      const h = n.host;
      h.run("if _menu and _menu.set_mode then pcall(_menu.set_mode, true) end");
      h.run(`norns.script.load(${JSON.stringify(path)})`);
      await sleep(6000);
      h.run("if _menu and _menu.set_mode then pcall(_menu.set_mode, false) end");
      if (n.master) n.master.gain.value = 1;
      const seconds = Number(globalThis.__PROBE_LISTEN) || 12;
      const samples = [];
      for (let i = 0; i < seconds * 8; i++) {
        await sleep(125);
        samples.push(n.peak() ?? 0);
      }
      const loud = samples.filter((v) => v > 0.001).length;
      out.listen = {
        ok: loud > samples.length / 10,
        seconds,
        max: Number(Math.max(...samples).toFixed(5)),
        mean: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(5)),
        aboveSilence: `${loud} of ${samples.length} samples`,
      };
    }
  }
  const awake = wanted
    ? (here.find((p) => p === wanted || p.endsWith("/" + wanted.replace(/^\/+/, ""))) ?? null)
    : here.find((p) => p.endsWith("/awake/awake.lua"));
  if (wanted && !awake) {
    out.script = {
      mode: `--script ${wanted} is not in the tree`,
      script: wanted,
      ok: false,
      engine: null,
      pixels: 0,
      peak: 0,
      responds: [],
      errors: [`not installed; the tree holds ${here.length}`],
    };
  } else if (awake) {
    const rows = [];
    await n.exercise({ only: [awake], onResult: (r) => rows.push(r) });
    const r = rows[0];
    if (r) {
      out.script = {
        mode: "exerciser",
        script: r.script,
        ok: r.ok,
        engine: r.engine,
        pixels: r.pixels,
        peak: r.peak,
        notePeak: r.notePeak,
        responds: r.responds,
        errors: r.errors,
      };
    }
  } else if (n.engine && n.peak) {
    n.engine.runCode("~njsProbe = { SinOsc.ar(440, 0, 0.2) ! 2 }.play;");
    let peak = 0;
    for (let i = 0; i < 24; i++) {
      await sleep(125);
      peak = Math.max(peak, n.peak() ?? 0);
    }
    n.engine.runCode("~njsProbe.free; ~njsProbe = nil;");
    out.script = {
      mode: "a sine through sclang — there is no awake here to exercise",
      script: "SinOsc.ar(440)",
      ok: peak > 0,
      engine: "scsynth",
      pixels: 0,
      peak: Number(peak.toFixed(5)),
      responds: [],
      errors: [],
    };
  }
  out.scriptsHere = here.length;
  // WHAT THE SCRIPT SAID, which is where a sampler explains itself. Lua's
  // `print` goes to the page's log and not to the devtools console, so the
  // shell's console capture never sees it — and "crone: no such file …" is
  // exactly the line that distinguishes a silent script from a broken one.
  const logEl = document.querySelector("#consolebox");
  const lines = (logEl ? logEl.textContent || "" : "").split("\n");
  const start = lines.lastIndexOf("# script init");
  out.logTail = (start >= 0 ? lines.slice(start) : lines.slice(-30))
    .filter((l) => l.trim() !== "")
    .slice(0, 70);

  // 3b. THE CATALOGUE, because the shell added a Content-Security-Policy and
  //     a `connect-src` list is exactly the thing that silently breaks the
  //     one feature a build with no scripts depends on: installing some. A
  //     packaged app that cannot reach norns-community is an empty
  //     instrument with no way to fill it.
  out.catalog = await fetch(
    "https://raw.githubusercontent.com/monome/norns-community/main/community.json",
  ).then(
    async (r) => ({ ok: r.ok, status: r.status, entries: Object.keys(await r.json()).length }),
    (e) => ({ ok: false, why: String(e && e.message) }),
  );

  // 3c. The source offer, which AGPL §6 makes part of the artefact rather
  //     than a nicety. The gear links to ./source/ and the server lists it.
  out.source = await fetch("./source/").then(
    (r) => ({ ok: r.ok, status: r.status }),
    (e) => ({ ok: false, why: String(e && e.message) }),
  );

  // 4. DOES ANYTHING SURVIVE BEING CLOSED, which is the question a user
  //    answered for us: a script installed, the app quit, and on the next
  //    launch the scripts were gone. The dust tree lives in this ORIGIN's
  //    OPFS, and the shell was serving itself on a loopback port the OS
  //    picked — a different port, so a different origin, so a different and
  //    empty store, every single launch.
  //
  //    The check is in two halves across two runs: read the marker the LAST
  //    run left, then leave one for the next. One run cannot answer this,
  //    and neither can anything short of actually closing the application.
  //    THE MARKER IS A SCRIPT, under `code/`, and not a note in `data/`.
  //    Both would ride the same overlay and the same mirror, but the
  //    complaint was "my scripts are not there any more" and the thing that
  //    answers it is `norns.scripts()` finding one — what SELECT reads.
  //
  //    It cleans up after itself: the run that finds the marker removes it,
  //    so the tree is left as it was and the next run writes a new one.
  out.origin = location.origin;
  const MARK = "/home/we/dust/code/probe-mark/probe-mark.lua";
  const vfs = n.vfs;
  if (vfs) {
    const listed = (typeof n.scripts === "function" ? n.scripts() : []).includes(MARK);
    const body = vfs.readText ? vfs.readText(MARK) : null;
    out.persisted = {
      found: listed && typeof body === "string" && body.length > 0,
      listedBySelect: listed,
      was: typeof body === "string" ? (body.split("\n")[0] || "").slice(2, 64) : null,
    };
    if (out.persisted.found) vfs.remove(MARK);
    else vfs.write(MARK, `-- left by the probe at ${new Date().toISOString()}\nfunction init() end\n`);
    // Mirrored, not hoped for: the mirror coalesces writes behind a timer,
    // and an application that is about to exit does not reach the timer.
    if (n.opfs && n.opfs.flush) await n.opfs.flush();
  }

  // 4. The audio thread's own cost, sampled while something plays. `over` is
  //    blocks that missed their deadline, which is a dropout each.
  //
  //    IT IS USUALLY NOT THERE, AND THAT IS NOT THE SHELL'S FAULT. Chromium
  //    does not expose `performance.now()` inside AudioWorkletGlobalScope,
  //    so crone's processor turns its own timing off and says so in the log:
  //    "the audio thread has no performance.now(); its cost cannot be
  //    measured here". Null in a tab as well, so there is nothing here the
  //    shell made worse — the line is kept and reports its own absence
  //    rather than being quietly dropped.
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const l = n.load ? n.load() : null;
    if (l) seen.push(l);
  }
  out.load =
    seen.length === 0
      ? null
      : {
          windows: seen.length,
          over: seen.reduce((a, l) => a + l.over, 0),
          blocks: seen.reduce((a, l) => a + l.blocks, 0),
          maxMs: Math.max(...seen.map((l) => l.maxMs)),
          meanMs: Number((seen.reduce((a, l) => a + l.meanMs, 0) / seen.length).toFixed(3)),
          budgetMs: seen[0].budgetMs,
        };
  // Still running after eight seconds of nothing in particular? A shell that
  // drops the context when the window is idle would show up here.
  out.audio.stateAfter = n.audio.state;
  return out;
})();
