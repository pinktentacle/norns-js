// E5-10 — crow and serial say what is wrong, once.

import { describe, expect, it } from "vitest";
import { registerSerial } from "../src/serial/register.js";
import { NornsRegistry } from "../src/norns/registry.js";

function wired() {
  const lines: string[] = [];
  const registry = new NornsRegistry();
  const stats = registerSerial(registry, { log: (l) => lines.push(l) });
  const call = (name: string, args: unknown[]): void => {
    registry.implementationFor(name)!(...(args as never[]));
  };
  return { call, lines, stats };
}

describe("crow and serial", () => {
  it("explains itself once and then counts", () => {
    const { call, lines, stats } = wired();
    for (let i = 0; i < 50; i++) call("crow_send", [1, "output[1].volts = 5"]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Web Serial");
    expect(stats.crowSends).toBe(50);
  });

  it("names a wrong argument type rather than blaming the missing device", () => {
    const { call, lines } = wired();
    call("crow_send", [1, 5]);
    expect(lines[0]).toContain("expected a string");
    expect(lines[0]).not.toContain("not attached");
  });

  it("keeps crow and serial separate, so each explains itself", () => {
    const { call, lines, stats } = wired();
    call("crow_send", [1, "x"]);
    call("serial_send", [1, "y"]);
    expect(lines.length).toBe(2);
    expect(stats).toEqual({ crowSends: 1, serialSends: 1 });
  });

  it("counts a malformed call too — it was still an attempt to send", () => {
    const { call, stats } = wired();
    call("serial_send", [1, 42]);
    expect(stats.serialSends).toBe(1);
  });
});
