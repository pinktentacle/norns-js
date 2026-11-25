// Two sclang overrides whose claims can be checked without a server.
//
// E9-215 — `DiodeRingMod` rebuilt from core UGens. The .sc file uses a
// branch-free form of the C++ diode curve; the identity is checked here,
// over the whole range a signal can take, against the curve as
// `DiodeRingMod.cpp` writes it.
//
// E9-218 — `/b_write` kills this scsynth, so `writeMsg` must never build
// one.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(__dirname, "..", "src", "engine", "sc-overrides", "SystemOverwrites");
const code = (file: string): string =>
  fs
    .readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("DiodeRingMod, as core UGens", () => {
  // DiodeRingMod.cpp: v_b = 0.2, v_l = 0.6, h = 1.
  const vb = 0.2;
  const vl = 0.6;
  const h = 1;
  const curve = h / (2 * (vl - vb));
  const lin = curve * (vl - vb) ** 2 - h * vl;
  const upstream = (x: number): number => (x > vl ? h * x + lin : x > vb ? curve * (x - vb) ** 2 : 0);
  // The form NornsJsDiodeRingMod.sc builds.
  const ours = (x: number): number => 1.25 * (Math.min(Math.max(x, 0.2), 0.6) - 0.2) ** 2 + Math.max(x - 0.6, 0);
  const ring = (d: (x: number) => number, car: number, mod: number): number => {
    const in1 = car + 0.5 * mod;
    const in2 = car - 0.5 * mod;
    return d(in1) + d(-in1) - d(in2) - d(-in2);
  };

  it("is the same curve", () => {
    for (let x = -4; x <= 4; x += 0.001) expect(ours(x)).toBeCloseTo(upstream(x), 9);
  });

  it("is the same ring modulator", () => {
    for (let c = -2; c <= 2; c += 0.05) {
      for (let m = -2; m <= 2; m += 0.05) expect(ring(ours, c, m)).toBeCloseTo(ring(upstream, c, m), 9);
    }
  });

  it("is written that way in the class", () => {
    const sc = code("NornsJsDiodeRingMod.sc");
    expect(sc).toMatch(/1\.25 \* \(x\.clip\(0\.2, 0\.6\) - 0\.2\)\.squared\) \+ \(x - 0\.6\)\.max\(0\)/);
    expect(sc).toMatch(/c \+ \(0\.5 \* m\), in2 = c - \(0\.5 \* m\)/);
  });
});

describe("a buffer write", () => {
  it("never builds a /b_write for the server", () => {
    const sc = code("NornsJsBufferWriteOverride.sc");
    expect(sc).toMatch(/writeMsg \{/);
    expect(sc, "a /b_write would stop the server").not.toContain('"/b_write"');
    expect(sc).toContain('^["/b_query", bufnum]');
  });

  it("says that it did not write", () => {
    expect(code("NornsJsBufferWriteOverride.sc")).toMatch(/NOT writing buffer/);
  });
});

describe("a folder listed from sclang (E9-232)", () => {
  const sc = code("NornsJsPathMatchOverride.sc");
  it("asks the real filesystem first, and only fills an empty answer", () => {
    expect(sc).toMatch(/pathMatch \{\s*var real = this\.nornsJsPathMatchReal;\s*if \(real\.notEmpty\) \{ \^real \};/);
    expect(sc).toMatch(/nornsJsPathMatchReal \{\s*_StringPathMatch/);
  });
  it("answers only about the dust tree, from the sound-file table", () => {
    expect(sc).toMatch(/tidy\.beginsWith\("\/home\/we\/dust\/"\)\.not\) \{ \^nil \}/);
    expect(sc).toMatch(/SoundFile\.nornsJsTable/);
  });
});

describe("the sound-file table during a session (E9-234)", () => {
  const sc = code("NornsJsSoundFileOverride.sc");
  it("is read again when the host's generation moves", () => {
    expect(sc).toMatch(/var genPath = "\/sc\/soundfiles\.gen";/);
    expect(sc).toMatch(/if \(table\.notNil and: \{ gen == Library\.at\(\\nornsJs, \\soundFilesGen\) \}\) \{ \^table \};/);
    expect(sc).toMatch(/Library\.put\(\\nornsJs, \\soundFilesGen, gen\);/);
  });
  it("is kept up by the page on every .wav written or removed", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
    expect(main).toMatch(/vfs\.watch\(\(path\) => \{\s*if \(!SOUND_FILE\.test\(path\)\) return;/);
    expect(main).toMatch(/const SOUND_FILE = \/\\\.\(wav\|flac\|aiff\?\)\$\/i;/);
    expect(main).toMatch(/scEngine\?\.soundFilesChanged\(\);/);
  });
});

describe("a buffer loaded by its own method (E9-237)", () => {
  const sc = code("NornsJsBufferOverride.sc");
  it("takes allocRead, allocReadChannel, read and readChannel through the page, as *read", () => {
    for (const m of ["allocRead", "allocReadChannel", "read", "readChannel"]) {
      const at = sc.indexOf(`\n\t${m} { arg argpath,`);
      expect(at, m).toBeGreaterThan(0);
      const body = sc.slice(at, sc.indexOf("\n\t}", at));
      expect(body, m).toContain("Buffer.nornsJsRequest(this, argpath");
    }
  });
});

describe("Ableton Link's clock, without Link", () => {
  const sc = code("NornsJsLinkClockOverride.sc");
  const upstream = fs.readFileSync(
    path.join(__dirname, "..", "third_party", "supercollider", "SCClassLibrary", "External", "Ableton", "LinkClock.sc"),
    "utf8",
  );
  it("replaces every method that calls a Link primitive, and calls none itself", () => {
    const linked = [...upstream.matchAll(/\n\t(\w+_?) \{[^}]*?_LinkClock_\w+/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThanOrEqual(9);
    for (const m of linked) expect(sc, m).toMatch(new RegExp(`\n\t${m} \{`));
    expect(sc).not.toMatch(/_LinkClock_/);
    expect(sc).toMatch(/prStart \{ \|tempo, beats, seconds\|\s*_TempoClock_New/);
  });
});

describe("an engine that fails to free", () => {
  const sc = code("NornsJsEngineLoadGuard.sc");
  it("still tells Crone it is gone, so the next engine loads", () => {
    const body = sc.slice(sc.indexOf("\tdeinit { arg doneCallback;"));
    expect(body).toMatch(/try \{\s*this\.free;\s*\} \{ arg error;/);
    expect(body.lastIndexOf("doneCallback.value(this)")).toBeGreaterThan(body.indexOf("try {"));
  });

  it("frees once when Crone asks twice, and answers the second after the first", () => {
    const body = sc.slice(sc.indexOf("\tdeinit { arg doneCallback;"));
    expect(body).toMatch(/if \(waiting == \\done\) \{ doneCallback\.value\(this\) \} \{ waiting\.add\(doneCallback\) \};\s*\^this/);
    const sync = body.indexOf("Crone.server.sync;");
    expect(body.indexOf("Library.put(\\nornsJs, \\engineFree, this, \\done);")).toBeGreaterThan(sync);
    expect(body.indexOf("waiting.do({ arg cb; cb.value(this) });")).toBeGreaterThan(body.lastIndexOf("doneCallback.value(this);"));
  });
});
