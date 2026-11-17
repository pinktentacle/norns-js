// E4 — the two places the engine layer fails silently.
//
// The wasm half is not tested here: it was verified in a browser end to end
// (sclang compiled, scsynth at 48 kHz, Crone booted, `/crone/ready` fired the
// gate, 5 engines and 8 polls reported, and PolyPerc took silence 0.00000 to
// 0.03693 RMS). What a test CAN hold on to is the argument coercion and the
// report shapes, because both produce wrong behaviour rather than an error —
// one inside SuperCollider, far from the cause, and the other as a Lua
// message that names neither the callback nor the missing argument.
//
// `host` is a stand-in with a `sclang.sendOsc` that records. The subject is
// the coercion, not the module.

import { describe, expect, it, vi } from "vitest";
import { registerEngine } from "../src/engine/register.js";
import { NornsRegistry } from "../src/norns/registry.js";
import { decode } from "../src/engine/osc.js";
import type { EngineHost } from "../src/engine/host.js";
import type { Callbacks } from "../src/norns/callbacks.js";

function harness() {
  const sent: Array<{ address: string; args: unknown[] }> = [];
  const host = {
    sclang: {
      sendOsc: (b: Uint8Array) => {
        const m = decode(b) as { address: string; args: unknown[] };
        sent.push({ address: m.address, args: m.args });
      },
    },
  } as unknown as EngineHost;

  const calls: Array<{ name: string; args: unknown[] }> = [];
  const cb = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        (...args: unknown[]) => {
          calls.push({ name, args });
          return null;
        },
    },
  ) as unknown as Callbacks;

  const registry = new NornsRegistry();
  const logs: string[] = [];
  const state = registerEngine(registry, host, { callbacks: cb, log: (l) => logs.push(l) });
  const call = (name: string, ...args: unknown[]): unknown =>
    registry.implementationFor(name)!(...(args as never[]));
  return { sent, calls, logs, state, call };
}

describe("send_command coerces by the STORED format", () => {
  function withCommands(h: ReturnType<typeof harness>): void {
    h.state.onMatron("/report/commands/start", []);
    h.state.onMatron("/report/commands/entry", [0, "hz", "f"]);
    h.state.onMatron("/report/commands/entry", [1, "note", "if"]);
    h.state.onMatron("/report/commands/entry", [2, "name", "s"]);
    h.state.onMatron("/report/commands/end", []);
  }

  it("sends ints as ints and floats as floats", () => {
    // p1-api-plan §4.8: forwarding arguments without consulting the format
    // sends a float where the engine expects an int, and the failure appears
    // inside SuperCollider rather than here.
    const h = harness();
    withCommands(h);
    h.call("send_command", 2, 60.7, 0.5);
    const msg = h.sent.at(-1)!;
    expect(msg.address).toBe("/command/note");
    expect(msg.args[0]).toBe(60); // truncated, because the format says `i`
    expect(msg.args[1]).toBeCloseTo(0.5, 6);
  });

  it("sends strings as strings", () => {
    const h = harness();
    withCommands(h);
    h.call("send_command", 3, 42);
    expect(h.sent.at(-1)!.args[0]).toBe("42");
  });

  it("the index is 1-based, as it is from Lua", () => {
    const h = harness();
    withCommands(h);
    h.call("send_command", 1, 440);
    expect(h.sent.at(-1)!.address).toBe("/command/hz");
  });

  it("refuses an unknown index rather than sending somewhere", () => {
    const h = harness();
    withCommands(h);
    h.call("send_command", 99, 1);
    expect(h.sent).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("no command at index 99"))).toBe(true);
  });

  it("refuses more arguments than the format describes", () => {
    const h = harness();
    withCommands(h);
    h.call("send_command", 1, 440, 999);
    expect(h.sent).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('format "f"'))).toBe(true);
  });

  it("publishes the command table whole, never half-built", () => {
    // An index into a partially filled table addresses the wrong command.
    const h = harness();
    h.state.onMatron("/report/commands/start", []);
    h.state.onMatron("/report/commands/entry", [0, "hz", "f"]);
    expect(h.state.commands).toHaveLength(0);
    h.state.onMatron("/report/commands/end", []);
    expect(h.state.commands).toHaveLength(1);
  });
});

describe("the reports are accumulated whole and handed on", () => {
  // What SHAPE they reach Lua in is `makeCallbacks`' job and is asserted in
  // test/callbacks.test.ts against a real Lua state. Here the question is
  // only whether this layer collects them correctly.
  it("engines", () => {
    const h = harness();
    h.state.onMatron("/report/engines/start", []);
    h.state.onMatron("/report/engines/entry", [0, "PolyPerc"]);
    h.state.onMatron("/report/engines/entry", [1, "TestSine"]);
    h.state.onMatron("/report/engines/end", []);
    expect(h.state.engines).toEqual(["PolyPerc", "TestSine"]);
    expect(h.calls.find((x) => x.name === "reportEngines")!.args[0]).toEqual([
      "PolyPerc",
      "TestSine",
    ]);
  });

  it("polls, with the id 1-based as every id that crosses this boundary is", () => {
    const h = harness();
    h.state.onMatron("/report/polls/start", []);
    h.state.onMatron("/report/polls/entry", [0, "amp_in_l", 0]);
    h.state.onMatron("/report/polls/entry", [1, "pitch_in_l", 1]);
    h.state.onMatron("/report/polls/end", []);
    expect(h.state.polls).toEqual([
      { id: 1, name: "amp_in_l", isData: false },
      { id: 2, name: "pitch_in_l", isData: true },
    ]);
  });

  it("commands, keeping the format string each carries", () => {
    const h = harness();
    h.state.onMatron("/report/commands/start", []);
    h.state.onMatron("/report/commands/entry", [0, "hz", "f"]);
    h.state.onMatron("/report/commands/end", []);
    expect(h.state.commands).toEqual([{ name: "hz", format: "f" }]);
  });
});

describe("the boot gate", () => {
  it("fires once, and only on /crone/ready", () => {
    const h = harness();
    expect(h.state.ready).toBe(false);
    h.state.onMatron("/crone/ready", []);
    h.state.onMatron("/crone/ready", []);
    expect(h.state.ready).toBe(true);
    expect(h.calls.filter((c) => c.name === "startupOk")).toHaveLength(1);
  });

  it("gives up after the deadline and says so, as matron does", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.state.queryStartup(100, 10);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.calls.some((c) => c.name === "startupTimeout")).toBe(true);
      expect(h.logs.some((l) => l.includes("did not arrive"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the virtual port graph", () => {
  it("records a connection and reports it back", () => {
    // core/audio.lua tracks these across SuperCollider restarts; empty lists
    // forever would make norns believe every connection failed.
    const h = harness();
    expect(h.call("audio_connect", "a", "b")).toEqual([true]);
    expect(h.call("audio_get_port_connections", "a")).toEqual([["b"]]);
    expect(h.call("audio_disconnect", "a", "b")).toEqual([true]);
    expect(h.call("audio_get_port_connections", "a")).toEqual([[]]);
  });
});
