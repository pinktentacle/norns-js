// A catalogue sweep, run IN THE PAGE (dev tool, not shipped).
//
//   const m = await import('/tools/sweep/runner.js')
//   m.start({ tags: ['synth', 'polysynth', 'synthesizer'], label: 'synth' })
//   m.ensureRunning()   // after every reload: the page reloads once a batch
//   m.status()          // how far
//   m.results()         // the rows
//   m.hold()            // stop after each batch's run, still installed, for
//                       // probe.js by hand; m.resume() cleans and goes on
//
// One script is tested once, whatever its tags: what has been swept is kept
// in localStorage (`DONE`) across categories, and a category only plans what
// is not in it yet. `start` adds the names in docs/measurements/browser-sweep.json
// (the copy on disk, refreshed by hand after a sweep).
//
// A BATCH is installed, with the dependencies the app would install with each
// script (`installDeps`), the page reloads so sclang compiles the batch's
// engines, then each script is exercised (`__norns.exercise`: load, draw,
// keys, encoders, a MIDI note, a grid press, the peak), then checked for
// what this session taught: a dead server, SuperCollider errors that the
// Lua side never sees, missing files, a script waiting for an audio input
// (fed a test tone to see whether it answers). Then the batch is removed —
// except a script that was installed before the sweep began.

const KEY = "norns-js/sweep/state";
const DONE = "norns-js/sweep/done";
const RESULTS = "norns-js/sweep/results";
const CODE = "/home/we/dust/code";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const state = () => read(KEY, null);
const save = (s) => write(KEY, s);

let running = false;

/** Times the page has been hidden since this module loaded. */
let hiddenCount = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenCount++;
});
/** Until the page is visible and its audio running: see the loop. */
async function untilSeen() {
  let said = false;
  while (document.hidden || (N()?.audio && N().audio.state !== "running")) {
    if (!said) {
      const s = state();
      s.notes.push(`waiting: page ${document.hidden ? "hidden" : "visible"}, audio ${N()?.audio?.state}`);
      save(s);
      said = true;
    }
    if (!document.hidden && N()?.audio?.state === "suspended") await N().audio.resume().catch(() => {});
    await sleep(1000);
  }
}

const N = () => window.__norns;
/** `/sync`, answered or not; a dead scsynth THROWS ("unwind") rather than answering. */
const alive = async (ms = 3000) => {
  try {
    return (await N().engine.syncServer(ms)) === true;
  } catch {
    return false;
  }
};
const logLines = () => (document.querySelector("#log")?.innerText ?? "").split("\n");

async function booted(timeoutMs = 120000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const t = document.querySelector("#log")?.innerText ?? "";
    if (N()?.master && /engines reported|sclang did not boot/.test(t)) return true;
    await sleep(500);
  }
  return false;
}

function catalogue() {
  const text = N().vfs.readText("/home/we/dust/data/catalogs/community.json");
  const j = JSON.parse(text ?? "[]");
  const list = Array.isArray(j) ? j : (j.entries ?? []);
  return list
    .map((e) => ({ name: e.project_name, url: e.project_url, tags: e.tags ?? [], author: e.author ?? "" }))
    .filter((e) => typeof e.name === "string" && typeof e.url === "string");
}

/** What docs/measurements/browser-sweep.json says is done: the pane's storage can be wiped. */
async function doneOnDisk() {
  try {
    const r = await fetch("/docs/measurements/browser-sweep.json", { cache: "no-store" });
    return r.ok ? ((await r.json()).done ?? []) : [];
  } catch {
    return [];
  }
}

/**
 * Write what is known to docs/measurements/browser-sweep.json (the dev
 * server's /__sweep/export, vite.config.ts), MERGED with what is there: a
 * wiped localStorage must add nothing and take nothing away. One row per
 * label and name; this page's row wins.
 */
export async function exportToDisk() {
  let disk = { done: [], results: [] };
  try {
    const r = await fetch("/docs/measurements/browser-sweep.json", { cache: "no-store" });
    if (r.ok) disk = await r.json();
  } catch {}
  // `hand` and `deps` are trailing and optional; a row with deps and no
  // hand note carries "" for the note so the columns stay in place.
  const row = (r) => {
    const a = [r.label, r.batch, r.name, r.verdict, (r.problems ?? []).join(",")];
    if (r.hand || r.deps) a.push(r.hand ?? "");
    if (r.deps) a.push(r.deps.join(", "));
    return a;
  };
  const byKey = new Map((disk.results ?? []).map((a) => [`${a[0]}|${a[2]}`, a]));
  for (const r of read(RESULTS, [])) byKey.set(`${r.label}|${r.name}`, row(r));
  const done = [...new Set([...(disk.done ?? []), ...read(DONE, [])])].sort();
  const rows = [...byKey.values()].map((a) => JSON.stringify(a));
  // One result per line, so a diff of the file reads as the rows that changed.
  const body = [
    "{",
    ` "exported": ${JSON.stringify(new Date().toISOString())},`,
    ' "columns": ["label", "batch", "name", "verdict", "problems", "hand", "deps"],',
    ` "done": ${JSON.stringify(done)},`,
    ' "results": [',
    rows.map((r) => `  ${r}`).join(",\n"),
    " ]",
    "}",
    "",
  ].join("\n");
  const res = await fetch("/__sweep/export", { method: "POST", body });
  return { ok: res.ok, done: done.length, results: rows.length };
}

export async function start(opts) {
  const tags = opts.tags ?? [];
  const done = new Set([...read(DONE, []), ...(await doneOnDisk())]);
  write(DONE, [...done]);
  // `names`: exactly these, done or not — a re-test.
  const plan = (
    opts.names
      ? catalogue().filter((e) => opts.names.includes(e.name))
      : catalogue()
          .filter((e) => e.tags.some((t) => tags.includes(t)))
          .filter((e) => !done.has(e.name.toLowerCase()))
  ).sort((a, b) => a.name.localeCompare(b.name));
  const pre = N()
    .vfs.list(CODE)
    .filter((e) => e.isDir)
    .map((e) => e.name);
  save({
    label: opts.label ?? tags.join("+"),
    plan,
    batchSize: opts.batchSize ?? 12,
    batch: 0,
    phase: "install",
    idx: 0,
    installed: {},
    retried: {},
    preexisting: pre,
    // Here, not by `hold()` after `start()`: the loop has read the state by
    // then and writes it back without the flag.
    hold: opts.hold === true,
    startedAt: new Date().toISOString(),
    notes: [],
  });
  return ensureRunning();
}

export function status() {
  const s = state();
  if (!s) return null;
  const rows = read(RESULTS, []).filter((r) => r.label === s.label);
  return {
    label: s.label,
    phase: s.phase,
    batch: s.batch,
    batches: Math.ceil(s.plan.length / s.batchSize),
    idx: s.idx,
    tested: rows.length,
    planned: s.plan.length,
    running,
    lastError: s.lastError ?? null,
    notes: s.notes.slice(-5),
  };
}

export const results = (label) => read(RESULTS, []).filter((r) => !label || r.label === label);

export async function ensureRunning() {
  if (running) return status();
  const s = state();
  if (!s || s.phase === "done") return status();
  running = true;
  loop()
    .catch((e) => {
      const s2 = state();
      s2.lastError = String(e?.stack ?? e);
      save(s2);
    })
    .finally(() => (running = false));
  return status();
}

/**
 * What the app installs WITH a script, installed with it here: `needsOf`
 * after each install, the providers into the same tree, two levels deep at
 * most (maiden-project.ts, E9-34 and NEED_DEPTH). Without this the sweep
 * noted "missing Moonshine" for streams, which the store makes work.
 * Recorded in `s.deps` under the folder, with the batch scripts it was for;
 * removed with the batch.
 */
async function installDeps(s, batch, inst) {
  const n = N();
  const nd = await import("/src/community/needs.ts");
  const se = await import("/src/community/study-engines.ts");
  s.deps ??= {};
  const entries = catalogue();
  let askers = batch.filter((e) => s.installed[e.name]?.ok).map((e) => ({ who: s.installed[e.name].dir, root: s.installed[e.name].dir }));
  for (let depth = 0; depth < 2 && askers.length > 0; depth++) {
    const next = [];
    for (const { who, root } of askers) {
      // What the sweep already installed is passed as `absent`, so a second
      // script that needs it is still told so and is credited with it.
      for (const need of nd.needsOf(n.vfs, who, entries, "/home/we/dust", n.engineState?.engines ?? [], Object.keys(s.deps))) {
        const e = need.entry;
        if (!e) continue;
        const dir = e.name.toLowerCase();
        if (s.deps[dir]) {
          if (!s.deps[dir].for.includes(root)) s.deps[dir].for.push(root);
          continue;
        }
        if (n.vfs.isDir(`${CODE}/${dir}`)) continue; // `exists` is for files
        const t0 = performance.now();
        try {
          const study = se.studyEngineOf(e.url);
          let r;
          if (study) {
            r = await se.installStudyEngine(n.vfs, study, { commit: () => n.opfs.flush() });
          } else {
            const repo = inst.parseRepoUrl(e.url);
            if (!repo) throw new Error(`not a GitHub repository url: ${e.url}`);
            r = await inst.installFromRepo(n.vfs, repo, { name: dir, commit: () => n.opfs.flush(), maxFiles: inst.DEFAULT_MAX_FILES });
          }
          s.deps[dir] = { ok: true, for: [root], want: need.want, files: r.files, ms: Math.round(performance.now() - t0) };
          next.push({ who: r.name, root });
        } catch (err) {
          s.deps[dir] = { ok: false, for: [root], want: need.want, why: String(err?.message ?? err).slice(0, 300) };
        }
        save(s);
      }
    }
    askers = next;
  }
}

/**
 * NORNS' OWN BOOT TONE. `Crone.sc` ends its boot with a test sine,
 * `SinOsc.ar([218,223]) * 0.125 * EnvGen.ar(Env.linen(2, 3, 6))`: eleven
 * seconds, faithfully played here too. The first script after every reload
 * was listened to inside it and read 0.134 at rest, so a MIDI-only script
 * came out "ok-sound". Wait for it to end: eleven and a half seconds after
 * /crone/ready (log stamps are seconds since the page started).
 */
async function afterBootTone() {
  const line = logLines().find((l) => /\/crone\/ready/.test(l));
  const at = line ? parseFloat(line) : NaN;
  const until = (Number.isFinite(at) ? at * 1000 : 6000) + 11500;
  while (performance.now() < until) await sleep(250);
}

/** The dependencies installed for one batch script, as a row lists them. */
const depsOf = (s, dir) =>
  Object.entries(s.deps ?? {})
    .filter(([, d]) => [].concat(d.for).includes(dir))
    .map(([k, d]) => (d.ok ? `${k} (${d.want})` : `${k} (${d.want}, failed)`));

async function loop() {
  if (!(await booted())) throw new Error("the page did not boot");
  const n = N();
  for (;;) {
    let s = state();
    if (s.phase === "done" || s.paused) return;
    const batch = s.plan.slice(s.batch * s.batchSize, (s.batch + 1) * s.batchSize);
    if (batch.length === 0) {
      s.phase = "done";
      s.finishedAt = new Date().toISOString();
      save(s);
      return;
    }

    if (s.phase === "install") {
      const inst = await import("/src/community/install.ts");
      for (const e of batch) {
        if (s.installed[e.name]) continue;
        const t0 = performance.now();
        try {
          const repo = inst.parseRepoUrl(e.url);
          if (!repo) throw new Error("not a GitHub repository url");
          const r = await inst.installFromRepo(n.vfs, repo, {
            name: e.name.toLowerCase(),
            commit: () => n.opfs.flush(),
            maxFiles: inst.DEFAULT_MAX_FILES, // the app's own default (mosaic is 1209)
          });
          s.installed[e.name] = {
            ok: true,
            dir: r.name,
            commit: r.commit ?? null,
            files: r.files,
            skipped: r.skipped.length,
            engine: r.needsReload,
            ms: Math.round(performance.now() - t0),
          };
        } catch (err) {
          s.installed[e.name] = { ok: false, why: String(err?.message ?? err).slice(0, 300) };
        }
        save(s);
      }
      await installDeps(s, batch, inst);
      await n.opfs.flush();
      s.phase = "run";
      s.idx = 0;
      save(s);
      setTimeout(() => location.reload(), 300);
      return;
    }

    if (s.phase === "run") {
      await afterBootTone();
      // A batch whose classes crashed the compiler boots WITHOUT any of
      // them, and every engine in it would be reported missing.
      const fallback = logLines().some((l) => /booted WITHOUT the installed scripts/.test(l));
      if (fallback && !s.notes.includes(`batch ${s.batch}: sclang fell back`)) {
        s.notes.push(`batch ${s.batch}: sclang fell back`);
        save(s);
      }
      while (s.idx < batch.length) {
        const e = batch[s.idx];
        // A script that takes the PAGE down leaves `current` set: the
        // reload resumes here. Once more, then it is recorded and passed.
        s.attempts = s.attempts ?? {};
        if (s.current === e.name && (s.attempts[e.name] ?? 0) >= 2) {
          const row = { name: e.name, tags: e.tags, url: e.url, author: e.author, install: s.installed[e.name] ?? null };
          row.verdict = "page-crash";
          row.problems = ["page-crash"];
          row.log = [`the page went away twice while testing it (last error: ${s.lastError ?? "none"})`];
          row.label = s.label;
          row.batch = s.batch;
          const all = read(RESULTS, []).filter((r) => !(r.name === row.name && r.label === row.label));
          all.push(row);
          write(RESULTS, all);
          const done = new Set(read(DONE, []));
          done.add(e.name.toLowerCase());
          write(DONE, [...done]);
          s.idx++;
          delete s.current;
          save(s);
          continue;
        }
        s.current = e.name;
        s.attempts[e.name] = (s.attempts[e.name] ?? 0) + 1;
        save(s);
        let row;
        // A HIDDEN PAGE MEASURES NOTHING. Muted, it is a silent page to the
        // browser, which wakes it once a second; norns-js then suspends its
        // audio rather than play out of time (main.ts), and a suspended
        // context is a server that cannot answer — every script tested like
        // that read "silent" or "server-killed". So wait until it is seen.
        await untilSeen();
        const hiddenBefore = hiddenCount;
        try {
          row = await testOne(e, s.installed[e.name], fallback);
          if (hiddenCount !== hiddenBefore) {
            row.hidden = true;
            row.problems = [...(row.problems ?? []), "page-hidden"];
            row.verdict = "page-hidden";
          }
        } catch (err) {
          // The HARNESS failed on this script — a dead server throwing
          // into a call, usually. Recorded, never fatal to the run.
          row = { name: e.name, tags: e.tags, url: e.url, author: e.author, install: s.installed[e.name] ?? null };
          row.verdict = "harness-error";
          row.problems = ["harness-error"];
          row.serverAfter = await alive(2000);
          if (!row.serverAfter) row.problems.push("server-killed");
          row.log = [String(err?.stack ?? err).slice(0, 400)];
          try {
            n.host.run("norns.script.clear()");
          } catch {}
        }
        s = state();
        delete s.current;
        save(s);
        if (row === "reload") {
          setTimeout(() => location.reload(), 300);
          return;
        }
        row.label = s.label;
        row.batch = s.batch;
        const deps = depsOf(s, s.installed[e.name]?.dir);
        if (deps.length > 0) row.deps = deps;
        const all = read(RESULTS, []).filter((r) => !(r.name === row.name && r.label === row.label));
        all.push(row);
        write(RESULTS, all);
        const done = new Set(read(DONE, []));
        done.add(e.name.toLowerCase());
        write(DONE, [...done]);
        s.idx++;
        save(s);
      }
      // Every batch's rows go to disk as soon as they exist.
      await exportToDisk().catch(() => {});
      // `hold`: stop here, the batch still installed and compiled, for the
      // hand tests (probe.js); `resume()` then cleans and goes on.
      if (s.hold && s.heldAt !== s.batch) {
        s.heldAt = s.batch;
        s.paused = true;
        save(s);
        return;
      }
      // Clean: one script's library must not satisfy another's include.
      for (const e of batch) {
        const inf = s.installed[e.name];
        if (!inf?.ok || s.preexisting.includes(inf.dir)) continue;
        const dir = `${CODE}/${inf.dir}`;
        for (const p of n.vfs.walk(dir)) n.vfs.remove(p);
        n.vfs.remove(dir);
      }
      // And what was installed for them: the next batch must ask for its own.
      for (const [name, d] of Object.entries(s.deps ?? {})) {
        if (!d.ok || s.preexisting.includes(name)) continue;
        const dir = `${CODE}/${name}`;
        for (const p of n.vfs.walk(dir)) n.vfs.remove(p);
        n.vfs.remove(dir);
      }
      await n.opfs.flush();
      s.batch++;
      s.phase = "install";
      s.idx = 0;
      s.installed = {};
      s.deps = {};
      save(s);
    }
  }
}

const PROBLEMS = [
  ["lua-error", /SCRIPT ERROR|attempt to |bad argument|stack traceback|MISSING INCLUDE|module '.*' not found/],
  ["engine-alloc", /failed to allocate|WITHOUT a working engine/],
  ["sc-undefined", /Undefined class|has not been defined/],
  ["sc-error", /\bERROR: (?!.*Node \d+ not found)/],
  ["ugen-missing", /NOT sending SynthDef/],
  ["synthdef-missing", /SynthDef .* not found/],
  ["file-missing", /no such file|did not load|could not be fetched|cannot decode/],
  ["server-dead", /server has stopped|not acknowledged|not responsive/],
  ["engine-missing", /could not find engine|not an engine|engine .* (?:not found|missing)/i],
  ["buffer-write", /NOT writing buffer/],
  ["shell", /shell refused/],
];
const NOISE = /FAILURE IN SERVER \/(n_free|n_set|n_map|n_mapn|g_freeAll|n_run) Node \d+ not found|Bus has already been freed/;

function classify(lines) {
  const found = new Set();
  for (const l of lines) {
    if (NOISE.test(l)) continue;
    for (const [k, re] of PROBLEMS) if (re.test(l)) found.add(k);
  }
  return [...found];
}

async function injectInput(ms) {
  const n = N();
  const ctx = n.audio;
  if (!ctx || !n.crone?.node) return null;
  n.host.run("audio.level_monitor(0)");
  await sleep(200);
  const osc = new OscillatorNode(ctx, { frequency: 220 });
  const g = new GainNode(ctx, { gain: 0.3 });
  osc.connect(g);
  g.connect(n.crone.node, 0, 1);
  osc.start();
  let mx = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await sleep(150);
    mx = Math.max(mx, n.peak() ?? 0);
  }
  osc.stop();
  g.disconnect();
  n.host.run('audio.level_monitor(util.dbamp(params:get("monitor_level")))');
  return Math.round(mx * 1000) / 1000;
}

/** Every file under ~/dust/data and ~/dust/audio, by path. */
function dustFiles() {
  const v = N().vfs;
  const out = [];
  for (const d of ["/home/we/dust/data", "/home/we/dust/audio"]) {
    for (const e of v.walk(d)) out.push(typeof e === "string" ? e : e.path);
  }
  return out;
}

async function testOne(e, inf, fallback) {
  const n = N();
  n.master.gain.value = 0;
  const row = { name: e.name, tags: e.tags, url: e.url, author: e.author, install: inf ?? null, sclangFallback: fallback };
  if (!inf?.ok) {
    row.verdict = "install-failed";
    return row;
  }
  const dir = `${CODE}/${inf.dir}`;
  const before = dustFiles();
  const luas = n.vfs
    .list(dir)
    .filter((f) => !f.isDir && f.name.endsWith(".lua"))
    .map((f) => f.name);
  const main = luas.find((f) => f.toLowerCase() === `${inf.dir.toLowerCase()}.lua`) ?? luas[0];
  if (!main) {
    row.verdict = "no-main-lua";
    return row;
  }
  row.main = main;

  const up = await alive(3000);
  if (!up) {
    const s = state();
    if (!s.retried[e.name]) {
      s.retried[e.name] = true;
      s.notes.push(`server dead before ${e.name}: reloaded`);
      save(s);
      return "reload";
    }
    row.serverDeadBefore = true;
  }

  const keys = document.querySelector("#keysattach");
  if (keys && keys.getAttribute("aria-pressed") !== "true") keys.click();

  const l0 = logLines().length;
  const s0 = n.engine.scLog.length;

  // LEFT ALONE FIRST. The exerciser presses K2 and K3, and on a sequencer
  // that is "stop": hs010 played from the moment it opened and was
  // reported silent because the listening came after K2. raindrops took
  // five seconds to play its first note. So the script is opened and
  // listened to, untouched, before anything is pressed.
  n.host.run(`norns.script.load(${JSON.stringify(`${dir}/${main}`)})`);
  await sleep(1500);
  n.host.run("if _menu and _menu.set_mode then pcall(_menu.set_mode, false) end");
  let idle = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    await sleep(250);
    idle = Math.max(idle, n.peak() ?? 0);
  }
  row.idlePeak = Math.round(idle * 1000) / 1000;
  n.master.gain.value = 0;

  // THE INPUT, TO THE SCRIPT AS IT OPENED. It used to be fed after the
  // exerciser — which clears the script when it is done — so it went into an
  // empty page, and every input-driven script of the synth, sampler+drum and
  // looper sweeps measured 0 (delayyyyyyyy passes its input straight through
  // and read "silent"). Now: once untouched, here, and once more after the
  // keys, with the script kept loaded for it.
  const iu = await import("/src/engine/input-use.ts").catch(() => null);
  const hears = (engine) => (iu && engine && engine !== "None" ? iu.engineReadsInput(n.vfs, engine) : false);
  const WANTS = /records from the audio input|listens to the audio input/;
  const engineNow = (n.engine.scLog.slice(s0).join("\n").match(/engine: an Engine_(\w+)/g) ?? []).pop()?.slice(18);
  if (logLines().slice(l0).some((l) => WANTS.test(l)) || hears(engineNow)) row.inputPeak = await injectInput(2500);

  let rep = null;
  try {
    rep = await n.exercise({ only: [`${dir}/${main}`], initTimeoutMs: 25000, listenMs: 2000, keep: true });
  } catch (err) {
    row.exerciseError = String(err?.message ?? err);
  }
  n.master.gain.value = 0;
  const ex = rep?.rows?.[0] ?? null;
  row.ex = ex
    ? {
        initDone: ex.initDone,
        loadMs: ex.loadMs,
        engine: ex.engine,
        pixels: ex.pixels,
        responds: ex.responds,
        peak: Math.round((ex.peak ?? 0) * 1000) / 1000,
        notePeak: ex.notePeak === null ? null : Math.round(ex.notePeak * 1000) / 1000,
        gridLit: ex.gridLit,
        errors: (ex.errors ?? []).slice(0, 4).map((x) => String(x).slice(0, 300)),
        loadError: ex.loadError ? String(ex.loadError).slice(0, 300) : null,
      }
    : null;

  const slice = logLines().slice(l0);
  row.wantsInput = slice.some((l) => WANTS.test(l));
  row.engineHearsInput = iu ? hears(ex?.engine) : null;
  if (row.wantsInput || row.engineHearsInput) row.inputPeakAfter = await injectInput(2500);

  row.serverAfter = await alive(3000);
  if (row.serverAfter === false) {
    // A second, longer ask: a server busy for more than 3 s is not a dead one.
    row.serverLater = await alive(8000);
    const sc = n.engine.scLog.slice(s0).filter((l) => !/^(cpu_|amp_|pitch_)/.test(l));
    row.deathLog = {
      sc: sc.slice(-30).map((l) => String(l).slice(0, 240)),
      page: logLines().slice(l0).filter((l) => l.trim() !== "").slice(-20).map((l) => l.slice(0, 240)),
      ctx: n.audio?.state ?? null,
    };
  }
  const all = [...slice, ...n.engine.scLog.slice(s0)];
  row.problems = classify(all);
  if (row.serverDeadBefore === undefined && row.serverAfter === false) row.problems.push(row.serverLater ? "server-slow" : "server-killed");
  const m = slice.join("\n").match(/engine: (\d+) commands/);
  row.commands = m ? Number(m[1]) : null;
  row.log = row.problems.length
    ? all.filter((l) => !NOISE.test(l) && PROBLEMS.some(([, re]) => re.test(l))).slice(0, 30).map((l) => l.slice(0, 300))
    : [];

  const sound = Math.max(
    row.idlePeak ?? 0,
    row.ex?.peak ?? 0,
    row.ex?.notePeak ?? 0,
    row.inputPeak ?? 0,
    row.inputPeakAfter ?? 0,
  );
  row.sound = Math.round(sound * 1000) / 1000;
  const bad = row.problems.filter((p) => p !== "shell");
  row.verdict = !ex
    ? "exercise-failed"
    : ex.loadError
      ? "load-error"
      : !ex.initDone
        ? "init-timeout"
        : bad.length > 0
          ? "problems"
          : sound > 0
            ? "ok-sound"
            : ex.pixels > 0
              ? "silent"
              : "blank";

  n.host.run("norns.script.clear()");
  n.host.run("if _menu and _menu.set_mode then pcall(_menu.set_mode, true) end");
  await sleep(800);
  // What vanished from data and audio while this script ran, outside its
  // own data folder. `~/dust/data/catalogs/community.json` went missing
  // during the sampler+drum sweep with nothing to say which script took it.
  const after = new Set(dustFiles());
  const own = `/home/we/dust/data/${inf.dir}/`;
  const gone = before.filter((p) => !after.has(p) && !p.startsWith(own));
  if (gone.length > 0) {
    row.vanished = { count: gone.length, some: gone.slice(0, 12) };
    row.problems = [...row.problems, "files-vanished"];
  }
  return row;
}

/** Stop at the end of each batch's tests, before it is removed (see the loop). */
export function hold(on = true) {
  const s = state();
  if (s) {
    s.hold = on;
    save(s);
  }
  return status();
}

/** Stop after the current script. */
export function pause() {
  const s = state();
  if (s) {
    s.paused = true;
    save(s);
  }
}
export function resume() {
  const s = state();
  if (s) {
    delete s.paused;
    save(s);
  }
  return ensureRunning();
}
