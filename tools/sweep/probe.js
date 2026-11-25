// One script, by hand, in the page (dev tool, not shipped): load it, do what
// its instructions say, and measure. The sweep (runner.js) asks every script
// the same questions; this is for the ones whose answer was "silent".
//
//   const p = await import('/tools/sweep/probe.js')
//   await p.probe('lorenzos-drums', { actions: ['key(1,1) key(3,1) key(3,0) key(1,0)', { wait: 3000 }] })
//
// Actions: a string is Lua run in matron; `{ wait }` sleeps; `{ input: ms }`
// feeds a 220 Hz tone into the audio input for that long; `{ note, ms }`
// plays a note on the virtual MIDI keyboard. The master stays at zero the
// whole time: the meter reads before it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = () => window.__norns;
const logLines = () => (document.querySelector("#log")?.innerText ?? "").split("\n");

async function listen(ms) {
  let mx = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    mx = Math.max(mx, N().peak() ?? 0);
    await sleep(30);
  }
  return Math.round(mx * 1000) / 1000;
}

async function feed(ms) {
  const n = N();
  n.host.run("audio.level_monitor(0)");
  // Let it land: started at once, the first milliseconds of the tone went
  // through the monitor at 0 dB and every input read about 0.3 — the tone
  // itself, not the script (carter's delay and dimension-expander looked
  // alive that way). The runner always waited; now this does too.
  await sleep(300);
  const osc = new OscillatorNode(n.audio, { frequency: 220 });
  const g = new GainNode(n.audio, { gain: 0.3 });
  osc.connect(g);
  g.connect(n.crone.node, 0, 1);
  osc.start();
  const peak = await listen(ms);
  osc.stop();
  g.disconnect();
  n.host.run('audio.level_monitor(util.dbamp(params:get("monitor_level")))');
  return peak;
}

const NOISE = /Node \d+ not found|Bus has already been freed|Ableton Link|clock_link|starting poll|id_port_lookup/;
const BAD = /ERROR|error|attempt to|bad argument|traceback|not found|no such file|did not load|refused|cannot/i;

/** Every file under ~/dust/data and ~/dust/audio. */
function dustFiles() {
  const out = [];
  for (const d of ["/home/we/dust/data", "/home/we/dust/audio"]) {
    for (const e of N().vfs.walk(d)) out.push(typeof e === "string" ? e : e.path);
  }
  return out;
}

export async function probe(name, opts = {}) {
  const n = N();
  n.master.gain.value = 0;
  // `fresh`: the script's saved state goes first. The sweep turns encoders
  // at random and most scripts save their params on the way out, so a
  // second test starts from the first one's knob positions (piwip came back
  // with "only play during rec" switched on).
  if (opts.fresh) {
    const d = `/home/we/dust/data/${name}`;
    for (const p of n.vfs.walk(d)) n.vfs.remove(typeof p === "string" ? p : p.path);
  }
  const before = dustFiles();
  const l0 = logLines().length;
  const s0 = n.engine.scLog.length;
  const main = opts.main ?? `${name}/${name}.lua`;
  n.host.run(`norns.script.load("/home/we/dust/code/${main}")`);
  await sleep(opts.waitInit ?? 7000);
  n.master.gain.value = 0;
  const out = { idle: await listen(opts.idleMs ?? 2000), steps: [] };
  for (const a of opts.actions ?? []) {
    if (typeof a === "string") {
      n.host.run(a);
      out.steps.push({ lua: a.slice(0, 60), peak: await listen(opts.afterMs ?? 1500) });
    } else if (a.wait) {
      out.steps.push({ wait: a.wait, peak: await listen(a.wait) });
    } else if (a.input) {
      out.steps.push({ input: a.input, peak: await feed(a.input) });
    } else if (a.note !== undefined) {
      // A device under the keyboard's own name, so it takes the vport the
      // keyboard has (port 1 here), through the manager a real one uses.
      window.__probeKbd ??= n.midi.add({ descriptor: { id: "probe-keyboard", name: "virtual midi keyboard" }, send() {} });
      const kb = window.__probeKbd;
      kb.receive([0x90, a.note, a.vel ?? 100]);
      const p = await listen(a.ms ?? 600);
      kb.receive([0x80, a.note, 0]);
      out.steps.push({ note: a.note, peak: p });
    }
    n.master.gain.value = 0;
  }
  out.peak = Math.max(out.idle, ...out.steps.map((s) => (typeof s.peak === "number" ? s.peak : 0)));
  out.alive = await n.engine.syncServer(2000).catch(() => false);
  out.audio = n.audio.state;
  out.hidden = document.hidden;
  const page = logLines().slice(l0).filter((l) => l.trim() !== "" && !NOISE.test(l));
  out.problems = [...new Set([...page, ...n.engine.scLog.slice(s0)].filter((l) => BAD.test(l) && !NOISE.test(l)).map((l) => l.replace(/^\s*[\d.]+\s+/, "").slice(0, 220)))].slice(0, 12);
  out.tail = page.slice(-6).map((l) => l.slice(0, 200));
  // Anything outside the script's own data folder that is gone now.
  const after = new Set(dustFiles());
  const own = `/home/we/dust/data/${name}/`;
  const gone = before.filter((p) => !after.has(p) && !p.startsWith(own));
  if (gone.length > 0) out.vanished = { count: gone.length, some: gone.slice(0, 8) };
  return out;
}
