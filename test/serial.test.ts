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
    // E9-204: it used to say Web Serial "could carry it". It does now, so
    // the line says what to do.
    expect(lines[0]).toContain("crow is not attached");
    expect(lines[0]).toContain("usb");
    expect(stats.crowSends).toBe(50);
  });

  it("sends to the crow that is plugged in, and says nothing", () => {
    // E9-204. Asked at every send: a crow comes and goes while a script runs.
    const lines: string[] = [];
    const sent: string[] = [];
    let crow: { send(c: string): void } | null = { send: (c) => sent.push(c) };
    const registry = new NornsRegistry();
    registerSerial(registry, { log: (l) => lines.push(l), crow: () => crow });
    const send = (cmd: string): void => void registry.implementationFor("crow_send")!(0 as never, cmd as never);
    send("output[1].volts = 5");
    send("input[1].mode('stream', 0.1)");
    // matron's `dev_crow_send` adds the newline; here the link does.
    expect(sent).toEqual(["output[1].volts = 5", "input[1].mode('stream', 0.1)"]);
    expect(lines).toEqual([]);
    crow = null;
    send("output[1].volts = 0");
    expect(sent).toHaveLength(2);
    expect(lines[0]).toContain("crow is not attached");
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
