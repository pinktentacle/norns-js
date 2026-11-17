// E5-24 — the last fifteen.
//
// What is tested here is the part that has no browser in it: the arithmetic,
// the framing and the answers. The image family's decoding and encoding need
// a canvas and are measured in the page instead (`docs/measurements/`).

import { describe, expect, it } from "vitest";
import { NornsRegistry } from "../src/norns/registry.js";
import { PLATFORM, registerHardware } from "../src/norns/hardware.js";
import { registerOsc } from "../src/osc/register.js";
import { frameFor, parseFrame } from "../src/osc/remote.js";
import { luma4 } from "../src/screen/images.js";

function caller(registry: NornsRegistry) {
  return (name: string, ...args: unknown[]): unknown => {
    const fn = registry.implementationFor(name);
    if (!fn) throw new Error(`${name} is not implemented`);
    const out = fn(...(args as never[]));
    return Array.isArray(out) ? out[0] : out;
  };
}

describe("what machine we say we are", () => {
  it("is PLATFORM_OTHER, and neither a factory norns nor a shield", () => {
    // `norns.lua:213-219` turns these into `norns.platform`, `is_norns` and
    // `is_shield`. Shield was the answer here for a while, on the reasoning
    // that a shield is a norns assembled on other hardware — but the only
    // thing `is_shield` gates is the wording of the sleep screen, which then
    // told somebody looking at a web page to wait for an LED to stop
    // blinking and disconnect power. False on both.
    const r = new NornsRegistry();
    registerHardware(r);
    const call = caller(r);
    expect(call("platform")).toBe(PLATFORM.OTHER);
    expect(call("platform_factory")).toBe(false);
    expect(call("platform_shield")).toBe(false);
  });

  it("reports adc_rev 0, which is what keeps encoder acceleration on", () => {
    // `norns.lua:140`: `_norns.adc_rev()==1` picks `process`, anything else
    // picks `process_with_accel`. A shield never sets a revision, so 0 is
    // both the honest answer and the behaviour the page already had.
    const r = new NornsRegistry();
    registerHardware(r);
    expect(caller(r)("adc_rev")).toBe(0);
  });
});

describe("the two numbers menu/home.lua does arithmetic on", () => {
  it("answers a NUMBER even with nothing measuring, which is the whole point", () => {
    // `math.floor(_norns.audio_get_cpu_load())` on a stub that pushes
    // nothing is "bad argument #1 to 'floor'".
    const r = new NornsRegistry();
    registerHardware(r);
    const call = caller(r);
    expect(typeof call("audio_get_cpu_load")).toBe("number");
    expect(typeof call("audio_get_xrun_count")).toBe("number");
  });

  it("scales the block time against its budget, as a percent", () => {
    const r = new NornsRegistry();
    registerHardware(r, { load: () => ({ meanMs: 1.5, budgetMs: 3 }) });
    expect(caller(r)("audio_get_cpu_load")).toBeCloseTo(50, 6);
  });

  it("clamps rather than reporting 400% when a block overran", () => {
    const r = new NornsRegistry();
    registerHardware(r, { load: () => ({ meanMs: 12, budgetMs: 3 }) });
    expect(caller(r)("audio_get_cpu_load")).toBe(100);
  });

  it("reads the xrun count AND CLEARS IT, as jack's does", () => {
    // `jack_client_get_xrun_count` is `atomic_exchange(&xrun_count, 0)`.
    // `menu/home.lua` shows "!!!" whenever the answer is above zero, so a
    // cumulative counter would blink forever after the first dropout.
    const r = new NornsRegistry();
    const hw = registerHardware(r);
    const call = caller(r);
    hw.noteXruns(2);
    hw.noteXruns(3);
    expect(call("audio_get_xrun_count")).toBe(5);
    expect(call("audio_get_xrun_count")).toBe(0);
  });
});

describe("gain_hp", () => {
  it("keeps the value in range and says once that there is no amplifier", () => {
    const lines: string[] = [];
    const r = new NornsRegistry();
    registerHardware(r, { log: (l) => lines.push(l) });
    const call = caller(r);
    call("gain_hp", 40);
    call("gain_hp", 40);
    call("gain_hp", 999);
    // Two changes, two lines: `params:bang()` sets every param on every
    // script load, so a line per CALL would be noise.
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("63");
  });
});

describe("the OSC frame", () => {
  it("round-trips a host and a port that does not fit in a byte", () => {
    const osc = new Uint8Array([1, 2, 3, 4]);
    const f = frameFor("192.168.1.40", 57120, osc);
    const back = parseFrame(f);
    expect(back).not.toBeNull();
    expect(back!.host).toBe("192.168.1.40");
    expect(back!.port).toBe(57120);
    expect([...back!.osc]).toEqual([1, 2, 3, 4]);
  });

  it("refuses a host name that will not fit its length byte", () => {
    expect(() => frameFor("x".repeat(256), 1, new Uint8Array())).toThrow();
  });

  it("returns null for a truncated frame instead of reading past the end", () => {
    expect(parseFrame(new Uint8Array([5, 1, 2]))).toBeNull();
    expect(parseFrame(new Uint8Array([]))).toBeNull();
  });
});

describe("osc_send", () => {
  function harness(remote: { sent: unknown[] } | null) {
    const lines: string[] = [];
    const r = new NornsRegistry();
    registerOsc(r, {
      remote: remote
        ? ({
            send: (h: string, p: number, path: string, args: unknown[]) =>
              remote.sent.push([h, p, path, args]),
          } as never)
        : null,
      log: (l) => lines.push(l),
    });
    return { call: caller(r), lines };
  }

  it("sends to the address in the table", () => {
    const remote = { sent: [] as unknown[] };
    const { call } = harness(remote);
    call("osc_send", ["127.0.0.1", "10111"], "/hello", [1, "two"]);
    expect(remote.sent).toEqual([["127.0.0.1", 10111, "/hello", [1, "two"]]]);
  });

  it("says what is wrong with a malformed address", () => {
    const { call, lines } = harness({ sent: [] });
    call("osc_send", ["127.0.0.1"], "/hello", []);
    expect(lines.join(" ")).toContain("{host, port}");
  });

  it("without a relay, says so ONCE and names what was lost", () => {
    const { call, lines } = harness(null);
    call("osc_send", ["127.0.0.1", "10111"], "/a", []);
    call("osc_send", ["127.0.0.1", "10111"], "/b", []);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("127.0.0.1:10111");
    expect(lines[0]).toContain("osc-relay");
  });
});

describe("colour to grey", () => {
  it("uses norns' own integer weights, not a generic luma", () => {
    // `ssd1322.cc:291-293`: R*64 + G*160 + B*32, >> 8, then the top nibble.
    // Green is worth five times blue, which is why a blue-on-black PNG is
    // nearly invisible on the panel and has to be here too.
    expect(luma4(255, 255, 255)).toBe(15);
    expect(luma4(0, 0, 0)).toBe(0);
    expect(luma4(0, 255, 0)).toBe(((255 * 160) >> 8) >> 4);
    expect(luma4(0, 0, 255)).toBe(((255 * 32) >> 8) >> 4);
    expect(luma4(255, 0, 0)).toBe(((255 * 64) >> 8) >> 4);
  });

  it("is monotonic, so a gradient stays a gradient", () => {
    let last = -1;
    for (let v = 0; v <= 255; v += 1) {
      const g = luma4(v, v, v);
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
    expect(last).toBe(15);
  });
});
