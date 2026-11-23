// E9-202 — does an underrun leave latency behind, and does a restart give it back?
//
// Chromium, with an AudioWorklet and its output FIFO in use (Android), raises
// what it keeps in that FIFO by one device callback at every underrun and never
// lowers it. Only `AudioContext.playbackStats` sees it; `outputLatency` does not.
// `src/ui/latency-reclaim.ts` takes it back with suspend() + resume(). This
// reproduces both halves on a desktop, where that path has to be forced.
//
//   node tools/measure-output-margin.mjs [path-to-chrome]
//
// A real Chrome is started twice, MUTED, each time in a throwaway profile:
// once as it ships and once with the FIFO forced. Nothing of the project is
// loaded — the page is an empty one served from this script.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.argv[2] ??
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page. A worklet that can be told to hold its thread for N ms. */
const inPage = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume();
  const src =
    "registerProcessor('stall', class extends AudioWorkletProcessor {" +
    "constructor(){ super(); this.n = 0; this.port.onmessage = e => { this.n = e.data; }; }" +
    "process(){ if (this.n > 0) { const t = Date.now(); while (Date.now() - t < this.n) {} this.n = 0; } return true; } });";
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "stall", { numberOfInputs: 0, numberOfOutputs: 1 });
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(ctx.destination);
  const stats = ctx.playbackStats;
  if (!stats) return JSON.stringify([{ step: "this browser has no AudioContext.playbackStats" }]);
  const ms = (s) => +(s * 1000).toFixed(1);
  const read = async (step) => {
    await sleep(1500);
    stats.resetLatency();
    await sleep(1500);
    return {
      step,
      underruns: stats.underrunEvents,
      measuredMs: ms(stats.averageLatency),
      outputLatencyMs: ms(ctx.outputLatency),
    };
  };
  const rows = [];
  rows.push(await read("fresh"));
  node.port.postMessage(45);
  rows.push(await read("after one 45 ms stall"));
  node.port.postMessage(45);
  rows.push(await read("after a second"));
  await ctx.suspend();
  await ctx.resume();
  rows.push(await read("after suspend + resume"));
  await ctx.close();
  return JSON.stringify(rows);
};

async function run(label, flags) {
  const server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>margin</title>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pagePort = server.address().port;
  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "njs-margin-"));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=480,320",
      ...flags,
      `http://127.0.0.1:${pagePort}/`,
    ],
    { stdio: "ignore" },
  );
  try {
    let socketUrl;
    for (let i = 0; i < 60 && !socketUrl; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        socketUrl = targets.find((t) => t.type === "page" && t.url.includes(`:${pagePort}`))?.webSocketDebuggerUrl;
      } catch {}
      if (!socketUrl) await sleep(250);
    }
    if (!socketUrl) throw new Error(`no page — is this a Chrome? ${CHROME}`);
    const ws = new WebSocket(socketUrl);
    await new Promise((ok, no) => {
      ws.onopen = ok;
      ws.onerror = no;
    });
    let nextId = 1;
    const waiting = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      waiting.get(d.id)?.(d);
      waiting.delete(d.id);
    };
    const evaluate = (expression) =>
      new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        ws.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    // The target exists before its document does, and a worklet needs the real one.
    for (let i = 0; i < 60; i++) {
      const ready = await evaluate(`document.readyState === "complete" && isSecureContext && location.port === "${pagePort}"`);
      if (ready.result?.result?.value === true) break;
      await sleep(250);
    }
    const d = await evaluate(`(${inPage.toString()})()`);
    ws.close();
    const value = d.result?.result?.value;
    if (typeof value !== "string") throw new Error(JSON.stringify(d).slice(0, 400));
    console.log(`\n${label}`);
    for (const r of JSON.parse(value)) {
      console.log(
        r.measuredMs === undefined
          ? `  ${r.step}`
          : `  ${r.step.padEnd(24)} measured ${String(r.measuredMs).padStart(6)} ms   outputLatency ${String(r.outputLatencyMs).padStart(5)} ms   underruns ${r.underruns}`,
      );
    }
  } finally {
    chrome.kill();
    server.close();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

await run("as Chrome ships on this machine", []);
await run("with the output FIFO forced, as on Android", ["--disable-blink-features=WebAudioBypassOutputBuffering"]);
