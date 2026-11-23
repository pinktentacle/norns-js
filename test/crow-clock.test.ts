// E9-206 — crow as the clock source, against `clock/clock_crow.c`.
//
// norns has crow say `^^change(1,1)` on every rising edge at its first
// input, and matron turns the gaps into a tempo. Four pulses to a beat until
// `clock_crow_in_div` says otherwise; a running mean of four; and a gap of
// more than four seconds a beat is a clock that stopped, not a slow one.

import { describe, expect, it } from "vitest";
import { CROW_PULSE, CrowClockSource } from "../src/clock/crow-source.js";
import type { ClockReference } from "../src/clock/midi-source.js";
import { CLOCK_SOURCES, CLOCK_STUBS, registerClock } from "../src/clock/register.js";
import { NornsRegistry } from "../src/norns/registry.js";

function source() {
  const refs: ClockReference[] = [];
  const s = new CrowClockSource((r) => refs.push(r));
  return { s, refs };
}

describe("turning crow's pulses into a tempo", () => {
  it("draws nothing from the first pulse: there is no gap yet", () => {
    const { s, refs } = source();
    s.pulse(10);
    expect(refs).toEqual([]);
    expect(s.tempo).toBe(0);
  });

  it("reads four pulses a beat, as matron does until told otherwise", () => {
    const { s, refs } = source();
    // Sixteenth notes at 120: a pulse every eighth of a second.
    for (let i = 0; i <= 8; i++) s.pulse(10 + i * 0.125);
    expect(refs).toHaveLength(8);
    expect(refs.at(-1)!.beatDuration).toBeCloseTo(0.5, 9);
    expect(s.tempo).toBeCloseTo(120, 6);
    // Where the beat is, too: eight pulses in, two beats.
    expect(refs.at(-1)!.beat).toBe(2);
    expect(refs[0]!.beat).toBe(0.25);
  });

  it("takes eight pulses to settle, exactly as matron's does", () => {
    // NOT A MEAN UNTIL THE BUFFER HAS GONE ROUND. Each duration is scaled
    // by one over the number held WHEN IT WENT IN — 1, 1/2, 1/3, 1/4 — so
    // the sum overshoots while it fills and only comes right once those
    // first four have been pushed out. A norns following crow starts at
    // about half speed and is on tempo two beats later; so does this.
    // Reproduced rather than repaired: `midi-source.ts` carries the same
    // arithmetic from `clock_midi.c`.
    const { s, refs } = source();
    for (let i = 0; i <= 8; i++) s.pulse(i * 0.125);
    const over = refs.map((r) => +(r.beatDuration / 0.5).toFixed(4));
    expect(over).toEqual([1, 1.5, 1.8333, 2.0833, 1.3333, 1.0833, 1, 1]);
  });

  it("follows clock_crow_in_div", () => {
    const { s } = source();
    s.setDiv(2);
    for (let i = 0; i <= 8; i++) s.pulse(i * 0.25);
    expect(s.tempo).toBeCloseTo(120, 6);
    expect(s.beat).toBe(4);
    // A division of nothing is not taken.
    s.setDiv(0);
    s.pulse(2.25);
    expect(s.tempo).toBeCloseTo(120, 6);
  });

  it("smooths over the last four gaps and no more", () => {
    const { s } = source();
    let t = 0;
    s.pulse(t);
    // Uneven gaps whose mean is an eighth of a second, twice round so the
    // buffer has settled.
    for (const gap of [0.115, 0.135, 0.12, 0.13, 0.115, 0.135, 0.12, 0.13]) s.pulse((t += gap));
    expect(s.tempo).toBeCloseTo(120, 6);
    // Four gaps at a new tempo and the old ones are gone entirely.
    for (let i = 0; i < 4; i++) s.pulse((t += 0.25));
    expect(s.tempo).toBeCloseTo(60, 6);
  });

  it("takes a long silence for a clock that stopped, not for a slow one", () => {
    const { s, refs } = source();
    for (let i = 0; i <= 8; i++) s.pulse(i * 0.125);
    const before = refs.length;
    s.pulse(100); // more than four seconds a beat
    expect(refs).toHaveLength(before);
    expect(s.tempo).toBeCloseTo(120, 6);
    // And the next gap is measured from that pulse, not from before it.
    s.pulse(100.125);
    expect(refs.at(-1)!.beatDuration).toBeCloseTo(0.5, 9);
  });

  it("knows a pulse when it is in a line, and nothing else for one", () => {
    const { s, refs } = source();
    expect(CROW_PULSE).toBe("^^change(1,1)");
    expect(s.line("^^change(1,1)\n", 1)).toBe(true);
    expect(s.line("\r^^change(1,1)\n", 1.125)).toBe(true);
    expect(refs).toHaveLength(1);
    // The other input, a falling edge, and a stream are not the clock.
    for (const other of ["^^change(2,1)\n", "^^change(1,0)\n", "^^stream(1,2.5)\n", "hello\n"]) {
      expect(s.line(other, 2), other).toBe(false);
    }
    expect(refs).toHaveLength(1);
  });
});

describe("what the clock's own functions do with crow", () => {
  function wired() {
    const stubs: string[] = [];
    const sources: string[] = [];
    const divs: number[] = [];
    const registry = new NornsRegistry();
    registerClock(registry, null as never, {
      onStub: (name) => stubs.push(name),
      onSource: (s) => sources.push(s),
      onCrowDiv: (d) => divs.push(d),
    });
    const call = (name: string, ...args: unknown[]): unknown =>
      registry.implementationFor(name)!(...(args as never[]));
    return { call, stubs, sources, divs };
  }

  it("takes crow as a source now, and still refuses link", () => {
    const { call, stubs, sources } = wired();
    call("clock_set_source", CLOCK_SOURCES.indexOf("crow"));
    expect(sources).toEqual(["crow"]);
    expect(stubs).toEqual([]);
    call("clock_set_source", CLOCK_SOURCES.indexOf("link"));
    expect(sources).toEqual(["crow"]);
    expect(stubs).toEqual(["clock_set_source"]);
  });

  it("hands the division on rather than explaining why it cannot", () => {
    const { call, stubs, divs } = wired();
    call("clock_crow_in_div", 8);
    expect(divs).toEqual([8]);
    expect(stubs).toEqual([]);
    expect(Object.keys(CLOCK_STUBS)).not.toContain("clock_crow_in_div");
  });
});
