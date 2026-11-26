// E9-255 — the line at the top of the page while a script downloads.
// E9-262 — one short line, a bar and a way out.

import { describe, expect, it } from "vitest";
import { createScriptDownloads } from "../src/ui/script-downloads.js";

describe("what a script is downloading", () => {
  it("says nothing when nothing is running", () => {
    const d = createScriptDownloads(() => {});
    expect(d.view()).toBeNull();
    expect(d.running()).toBe(0);
  });

  it("names one download with how far it has got, and is told of every change", () => {
    let changes = 0;
    const d = createScriptDownloads(() => void changes++);
    const h = d.start("moonraker.zip");
    expect(d.view()).toEqual({ line: "downloading moonraker.zip", fraction: null, stoppable: false });
    h.progress(512, 2048);
    expect(d.view()).toMatchObject({ line: "downloading moonraker.zip — 25%", fraction: 0.25 });
    h.progress(3 * 1048576, 0);
    expect(d.view()!.line).toBe("downloading moonraker.zip — 3.0 MB");
    h.end(true);
    expect(d.view()).toBeNull();
    expect(changes).toBe(4);
  });

  it("counts files for a repository", () => {
    const d = createScriptDownloads(() => {});
    const a = d.start("kolor", "files");
    a.progress(120, 446);
    expect(d.view()!.line).toBe("downloading kolor — 120 of 446 files");
  });

  it("COUNTS many rather than listing them: pirate-radio's 278 were a wall of names", () => {
    const d = createScriptDownloads(() => {});
    const hs = Array.from({ length: 278 }, (_, i) => d.start(`${i.toString(16).padStart(32, "0")}.ogg`));
    for (const h of hs.slice(0, 12)) h.end(true);
    hs[12]!.progress(1, 2);
    const v = d.view()!;
    expect(v.line).toBe("downloading 278 files — 12 done");
    expect(v.line.length).toBeLessThan(40);
    expect(v.fraction).toBeCloseTo(12.5 / 278, 6);
  });

  it("stops what can be stopped, and calls that stopped, not failed", () => {
    const d = createScriptDownloads(() => {});
    const cancelled: string[] = [];
    const a = d.start("a.ogg", "bytes", () => cancelled.push("a"));
    const b = d.start("b.ogg", "bytes", () => cancelled.push("b"));
    const c = d.start("c.zip"); // unzipping: no way out
    expect(d.view()!.stoppable).toBe(true);
    d.stop();
    expect(cancelled).toEqual(["a", "b"]);
    expect(d.view()!.stoppable).toBe(false);
    // Each gives up its own way and says so with end(false) or drop().
    a.end(false);
    b.drop();
    c.end(true);
    expect(d.failed()).toEqual([]);
    expect(d.stopped()).toBe(2);
  });

  it("keeps what failed until the next batch starts", () => {
    const d = createScriptDownloads(() => {});
    const a = d.start("a.zip");
    const b = d.start("b.zip");
    a.end(false);
    b.end(true);
    expect(d.failed()).toEqual(["a.zip"]);
    d.start("c.zip");
    expect(d.failed()).toEqual([]);
  });

  it("ends once, whatever is called after", () => {
    const d = createScriptDownloads(() => {});
    const h = d.start("x");
    h.end(true);
    h.end(false);
    h.drop();
    h.progress(1, 2);
    expect(d.failed()).toEqual([]);
    expect(d.stopped()).toBe(0);
    expect(d.view()).toBeNull();
  });
});
