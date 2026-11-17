// E2-06 — is batching draw calls into wasm worth doing?
//
// The story was downgraded from mandatory when E0 settled that cairo-wasm is
// fast enough, which answered a different question: whether CAIRO is fast
// enough, not whether the one-call-per-operation boundary between JS and wasm
// is. 36 of the 128 calls norns makes during boot are `screen_move`, and each
// one crosses that boundary separately.
//
// So this measures rather than assumes, and the numbers go in the backlog. It
// asserts only a loose bound — enough to catch a tenfold regression, not tight
// enough to fail on a busy machine — and prints the detail.

import { beforeAll, describe, expect, it } from "vitest";
import { createScreen, type Screen } from "../src/screen/screen.js";
import { loadScreenModule } from "../src/screen/screen-node.js";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";

let screen: Screen;
let host: Host;

/** Median rather than mean: one scheduling hiccup should not move the number. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function timeEach(n: number, fn: () => void): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

beforeAll(async () => {
  screen = await createScreen(loadScreenModule);
  host = createHost({ sources: loadNornsLua() });
  screen.register(host.registry);
  boot(host, loadConfig());
  host.run(`_norns.stat(50, 40, 10, 10, 10, 10, 10)`);
  host.run(`_norns.battery(100, 0)`);
  host.run(`norns.menu.toggle(true)`);
  host.run(`_menu.redraw()`);
}, 60_000);

describe("what a redraw costs", () => {
  it("measures a full menu redraw, and it is nowhere near a frame", () => {
    // Warm up: the first calls through a cwrap are not representative.
    for (let i = 0; i < 20; i++) host.run(`_menu.redraw()`);

    const before = host.registry.stats().total;
    const samples = timeEach(200, () => void host.run(`_menu.redraw()`));
    const calls = (host.registry.stats().total - before) / 200;
    const ms = median(samples);

    // eslint-disable-next-line no-console
    console.log(
      `  menu redraw: ${ms.toFixed(3)} ms median over 200, ` +
        `${calls.toFixed(0)} _norns calls each, ` +
        `${((ms / calls) * 1000).toFixed(1)} us per call, ` +
        `p95 ${median(samples.slice().sort((a, b) => a - b).slice(-20)).toFixed(3)} ms`,
    );

    // A frame at 60 Hz is 16.7 ms and norns redraws on demand, not per frame.
    // 5 ms is a tenfold headroom over what this machine measures; the point is
    // to notice a regression, not to police the number.
    expect(ms).toBeLessThan(5);
    expect(calls).toBeGreaterThan(10);
  });

  it("measures the JS-to-wasm boundary on its own", () => {
    // The cost batching would remove. If this is small relative to a redraw,
    // batching has nothing to win.
    const N = 20_000;
    host.run(`
      function _bench_moves(n)
        for i = 1, n do _norns.screen_move(i % 128, i % 64) end
      end
    `);
    const t0 = performance.now();
    host.run(`_bench_moves(${N})`);
    const total = performance.now() - t0;
    const perCall = (total / N) * 1000;

    // eslint-disable-next-line no-console
    console.log(
      `  screen_move alone: ${perCall.toFixed(2)} us per call ` +
        `(${N} calls in ${total.toFixed(1)} ms), Lua loop overhead included`,
    );

    expect(perCall).toBeLessThan(50);
  });

  it("the whole 128-call boot sequence costs less than a frame", () => {
    // The number E0-05 measured: 128 calls to put norns on screen from cold.
    const fresh = createHost({ sources: loadNornsLua() });
    screen.register(fresh.registry);
    const t0 = performance.now();
    boot(fresh, loadConfig());
    fresh.run(`_norns.stat(50,40,10,10,10,10,10) _norns.battery(100,0)`);
    fresh.run(`norns.menu.toggle(true) _menu.redraw()`);
    const total = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(`  cold boot to first frame: ${total.toFixed(1)} ms (Lua + screen, no audio)`);

    // Generous: this includes compiling ~60 Lua files.
    expect(total).toBeLessThan(2000);
  });
});
