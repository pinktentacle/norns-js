// E9-240 — jack_connect / jack_disconnect move the cables into SuperCollider.

import { afterEach, describe, expect, it } from "vitest";
import { jackRoute } from "../src/crone/jack.js";
import { runShell, setJackGraph } from "../src/fs/shell.js";
import { Vfs } from "../src/fs/vfs.js";

function graph() {
  const moves: Array<[string, string, boolean]> = [];
  setJackGraph({
    has: (a, b) => jackRoute(a, b) !== null,
    set: (a, b, on) => void moves.push([a, b, on]),
  });
  return moves;
}

afterEach(() => setJackGraph(null));

describe("the ports", () => {
  it("names the four sources and the two inputs", () => {
    expect(jackRoute("crone:output_5", "SuperCollider:in_1")).toEqual({ source: 0, input: 0 });
    expect(jackRoute("crone:output_6", "SuperCollider:in_2")).toEqual({ source: 1, input: 1 });
    expect(jackRoute("softcut:output_1", "SuperCollider:in_1")).toEqual({ source: 2, input: 0 });
    expect(jackRoute("softcut:output_2", "SuperCollider:in_2")).toEqual({ source: 3, input: 1 });
    expect(jackRoute("SuperCollider:out_1", "crone:input_1")).toBeNull();
  });
});

describe("the shell", () => {
  it("runs splnkr's four-command line, in order", () => {
    const moves = graph();
    const r = runShell(
      new Vfs(),
      "jack_disconnect crone:output_5 SuperCollider:in_1; jack_disconnect crone:output_6 SuperCollider:in_2; jack_connect softcut:output_1 SuperCollider:in_1; jack_connect softcut:output_2 SuperCollider:in_2;",
    );
    expect(r.ok).toBe(true);
    expect(moves).toEqual([
      ["crone:output_5", "SuperCollider:in_1", false],
      ["crone:output_6", "SuperCollider:in_2", false],
      ["softcut:output_1", "SuperCollider:in_1", true],
      ["softcut:output_2", "SuperCollider:in_2", true],
    ]);
  });

  it("takes quoted ports, as Crone.finishBoot writes them", () => {
    const moves = graph();
    expect(runShell(new Vfs(), 'jack_connect "crone:output_5" "SuperCollider:in_1"').ok).toBe(true);
    expect(moves).toEqual([["crone:output_5", "SuperCollider:in_1", true]]);
  });

  it("refuses a line with a port it has no cable for, and moves nothing", () => {
    const moves = graph();
    const r = runShell(new Vfs(), "jack_connect softcut:output_1 SuperCollider:in_1 && jack_connect SuperCollider:out_1 softcut:input_1");
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/SuperCollider:out_1/);
    expect(moves).toEqual([]);
  });

  it("is refused as before when the page has no graph", () => {
    expect(runShell(new Vfs(), "jack_connect softcut:output_1 SuperCollider:in_1").ok).toBe(false);
  });
});
