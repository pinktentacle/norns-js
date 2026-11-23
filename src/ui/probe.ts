/**
 * E9-200 — EVERYTHING A PROFILE HAS TO CARRY BACK, IN ONE PLACE.
 *
 * Four releases went out to a phone to change what the instruments said.
 * Each answered the question that had just been asked and left the next
 * one unanswerable: `_bench` had no audio-thread reading, then it had one
 * with no histogram, then the OSC was a total with no addresses in it.
 * A release costs a build, a publish and somebody holding a phone, and
 * spending one on a `log()` line is a poor trade.
 *
 * So this is the whole set, taken at once, and the rule for what is in it
 * is the question "if the number on the phone is bad, what would I need
 * to know next?" — asked until the answer was a thing already here:
 *
 *     the account         every timed path, with calls and the cost of one
 *     the bridge          every `_norns.*` call, counted and sampled
 *     the OSC             all four directions, by address
 *     sclang              how long it takes to answer, measured by asking
 *     the clock           how late a metro reaches Lua after it fired
 *     the main thread     timer lateness, frame spacing, input delay
 *     the audio output    underruns and latency, from the browser itself
 *     memory              what is allocated and how often it is collected
 *     the machine         a fixed loop timed at every mark
 *
 * NOTHING HERE RUNS UNLESS `?profile` ASKED. Every collector is fed by a
 * callback that is absent otherwise, so a page nobody is measuring does
 * not pay for the measuring.
 *
 * COUNTS AND TOTALS, NOT VERDICTS. A reading that says "fast" or "slow"
 * has already thrown away what it was made of. Every line carries how
 * many it saw and the total it summed, so that a number can be divided
 * by a different thing later than the thing somebody guessed today.
 */

// ---------------------------------------------------------------------------
// histograms
// ---------------------------------------------------------------------------

export interface Hist {
  /** Upper bounds, ascending. One more bucket follows for everything above. */
  readonly edges: readonly number[];
  counts: number[];
  n: number;
  sum: number;
  max: number;
}

export function makeHist(edges: readonly number[]): Hist {
  return { edges, counts: new Array<number>(edges.length + 1).fill(0), n: 0, sum: 0, max: 0 };
}

export function addHist(h: Hist, v: number): void {
  if (!Number.isFinite(v)) return;
  let i = 0;
  while (i < h.edges.length && v > h.edges[i]!) i++;
  h.counts[i] = (h.counts[i] ?? 0) + 1;
  h.n++;
  h.sum += v;
  if (v > h.max) h.max = v;
}

export function resetHist(h: Hist): void {
  h.counts.fill(0);
  h.n = 0;
  h.sum = 0;
  h.max = 0;
}

const trim = (v: number): string => {
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
};

/**
 * `n 240 · mean 0.21 · max 0.66 ms · <=0.25: 201 · <=0.5: 37 · <=1: 2`
 *
 * EMPTY BUCKETS ARE LEFT OUT and an empty histogram says so in a word. A
 * row of zeros is a line nobody reads to the end, and "none" cannot be
 * mistaken for a reading of zero — which is the mistake E9-180 was.
 */
export function sayHist(h: Hist, unit = "ms"): string {
  if (h.n === 0) return "none";
  const parts = [`n ${h.n}`, `mean ${trim(h.sum / h.n)}`, `max ${trim(h.max)} ${unit}`];
  for (let i = 0; i < h.counts.length; i++) {
    const c = h.counts[i]!;
    if (c === 0) continue;
    parts.push(i < h.edges.length ? `<=${h.edges[i]}: ${c}` : `more: ${c}`);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// OSC, by address
// ---------------------------------------------------------------------------

/**
 * scsynth's command numbers. sclang sends most of its traffic with one of
 * these where the address would be, so without the table a note is
 * `#9` and the reader has to know.
 *
 * THE NUMBER IS ALWAYS PRINTED BESIDE THE NAME. If this list is wrong
 * about one of them the number is still the fact.
 */
const SC_COMMANDS: readonly string[] = [
  "none", "notify", "status", "quit", "cmd", "d_recv", "d_load", "d_loadDir", "d_freeAll", "s_new",
  "n_trace", "n_free", "n_run", "n_cmd", "n_map", "n_set", "n_setn", "n_fill", "n_before", "n_after",
  "u_cmd", "g_new", "g_head", "g_tail", "g_freeAll", "c_set", "c_setn", "c_fill", "b_alloc", "b_allocRead",
  "b_read", "b_write", "b_free", "b_close", "b_zero", "b_set", "b_setn", "b_fill", "b_gen", "dumpOSC",
  "c_get", "c_getn", "b_get", "b_getn", "s_get", "s_getn", "n_query", "b_query", "n_mapn", "s_noid",
  "g_deepFree", "clearSched", "sync", "d_free", "b_allocReadChannel", "b_readChannel", "g_dumpTree",
  "g_queryTree", "error", "s_newargs", "n_mapa", "n_mapan", "n_order", "p_new", "version",
];

/** How much of an address is kept. Past this it is somebody's payload. */
const NAME_MAX = 40;

/** What one OSC message is called, read from its first bytes and nothing else. */
export function oscName(b: Uint8Array, from = 0, to = b.length): string {
  if (to - from < 4) return "(short)";
  const first = b[from]!;
  if (first === 0) {
    const n = b[from + 3]!;
    return `#${n} ${SC_COMMANDS[n] ?? "?"}`;
  }
  let end = from;
  while (end < to && end - from < NAME_MAX && b[end] !== 0) end++;
  let s = "";
  for (let i = from; i < end; i++) {
    const c = b[i]!;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "?";
  }
  return s;
}

/**
 * The names in a packet: one for a message, one for each element of a
 * bundle. A bundle inside a bundle is opened too, to a depth nothing
 * real reaches.
 */
export function oscNames(b: Uint8Array, from = 0, to = b.length, depth = 0): string[] {
  const isBundle =
    to - from >= 16 && b[from] === 0x23 && b[from + 1] === 0x62 && b[from + 2] === 0x75 && b[from + 7] === 0;
  if (!isBundle || depth > 4) return [oscName(b, from, to)];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: string[] = [];
  let o = from + 16;
  while (o + 4 <= to) {
    const size = view.getInt32(o, false);
    o += 4;
    if (size <= 0 || o + size > to) break;
    for (const n of oscNames(b, o, o + size, depth + 1)) out.push(n);
    o += size;
  }
  return out.length === 0 ? ["#bundle (empty)"] : out;
}

export type OscDirection = "to-lang" | "from-lang" | "to-server" | "from-server";

export interface TrafficRow {
  readonly name: string;
  readonly n: number;
  readonly bytes: number;
}

/** Messages and bytes by name, for one direction. */
export class Traffic {
  private readonly rows = new Map<string, { n: number; bytes: number }>();
  packets = 0;

  note(b: Uint8Array): void {
    this.packets++;
    const names = oscNames(b);
    // A bundle's bytes are shared out evenly between its elements: the
    // total is right, and which element was the large one is not a thing
    // this can know without parsing what it promised not to.
    const share = b.length / names.length;
    for (const name of names) {
      const row = this.rows.get(name);
      if (row === undefined) this.rows.set(name, { n: 1, bytes: share });
      else {
        row.n++;
        row.bytes += share;
      }
    }
  }

  top(k = 8): TrafficRow[] {
    return [...this.rows]
      .map(([name, r]) => ({ name, n: r.n, bytes: r.bytes }))
      .sort((a, b) => b.n - a.n || b.bytes - a.bytes)
      .slice(0, k);
  }

  distinct(): number {
    return this.rows.size;
  }

  reset(): void {
    this.rows.clear();
    this.packets = 0;
  }
}

export function sayTraffic(t: Traffic, k = 8): string {
  if (t.packets === 0) return "none";
  const rows = t.top(k);
  const said = rows.map((r) => `${r.name} ${r.n}${r.bytes >= 1024 ? ` (${(r.bytes / 1024).toFixed(1)} KB)` : ""}`);
  const more = t.distinct() - rows.length;
  return `${t.packets} packet(s): ${said.join(" · ")}${more > 0 ? ` · and ${more} other address(es)` : ""}`;
}

// ---------------------------------------------------------------------------
// the clocks themselves
// ---------------------------------------------------------------------------

/**
 * The smallest step this clock takes, in milliseconds.
 *
 * Chrome clamps `performance.now()` to 5 us on an isolated page and 100 us
 * on one that is not, and every per-call figure below is only as good as
 * that. Measured rather than assumed, because the one time it was
 * assumed the assumption was the bug.
 */
export function clockStepMs(now: () => number, tries = 2000): number {
  let step = Infinity;
  let last = now();
  for (let i = 0; i < tries; i++) {
    const t = now();
    if (t > last) {
      if (t - last < step) step = t - last;
      last = t;
    }
  }
  return Number.isFinite(step) ? step : 0;
}

/**
 * What an EMPTY span reads as when it is timed with two clock reads, in
 * nanoseconds.
 *
 * THIS IS THE BIAS ON EVERY TIMED CALL. A measured 0.20 us for a true
 * 0.11 was not the clamp, which is unbiased over many calls; it was the
 * two clock reads themselves, inside the interval they were measuring.
 * Printed once so that `calls x this` can be taken off any total.
 */
export function clockPairNs(now: () => number, n = 100_000): number {
  // The SUM OF THE MEASURED SPANS, not the time the loop took: what is
  // wanted is what an empty span reads as, which is the part of the two
  // reads that falls between them. Each one is zero or a whole clock step,
  // and the mean of enough of them is the answer.
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = now();
    const b = now();
    sum += b - a;
  }
  return (sum * 1e6) / n;
}

/**
 * A fixed piece of JavaScript, timed. Nanoseconds an iteration.
 *
 * `_cpu` found that a Pixel runs the same Lua five times faster once it
 * has been busy for a while, so "how fast is this machine" has no answer
 * that is not also "how fast was it just now". This is the same loop at
 * every mark: integer arithmetic that cannot be folded away, a few
 * hundred microseconds on a desktop.
 */
export function speedGauge(now: () => number, iterations = 200_000): number {
  let x = 0x9e3779b9 | 0;
  const t0 = now();
  for (let i = 0; i < iterations; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x = (x + i) | 0;
  }
  const t1 = now();
  // Kept, so the loop has a consumer and cannot be thrown away.
  gaugeSink = x;
  return ((t1 - t0) * 1e6) / iterations;
}

/** Where the gauge leaves its result. Read by nothing, on purpose. */
export let gaugeSink = 0;

// ---------------------------------------------------------------------------
// the account, in full
// ---------------------------------------------------------------------------

export interface Cost {
  readonly path: string;
  readonly calls: number;
  readonly ms: number;
  readonly worstMs: number;
}

/**
 * Every timed path with its count and the cost of one call.
 *
 * `profile_mark` prints six paths that reached a millisecond. That hides
 * exactly what a tuning pass looks for: `osc:to-sclang 0.6 ms over 120`
 * never reached a millisecond and is five microseconds a message, a
 * hundred and twenty times a second.
 */
export function sayAccount(costs: readonly Cost[], top = 18): string[] {
  const rows = costs.filter((c) => c.calls > 0).slice(0, top);
  if (rows.length === 0) return ["account: nothing timed ran"];
  const out = [`account: ${rows.length} of ${costs.length} timed path(s) — total ms / calls = us each, worst ms`];
  for (const c of rows) {
    const each = (c.ms * 1000) / c.calls;
    out.push(
      `  ${c.path.padEnd(24)} ${c.ms.toFixed(2).padStart(9)} / ${String(c.calls).padStart(6)} = ${each
        .toFixed(each >= 100 ? 0 : 2)
        .padStart(8)} us, worst ${c.worstMs.toFixed(2)}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// the bridge: Lua calling into this page
// ---------------------------------------------------------------------------

export interface CallSlot {
  /** Calls seen while timing was on. */
  calls: number;
  /** How many of those were actually timed. */
  timed: number;
  /** What the timed ones took, together, in milliseconds. */
  ms: number;
  /**
   * The longest single timed call, in milliseconds. `screen_text` read
   * 34 us a call in one span and 0.65 in another; the difference was one
   * call that loaded a font, and a mean cannot say that about itself.
   */
  max: number;
}

/**
 * What Lua called, how often, and what one call cost on this side.
 *
 * ONE CALL IN EIGHT IS TIMED and the rest are only counted. A redraw is
 * fifty of these and a clock read is not free: timing every one would
 * put the instrument's own cost into the number it was there to report.
 * The estimate is `ms / timed`, with the clock's own cost taken off, and
 * `timed` is printed so a figure built on four samples looks like one.
 *
 * IT IS THIS SIDE ONLY: from the dispatcher's entry to its return. The
 * wasm-to-JavaScript crossing in front of it and Lua's own call are not
 * in it, and `_cpu`'s screen levels measure all three together — the
 * difference between the two is the crossing.
 */
export function sayBridge(slots: Iterable<readonly [string, CallSlot]>, pairNs: number, top = 14): string[] {
  const rows: Array<{ name: string; calls: number; timed: number; each: number; total: number; max: number }> = [];
  let calls = 0;
  for (const [name, s] of slots) {
    if (s.calls === 0) continue;
    calls += s.calls;
    const raw = s.timed > 0 ? (s.ms * 1e6) / s.timed : 0;
    const each = Math.max(0, raw - pairNs);
    rows.push({ name, calls: s.calls, timed: s.timed, each, total: (each * s.calls) / 1e6, max: s.max });
  }
  if (rows.length === 0) return ["bridge: Lua called nothing"];
  rows.sort((a, b) => b.total - a.total || b.calls - a.calls);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const out = [
    `bridge: ${calls} call(s) to ${rows.length} function(s), about ${total.toFixed(2)} ms on this side — est. ms = calls x ns each (timed)`,
  ];
  for (const r of rows.slice(0, top)) {
    // A call nobody timed has no cost to print, and a zero would read as
    // one. It cannot happen while the first of every eight is timed, and
    // it is said rather than assumed in case that ever changes.
    const each = r.timed === 0 ? "     ?" : r.each.toFixed(0).padStart(6);
    out.push(
      `  ${r.name.padEnd(26)} ${r.total.toFixed(2).padStart(8)} = ${String(r.calls).padStart(7)} x ${each} ns ` +
        `(${r.timed} timed, worst ${(r.max * 1000).toFixed(r.max >= 0.1 ? 0 : 1)} us)`,
    );
  }
  if (rows.length > top) out.push(`  and ${rows.length - top} more, ${rows.slice(top).reduce((n, r) => n + r.calls, 0)} call(s)`);
  return out;
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

/**
 * The JavaScript heap, watched for what a snapshot cannot show.
 *
 * One reading says how big the heap is. It takes a series to say how fast
 * it is being filled, and a fall in the series is a collection — which
 * is a pause on the same thread as everything else here.
 */
export class HeapWatch {
  private last: number | null = null;
  allocated = 0;
  collections = 0;
  freed = 0;
  readings = 0;
  now = 0;

  sample(bytes: number | null): void {
    if (bytes === null || !Number.isFinite(bytes)) return;
    this.readings++;
    this.now = bytes;
    if (this.last !== null) {
      const d = bytes - this.last;
      if (d > 0) this.allocated += d;
      // A fall of less than a quarter of a megabyte is the allocator
      // settling, not a collection worth counting.
      else if (d < -262144) {
        this.collections++;
        this.freed += -d;
      }
    }
    this.last = bytes;
  }

  say(seconds: number): string {
    if (this.readings === 0) return "js heap not readable in this browser";
    const mb = (n: number): string => (n / 1048576).toFixed(1);
    const rate = seconds > 0 ? this.allocated / 1048576 / seconds : 0;
    return (
      `js heap ${mb(this.now)} MB, ${mb(this.allocated)} MB allocated (${rate.toFixed(2)} MB/s), ` +
      `${this.collections} collection(s) freeing ${mb(this.freed)} MB — ${this.readings} reading(s)`
    );
  }

  /** A new span. The last reading is kept, or the first delta is lost. */
  reset(): void {
    this.allocated = 0;
    this.collections = 0;
    this.freed = 0;
    this.readings = 0;
  }
}

// ---------------------------------------------------------------------------
// the audio output, as the browser measured it
// ---------------------------------------------------------------------------

/** `AudioContext.playbackStats`, or its older name `playoutStats`. */
export interface PlaybackReading {
  readonly underrunEvents: number;
  /** Seconds. */
  readonly underrunDuration: number;
  readonly totalDuration: number;
  readonly averageLatency: number;
  readonly minimumLatency: number;
  readonly maximumLatency: number;
}

/**
 * Read whichever of the two the browser has, in one shape.
 *
 * THIS IS THE ONLY DIRECT EVIDENCE OF A DROPOUT ANYWHERE IN THE PAGE.
 * crone times its own blocks with a millisecond clock and scsynth reports
 * a share of a budget; both are loads, and a load is an inference about
 * whether audio arrived. This is the output device saying it did not.
 */
export function readPlayback(ctx: unknown): PlaybackReading | null {
  const c = ctx as { playbackStats?: Record<string, unknown>; playoutStats?: Record<string, unknown> } | null;
  const s = c?.playbackStats ?? c?.playoutStats;
  if (s === undefined || s === null) return null;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = s[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  // The older API counted "fallback frames" and reported milliseconds.
  const old = c?.playbackStats === undefined;
  const scale = old ? 0.001 : 1;
  return {
    underrunEvents: num("underrunEvents", "fallbackFramesEvents"),
    underrunDuration: num("underrunDuration", "fallbackFramesDuration") * scale,
    totalDuration: num("totalDuration", "totalFramesDuration") * scale,
    averageLatency: num("averageLatency") * scale,
    minimumLatency: num("minimumLatency") * scale,
    maximumLatency: num("maximumLatency") * scale,
  };
}

export function sayPlayback(before: PlaybackReading | null, after: PlaybackReading | null): string {
  if (after === null) return "playback statistics not available in this browser — underruns are not being counted";
  const events = after.underrunEvents - (before?.underrunEvents ?? 0);
  const lost = (after.underrunDuration - (before?.underrunDuration ?? 0)) * 1000;
  const span = after.totalDuration - (before?.totalDuration ?? 0);
  const ms = (s: number): string => (s * 1000).toFixed(1);
  return (
    `${events} underrun(s) losing ${lost.toFixed(1)} ms of ${span.toFixed(1)} s played · ` +
    `output latency avg ${ms(after.averageLatency)}, min ${ms(after.minimumLatency)}, max ${ms(after.maximumLatency)} ms`
  );
}

// ---------------------------------------------------------------------------
// the session: one of each, and the lines they make
// ---------------------------------------------------------------------------

export interface ProbeSources {
  readonly now: () => number;
  /** `performance.memory.usedJSHeapSize`, or null where there is none. */
  readonly heap: () => number | null;
  /** The bridge's slots, to read and then clear. */
  readonly bridge: () => Iterable<readonly [string, CallSlot]>;
  /** Everything timed since the last mark, dearest first. */
  readonly costs: () => readonly Cost[];
  /** The audio context once there is one. */
  readonly audio: () => unknown;
  /** Presents drawn and skipped by the grid view, cumulative. */
  readonly grid: () => { drawn: number; skipped: number } | null;
  /** The same for the arc's view, when one is attached. E9-207. */
  readonly arc?: () => { drawn: number; skipped: number } | null;
  /** Bytes of each wasm heap worth watching, by name. */
  readonly heaps: () => ReadonlyArray<readonly [string, number]>;
  /** Whole lines the page adds: slow events, pressure, battery. */
  readonly notes: () => string[];
}

export interface Probe {
  osc(dir: OscDirection, bytes: Uint8Array): void;
  /** A command went to sclang; the next packet back is its answer. */
  commandSent(): void;
  /** A ping went out with this id. */
  pingSent(id: number): void;
  /** Its answer came back. */
  pong(id: number): void;
  /** A metro or clock event reached Lua this long after it fired. */
  clockLate(ms: number): void;
  /** The 5 ms timer fired this late. */
  timerLate(ms: number): void;
  /** An animation frame began. */
  frame(at: number): void;
  /** An input event waited this long before anything handled it. */
  input(type: string, delayMs: number): void;
  /** One reading of the heap, on its own timer. */
  heapTick(): void;
  /** The lines for the span since the last call, and a clean slate. */
  report(): string[];
  /** The clock pair cost in use, so other lines can quote it. */
  readonly pairNs: number;
}

const MS_FINE = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50] as const;
const MS_COARSE = [1, 2, 4, 8, 16, 33, 66, 133] as const;
const MS_FRAME = [9, 17, 26, 34, 51, 101, 251] as const;
const MS_QUANTA = [3, 6, 12, 25, 50, 100, 250] as const;

/** A turnaround longer than this was not an answer to the command before it. */
const PAIR_MS = 100;

export function createProbe(src: ProbeSources): Probe {
  const now = src.now;
  const traffic: Record<OscDirection, Traffic> = {
    "to-lang": new Traffic(),
    "from-lang": new Traffic(),
    "to-server": new Traffic(),
    "from-server": new Traffic(),
  };
  const roundTrip = makeHist(MS_FINE);
  const turnaround = makeHist(MS_FINE);
  const clock = makeHist(MS_QUANTA);
  const timer = makeHist(MS_COARSE);
  const frames = makeHist(MS_FRAME);
  const input = makeHist(MS_COARSE);
  const inputBy = new Map<string, number>();
  const heap = new HeapWatch();

  let commandAt = 0;
  let unpaired = 0;
  const pings = new Map<number, number>();
  let pingsLost = 0;
  let lastFrame = 0;
  let spanAt = now();
  // NOT READ HERE. This is built before the page has an audio context or a
  // grid, and the functions that fetch them reach for things declared far
  // below; the first report is the first time either is asked for, and it
  // reports everything since the page began.
  let playback: PlaybackReading | null = null;
  let grid: { drawn: number; skipped: number } | null = null;
  let arc: { drawn: number; skipped: number } | null = null;
  const pairNs = clockPairNs(now);
  // Run before it is read: the first call of any function is the engine
  // still deciding how to compile it, and the first mark printed 4.1 ns
  // for a loop that was 1.2 by the second.
  for (let i = 0; i < 4; i++) speedGauge(now);

  return {
    pairNs,
    osc(dir, bytes) {
      traffic[dir].note(bytes);
      if (dir !== "from-lang" || commandAt === 0) return;
      const d = now() - commandAt;
      commandAt = 0;
      if (d <= PAIR_MS) addHist(turnaround, d);
      else unpaired++;
    },
    commandSent() {
      // The FIRST command since the last answer. A burst is timed from
      // where it began, which is the longest any of it waited.
      if (commandAt === 0) commandAt = now();
    },
    pingSent(id) {
      pings.set(id, now());
      // One that never came back must not sit here for ever looking like
      // a question still open.
      for (const [k, at] of pings) {
        if (now() - at > 5000) {
          pings.delete(k);
          pingsLost++;
        }
      }
    },
    pong(id) {
      const at = pings.get(id);
      if (at === undefined) return;
      pings.delete(id);
      addHist(roundTrip, now() - at);
    },
    clockLate: (ms) => addHist(clock, ms),
    timerLate: (ms) => addHist(timer, ms),
    frame(at) {
      if (lastFrame > 0) addHist(frames, at - lastFrame);
      lastFrame = at;
    },
    input(type, delayMs) {
      addHist(input, delayMs);
      inputBy.set(type, (inputBy.get(type) ?? 0) + 1);
    },
    heapTick: () => heap.sample(src.heap()),
    report() {
      const at = now();
      const seconds = (at - spanAt) / 1000;
      spanAt = at;
      const out: string[] = [];

      for (const line of sayAccount(src.costs())) out.push(line);

      const slots = [...src.bridge()];
      for (const line of sayBridge(slots, pairNs)) out.push(line);
      for (const [, s] of slots) {
        s.calls = 0;
        s.timed = 0;
        s.ms = 0;
        s.max = 0;
      }

      out.push(`osc into sclang: ${sayTraffic(traffic["to-lang"])}`);
      out.push(`osc out of sclang: ${sayTraffic(traffic["from-lang"])}`);
      out.push(`osc into scsynth: ${sayTraffic(traffic["to-server"])}`);
      out.push(`osc out of scsynth: ${sayTraffic(traffic["from-server"])}`);
      for (const t of Object.values(traffic)) t.reset();

      out.push(
        `sclang round trip (ping, ms): ${sayHist(roundTrip)}${pingsLost > 0 ? ` · ${pingsLost} never answered` : ""}`,
      );
      out.push(
        `sclang answering a command (ms): ${sayHist(turnaround)}${
          unpaired > 0 ? ` · ${unpaired} over ${PAIR_MS} ms, not counted as answers` : ""
        }`,
      );
      out.push(`clock delivery, audio time from firing to Lua (ms): ${sayHist(clock)}`);
      out.push(`timer lateness, 5 ms timer (ms): ${sayHist(timer)}`);
      out.push(`frame spacing (ms): ${sayHist(frames)}`);
      out.push(
        `input delay, event to first handler (ms): ${sayHist(input)}${
          inputBy.size === 0 ? "" : ` · ${[...inputBy].map(([k, n]) => `${k} ${n}`).join(", ")}`
        }`,
      );
      resetHist(roundTrip);
      resetHist(turnaround);
      resetHist(clock);
      resetHist(timer);
      resetHist(frames);
      resetHist(input);
      inputBy.clear();
      unpaired = 0;
      pingsLost = 0;
      // A frame that straddles the mark would be charged to the next span
      // at its full length; start the spacing again instead.
      lastFrame = 0;

      const audio = src.audio() as { baseLatency?: number; outputLatency?: number; state?: string } | null;
      const reading = readPlayback(audio);
      out.push(
        `audio out: ${sayPlayback(playback, reading)}` +
          (audio === null || audio === undefined
            ? " · no audio context yet"
            : ` · base ${((audio.baseLatency ?? 0) * 1000).toFixed(1)} ms, reported ${(
                (audio.outputLatency ?? 0) * 1000
              ).toFixed(1)} ms, ${audio.state ?? "?"}`),
      );
      playback = reading;
      // The latency figures are since the last reset, so each span gets
      // its own rather than an average over the whole session.
      try {
        const a = audio as { playbackStats?: { resetLatency?: () => void }; playoutStats?: { resetLatency?: () => void } };
        (a?.playbackStats ?? a?.playoutStats)?.resetLatency?.();
      } catch {
        /* a statistic that cannot be reset is still a statistic */
      }

      heap.sample(src.heap());
      const heaps = src
        .heaps()
        .map(([name, bytes]) => `${name} ${(bytes / 1048576).toFixed(0)} MB`)
        .join(", ");
      out.push(`memory: ${heap.say(seconds)}${heaps === "" ? "" : ` · wasm ${heaps}`}`);
      heap.reset();

      const g = src.grid();
      if (g !== null) {
        // A view is replaced when the grid changes size, and its counts
        // start again; a total that went down is a new view, not a debt.
        const since = (nowN: number, then: number): number => (nowN >= then ? nowN - then : nowN);
        const drawn = since(g.drawn, grid?.drawn ?? 0);
        const skipped = since(g.skipped, grid?.skipped ?? 0);
        out.push(`grid: ${drawn} present(s) drawn, ${skipped} skipped as identical`);
      }
      grid = g;

      const a = src.arc?.() ?? null;
      if (a !== null) {
        const since = (nowN: number, then: number): number => (nowN >= then ? nowN - then : nowN);
        const drawn = since(a.drawn, arc?.drawn ?? 0);
        const skipped = since(a.skipped, arc?.skipped ?? 0);
        // Counted per ring sent: a refresh that touches four rings and
        // changes none is four skipped.
        out.push(`arc: ${drawn} frame(s) painted, ${skipped} ring update(s) skipped as identical`);
      }
      arc = a;

      for (const line of src.notes()) out.push(line);
      out.push(`machine: ${speedGauge(now).toFixed(1)} ns an iteration of the fixed loop`);
      return out;
    },
  };
}
