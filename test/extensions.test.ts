// E9-33 — the Extensions tree, and the writes into it that are refused.
//
// Thirteen catalogue scripts decide whether a UGen is available by looking
// for a file. The directory is written at boot from what the server itself
// reports, so a file appears exactly when the capability does — and after
// that nothing may write there, because no file a script copies in can
// make a UGen exist.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";
import { declareExtensions, insideExtensions } from "../src/community/extensions.js";

const EXT = "/home/we/.local/share/SuperCollider/Extensions";

/** A build that has the mi-UGens and two sc3 classes. */
const served = (ugens: string[]): {
  fetchJson: (u: string) => Promise<unknown>;
  fetchText: (u: string) => Promise<string | null>;
} => ({
  fetchJson: async (u) => {
    if (u.endsWith("ugens.json")) return ugens;
    if (u.endsWith("sc3/index.json")) return ["MdaUGens.sc", "TJUGens.sc"];
    if (u.endsWith("ported/index.json")) return ["AnalogTape.sc", "ZOsc.sc"];
    throw new Error(`404 ${u}`);
  },
  fetchText: async (u) => {
    if (u.endsWith("/MiClouds.sc")) return "MiClouds : MultiOutUGen {}\n";
    if (u.endsWith("/MiRings.sc")) return "MiRings : MultiOutUGen {}\n";
    if (u.endsWith("/MdaUGens.sc")) return "MdaPiano : MultiOutUGen {}\n";
    if (u.endsWith("/TJUGens.sc")) return "DFM1 : UGen {}\n";
    if (u.endsWith("/PulsePTR.sc")) return "PulsePTR : UGen {}\n";
    if (u.endsWith("/ByteBeat.sc")) return "ByteBeat : UGen {}\n";
    if (u.endsWith("/ByteBeatController.sc")) return "ByteBeatController {}\n";
    if (u.endsWith("/AnalogTape.sc")) return "AnalogTape : UGen {}\n";
    if (u.endsWith("/ZOsc.sc")) return "ZOsc : UGen {}\n";
    if (u.endsWith("/mi/BUILDINFO")) {
      return "# a note\nname: mi-UGens\nprs: 24 — MiBeads\nbuilt: 2026-11-13T16:25:24Z\n";
    }
    return null;
  },
});

describe("declaring what the server has", () => {
  it("writes the package a script looks for, when the UGen is really there", async () => {
    // pedalboard's test, verbatim: it wants all three of .cpp, .sc and .so.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["MiClouds", "MiRings", "SinOsc"]));
    for (const f of ["MiClouds.sc", "MiClouds.so", "MiClouds.cpp"]) {
      expect(vfs.exists(`${EXT}/MiClouds/${f}`), f).toBe(true);
    }
    expect(vfs.exists(`${EXT}/MiRings/MiRings.so`)).toBe(true);
  });

  it("says nothing about a UGen the server does not report", async () => {
    // The twelve that ask about PortedPlugins, ByteBeat and the *PTR
    // oscillators find nothing, which is the right answer.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["MiClouds"]));
    expect(vfs.exists(`${EXT}/MiRings/MiRings.sc`), "not in the report").toBe(false);
    expect(vfs.exists(`${EXT}/PulsePTR/PulsePTR.sc`)).toBe(false);
    expect(vfs.exists(`${EXT}/TrianglePTR/TrianglePTR.sc`)).toBe(false);
  });

  it("puts the sc3 classes where a find can reach them", async () => {
    // twins and amenbreak ask with `find … -name 'AnalogChew.sc'`, so depth
    // does not matter — only that the file is under Extensions.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["MdaPiano"]));
    expect(vfs.exists(`${EXT}/supercollider-plugins/MdaUGens.sc`)).toBe(true);
    const hit = runShell(vfs, `ls ${EXT}/supercollider-plugins`);
    expect(hit.out).toContain("MdaUGens.sc");
  });

  it("writes ByteBeat where bitebeet looks, doubled directory and all", async () => {
    // lib/install.lua opens all three or offers to download an ARM .so.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["ByteBeat"]));
    const home = `${EXT}/ByteBeat/ByteBeat`;
    expect(vfs.exists(`${home}/ByteBeat_scsynth.so`)).toBe(true);
    expect(vfs.exists(`${home}/Classes/ByteBeat.sc`)).toBe(true);
    expect(vfs.exists(`${home}/Classes/ByteBeatController.sc`)).toBe(true);
  });

  it("writes a PTR oscillator the way bitters tests for it", async () => {
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["PulsePTR"]));
    expect(vfs.exists(`${EXT}/PulsePTR/PulsePTR.sc`)).toBe(true);
  });

  it("writes a PortedPlugins class only when the server reports it", async () => {
    // Thirteen of that pack need daisysp or Eigen and are not compiled
    // in. A file for one of those would be the lie this module avoids.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["AnalogTape"]));
    expect(vfs.exists(`${EXT}/PortedPlugins/AnalogTape.sc`)).toBe(true);
    expect(vfs.exists(`${EXT}/PortedPlugins/AnalogTape_scsynth.so`)).toBe(true);
    expect(vfs.exists(`${EXT}/PortedPlugins/ZOsc.sc`), "not reported").toBe(false);
  });

  it("claims nothing at all when there is no report to read", async () => {
    const vfs = new Vfs();
    const n = await declareExtensions(vfs, {
      fetchJson: async () => {
        throw new Error("404");
      },
      fetchText: async () => null,
    });
    expect(n).toBe(0);
    expect(vfs.isDir(EXT)).toBe(false);
  });

  it("can be run twice without doubling anything", async () => {
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["MiClouds"]));
    const first = vfs.walk(EXT).length;
    await declareExtensions(vfs, served(["MiClouds"]));
    expect(vfs.walk(EXT).length).toBe(first);
  });
});

describe("nothing writes into Extensions", () => {
  // MEASURED on `bitters`, which is why this exists. It copies its bundled
  // PulsePTR.sc and TrianglePTR.sc in, and decides `engine.name` from
  // whether they are there — at LOAD, before init does the copying. So the
  // first run is Engine_None and the second is
  //   loading engine: Bitters
  //   ### SCRIPT ERROR: missing Bitters
  //   ### try 'SYSTEM > RESTART'
  // a restart that can never help: the .so beside the class was skipped by
  // the installer and the UGen is in no binary.
  it("refuses a cp into it", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/bitters/ignore/PulsePTR.sc", "x");
    const r = runShell(vfs, `cp /home/we/dust/code/bitters/ignore/PulsePTR.sc ${EXT}/PulsePTR/PulsePTR.sc`);
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/compiled in/);
    expect(vfs.exists(`${EXT}/PulsePTR/PulsePTR.sc`)).toBe(false);
  });

  it("refuses the mkdir that comes before it", () => {
    const vfs = new Vfs();
    expect(runShell(vfs, `mkdir -p ${EXT}/FormantTriPTR`).ok).toBe(false);
    expect(vfs.isDir(`${EXT}/FormantTriPTR`)).toBe(false);
  });

  it("refuses rm, mv, touch and echo too", () => {
    const vfs = new Vfs();
    expect(runShell(vfs, `rm -rf ${EXT}/supercollider-plugins`).ok).toBe(false);
    expect(runShell(vfs, `mv /tmp/a ${EXT}/a`).ok).toBe(false);
    expect(runShell(vfs, `touch ${EXT}/marker`).ok).toBe(false);
    expect(runShell(vfs, `echo hi > ${EXT}/marker`).ok).toBe(false);
  });

  it("leaves reading alone", async () => {
    // The point is that the scripts' QUESTION still works. Only writing is
    // refused.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["MiClouds"]));
    expect(runShell(vfs, `ls ${EXT}/MiClouds`).ok).toBe(true);
    expect(runShell(vfs, `cat ${EXT}/MiClouds/MiClouds.sc`).out).toContain("MiClouds");
  });

  it("does not refuse a path that merely looks like it", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/x/Extensions-notes.md", "x");
    expect(runShell(vfs, "touch /home/we/dust/code/x/Extensions-notes.md").ok).toBe(true);
  });

  it("knows what is inside and what is not", () => {
    expect(insideExtensions(`${EXT}/MiClouds/MiClouds.sc`)).toBe(true);
    expect(insideExtensions("/usr/local/share/SuperCollider/Extensions")).toBe(true);
    expect(insideExtensions("/home/we/dust/code/amen/amen.lua")).toBe(false);
  });
});

describe("the directory is authoritative, not additive", () => {
  it("removes a class a script left there in an earlier session", async () => {
    // bitters writes its bundled PulsePTR.sc in and OPFS keeps it. The next
    // boot would find a class whose UGen is in no binary, and the script
    // would ask for an engine that cannot load.
    const vfs = new Vfs();
    vfs.write(`${EXT}/PulsePTR/PulsePTR.sc`, "PulsePTR : UGen {}\n");
    vfs.write(`${EXT}/TrianglePTR/TrianglePTR.sc`, "TrianglePTR : UGen {}\n");
    await declareExtensions(vfs, served(["MiClouds"]));
    expect(vfs.exists(`${EXT}/PulsePTR/PulsePTR.sc`)).toBe(false);
    expect(vfs.exists(`${EXT}/TrianglePTR/TrianglePTR.sc`)).toBe(false);
    expect(vfs.exists(`${EXT}/MiClouds/MiClouds.sc`), "and what is true stays").toBe(true);
  });

  it("leaves the rest of the filesystem alone", async () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/bitters/ignore/PulsePTR.sc", "keep");
    await declareExtensions(vfs, served(["MiClouds"]));
    expect(vfs.exists("/home/we/dust/code/bitters/ignore/PulsePTR.sc")).toBe(true);
  });
});

// E9-57 — the set says what it is, for a script that asks rather than looks.
describe("the mi-UGens BUILDINFO", () => {
  it("is written when the server reports the set", async () => {
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["MiClouds", "MiRings"]));
    const info = vfs.readText(`${EXT}/mi-UGens/BUILDINFO`);
    expect(info).not.toBeNull();
    // terrarium/lib/needs.lua reads exactly these two things.
    expect(info).toMatch(/\nprs:[^\n]*24/);
    expect(info).toMatch(/\nbuilt:\s*\S+/);
  });

  it("answers terrarium's own test", () => {
    // ours() in lib/needs.lua, transcribed:
    //   info:match("\nprs:[^\n]*%f[%d]24%f[%D]") ~= nil
    //     and built ~= nil and built >= BUILT
    const info = "# a note\nname: mi-UGens\nprs: 24 — MiBeads\nbuilt: 2026-11-13T16:25:24Z\n";
    const prs = /\nprs:[^\n]*(?<![0-9])24(?![0-9])/.test(info);
    const built = /\nbuilt:\s*(\S+)/.exec(info)?.[1] ?? null;
    expect(prs).toBe(true);
    expect(built).not.toBeNull();
    expect(built! >= "2026-10-22T16:38:29Z").toBe(true);
  });

  it("is NOT written when the server has no mi-UGens", async () => {
    // The rule this whole module exists for: a file appears exactly when
    // the capability does.
    const vfs = new Vfs();
    await declareExtensions(vfs, served(["SinOsc"]));
    expect(vfs.read(`${EXT}/mi-UGens/BUILDINFO`)).toBeNull();
  });
});

// E9-141 — the boot does not wait for them one at a time.
//
// Found by the timestamps E9-130 added, in the first log that had them:
// eleven seconds on a phone between the storage line and `extensions:
// … declared`, with nothing but this function between the two. The
// requests are independent static files and nothing between them depends
// on the one before. E9-106 made this same change for the dust tree.
//
// The test is about CONCURRENCY, not speed: it holds every request open
// until all of them have arrived, which can only finish if they were in
// flight together.
describe("the extension sources are fetched together", () => {
  it("has them all in flight at once, not one after another", async () => {
    let open = 0;
    let highWater = 0;
    const vfs = new Vfs();
    await declareExtensions(vfs, {
      fetchJson: async () => ["MiClouds", "MiRings", "MiElements"],
      fetchText: async (u: string) => {
        if (!u.endsWith(".sc")) return null;
        open++;
        highWater = Math.max(highWater, open);
        // A real pause, so a serial loop would finish this one before
        // starting the next and never see two open at a time.
        await new Promise((r) => setTimeout(r, 15));
        open--;
        const name = u.split("/").pop()!.replace(".sc", "");
        return `${name} : UGen {}
`;
      },
    });
    expect(highWater, "the sources were fetched one at a time").toBeGreaterThan(1);
  });
});
