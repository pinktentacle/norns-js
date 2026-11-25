// E9-248 — `nice` wraps a command; grains lists its samples through it.

import { describe, expect, it } from "vitest";
import { runShell } from "../src/fs/shell.js";
import { Vfs } from "../src/fs/vfs.js";

const tree = (): Vfs => {
  const vfs = new Vfs();
  for (const p of ["a/one.wav", "a/two.WAV", "b/c/three.flac", ".hidden/x.wav", "notes.txt"]) {
    vfs.write(`/home/we/dust/audio/${p}`, new Uint8Array([1]));
  }
  return vfs;
};

describe("nice", () => {
  it("runs what it wraps", () => {
    const vfs = tree();
    const r = runShell(vfs, "nice -n 10 find '/home/we/dust/audio/' -mindepth 1 -maxdepth 2 -type f -iname '*.wav'");
    expect(r.ok).toBe(true);
    // No -prune here, so the hidden folder is searched too, as by find(1).
    expect(r.out.trim().split("\n").sort()).toEqual([
      "/home/we/dust/audio/.hidden/x.wav",
      "/home/we/dust/audio/a/one.wav",
      "/home/we/dust/audio/a/two.WAV",
    ]);
  });

  it("runs grains' whole line, the list into its file", () => {
    const vfs = tree();
    const d = "'/home/we/dust/audio/'";
    const line =
      `nice -n 10 find ${d} -mindepth 1 -maxdepth 3 -name '.*' -prune -o -type f \( -iname '*.wav' -o -iname '*.aif' -o -iname '*.aiff' -o -iname '*.flac' -o -iname '*.ogg' \) -print 2>/dev/null | head -n 2000 > /tmp/grains_files.txt; ` +
      `find ${d} -mindepth 3 -maxdepth 3 -type d -not -path '*/.*' -print -quit 2>/dev/null | wc -l; echo _done_`;
    const r = runShell(vfs, line);
    expect(r.ok, r.refused).toBe(true);
    const list = new TextDecoder().decode(vfs.read("/tmp/grains_files.txt") ?? new Uint8Array()).trim().split("\n").sort();
    expect(list).toEqual([
      "/home/we/dust/audio/a/one.wav",
      "/home/we/dust/audio/a/two.WAV",
      "/home/we/dust/audio/b/c/three.flac",
    ]);
    expect(r.out).toMatch(/_done_/);
  });

  it("stops find at the first match with -quit", () => {
    const r = runShell(tree(), "find /home/we/dust/audio -mindepth 1 -type d -not -path '*/.*' -print -quit");
    expect(r.ok).toBe(true);
    expect(r.out).toBe("/home/we/dust/audio/a\n");
  });

  it("and nothing else starting with the word", () => {
    expect(runShell(new Vfs(), "nicely done").ok).toBe(false);
  });
});
