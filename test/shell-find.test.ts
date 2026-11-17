// E9-49 — `find`, in the shapes the catalogue actually writes.
//
// Four scripts cannot see what this build HAS because they ask with `find`:
// `graintopia` and `rachim` enumerate Extensions with `-printf '%p!'`,
// `twins` with a `\( -iname … -o … \)` group, `amenbreak` with
// `-name X -prune -o -name Y -print`. `Fverb` and `AnalogTape` are compiled
// into this scsynth and E9-40 writes the files beside them; the listing came
// back empty all the same, and the scripts offered to download an ARM
// binary instead.
//
// Every line tested here was read off one of the 354 repositories.

import { beforeEach, describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";

const EXT = "/home/we/.local/share/SuperCollider/Extensions";
let vfs: Vfs;

beforeEach(() => {
  vfs = new Vfs();
  vfs.write(`${EXT}/PortedPlugins/Fverb.sc`, "Fverb : UGen {}\n");
  vfs.write(`${EXT}/PortedPlugins/Fverb_scsynth.so`, "marker\n");
  vfs.write(`${EXT}/PortedPlugins/AnalogTape.sc`, "AnalogTape : UGen {}\n");
  vfs.write(`${EXT}/PortedPlugins/AnalogTape_scsynth.so`, "marker\n");
  vfs.write(`${EXT}/ignore/Should_Not_Appear.so`, "marker\n");
  vfs.write("/home/we/dust/audio/kit/a.wav", "x");
  vfs.write("/home/we/dust/audio/kit/b.flac", "x");
  vfs.write("/home/we/dust/audio/kit/notes.txt", "x");
  vfs.write("/home/we/dust/audio/.hidden/c.wav", "x");
});

describe("find, as the catalogue writes it", () => {
  it("enumerates with -printf, which is how graintopia asks for Fverb", () => {
    // scinstaller.lua: find %s -type f -printf '%p!'
    const r = runShell(vfs, `find ${EXT} -type f -printf '%p!'`);
    expect(r.ok, r.refused).toBe(true);
    expect(r.out).toContain("PortedPlugins/Fverb_scsynth.so!");
    expect(r.out).toContain("PortedPlugins/Fverb.sc!");
    // The separator is the point: the caller splits on it.
    expect(r.out.split("!").filter((s) => s !== "").length).toBe(5);
  });

  it("answers amenbreak's -prune -o -name … -print", () => {
    const r = runShell(
      vfs,
      `find ${EXT}/ -name ignore -prune -o -name AnalogTape_scsynth.so -print`,
    );
    expect(r.ok, r.refused).toBe(true);
    expect(r.out.trim()).toBe(`${EXT}/PortedPlugins/AnalogTape_scsynth.so`);
  });

  it("prunes the directory it was told to prune", () => {
    const r = runShell(vfs, `find ${EXT}/ -name ignore -prune -o -name '*.so' -print`);
    expect(r.out).not.toContain("Should_Not_Appear");
  });

  it("takes twins' -not -path and its \\( -iname … -o … \\) group", () => {
    const r = runShell(
      vfs,
      `find '/home/we/dust/audio' -type f -not -path '*/.*' \\( -iname '*.wav' -o -iname '*.flac' \\)`,
    );
    expect(r.ok, r.refused).toBe(true);
    expect(r.out).toContain("kit/a.wav");
    expect(r.out).toContain("kit/b.flac");
    expect(r.out).not.toContain("notes.txt");
    expect(r.out, "-not -path '*/.*'").not.toContain(".hidden");
  });

  it("honours -maxdepth and -type d, which zxcvbn uses", () => {
    const r = runShell(vfs, "find /home/we/dust/audio -maxdepth 1 -type d");
    expect(r.ok, r.refused).toBe(true);
    const got = r.out.trim().split("\n").sort();
    expect(got).toEqual(["/home/we/dust/audio", "/home/we/dust/audio/.hidden", "/home/we/dust/audio/kit"]);
  });

  it("pipes into sort, grep and tail, and redirects into a file", () => {
    // amenbreak/lib/utils.lua, verbatim in shape:
    //   find <dir>* -print -type f -name '*.flac' | grep 'wav\|flac' > /tmp/foo
    const r = runShell(
      vfs,
      "find /home/we/dust/audio/kit* -print -type f -name '*.flac' | grep 'wav\\|flac' > /tmp/foo",
    );
    expect(r.ok, r.refused).toBe(true);
    const written = new TextDecoder().decode(vfs.read("/tmp/foo")!);
    expect(written.trim()).toBe("/home/we/dust/audio/kit/b.flac");
  });

  it("appends with >>, because that is the second half of the same function", () => {
    runShell(vfs, "find /home/we/dust/audio/kit -type f -name '*.flac' > /tmp/foo");
    runShell(vfs, "find /home/we/dust/audio/kit -type f -name '*.wav' >> /tmp/foo");
    const written = new TextDecoder().decode(vfs.read("/tmp/foo")!);
    expect(written.trim().split("\n").sort()).toEqual([
      "/home/we/dust/audio/kit/a.wav",
      "/home/we/dust/audio/kit/b.flac",
    ]);
  });

  it("REFUSES a form it does not know, rather than answering nothing", () => {
    // The whole reason this file exists: an empty listing is
    // indistinguishable from an empty directory, and that is how four
    // scripts came to believe a compiled-in UGen was missing.
    const r = runShell(vfs, `find ${EXT} -newer /tmp/x -print`);
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/not a form this shell knows/);
  });

  it("leaves SELECT's own line to the hand-checked branch", () => {
    vfs.write("/home/we/dust/code/thing/thing.lua", "-- x");
    vfs.write("/home/we/dust/code/thing/lib/helper.lua", "-- x");
    const r = runShell(
      vfs,
      'find ~/dust/code/ -mindepth 2 -name .git -prune -o -type f -name "*.lua" -printf "%P\\n"',
    );
    expect(r.ok).toBe(true);
    expect(r.out).toContain("thing/thing.lua");
  });
});
