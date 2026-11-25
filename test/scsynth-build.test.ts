// E9-242 — two ways scsynth, as norns-js builds it, differed from a norns.
//
// A SynthDef the server refused killed it: `GraphDef_Recv` catches the throw
// upstream, but without -fexceptions the catch is dropped and the thread that
// handles /d_recv dies — no SynthDef and no /sync for the rest of the session.
//
// And core UGens were missing: plugin groups compiled and linked but never
// registered in the static table (Convolution, Onsets, BeatTrack...).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SC = path.join(__dirname, "..", "third_party", "supercollider");
const read = (p: string): string => fs.readFileSync(path.join(SC, p), "utf8").replace(/\r\n/g, "\n");

describe("a SynthDef the server refuses", () => {
  it("is caught where upstream catches it", () => {
    expect(read("server/scsynth/SC_GraphDef.cpp")).toMatch(
      /GraphDef\* GraphDef_Recv\([^)]*\) \{\s*try \{\s*inList = GraphDefLib_Read/,
    );
    expect(read("server/scsynth/CMakeLists.txt")).toMatch(
      /set_source_files_properties\(SC_GraphDef\.cpp PROPERTIES COMPILE_OPTIONS -fexceptions\)/,
    );
  });

  it("and a file the server cannot read answers /fail (E9-247)", () => {
    expect(read("server/scsynth/SC_SequencedCommand.cpp")).toMatch(
      /bool LoadSynthDefDirCmd::Stage2\(\) \{\s*try \{[\s\S]*?\} catch \(const std::exception& e\) \{\s*SendFailure\("\/d_loadDir"/,
    );
    expect(read("server/scsynth/CMakeLists.txt")).toMatch(
      /set_source_files_properties\(SC_SequencedCommand\.cpp PROPERTIES COMPILE_OPTIONS -fexceptions\)/,
    );
  });
});

describe("the core plugins", () => {
  const dir = path.join(SC, "server", "plugins");
  const loads = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".cpp"))) {
    const m = /^PluginLoad\((\w+)\)/m.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    if (m) loads.add(m[1]!);
  }
  const table = read("server/plugins/SC_StaticPlugins.h");
  const called = new Set([...table.matchAll(/^\s+(\w+)_Load\(table\);/gm)].map((m) => m[1]!));
  // Not built here (Bela, Ableton Link), or left out on purpose: UnpackFFT's
  // own `ft` collides, and nothing under ~/dust/code uses it (see the table).
  const OUT = new Set(["BELA", "LinkUGen", "UnpackFFTUGens"]);

  it("are all registered, but for the known three", () => {
    expect(loads.size).toBeGreaterThan(20);
    const missing = [...loads].filter((l) => !called.has(l) && !OUT.has(l));
    expect(missing).toEqual([]);
    expect(called.has("PV_ThirdParty")).toBe(true);
    expect(called.has("ML_UGens")).toBe(true);
  });

  it("share one interface table pointer in a static build", () => {
    for (const f of ["server/plugins/FFT2InterfaceTable.cpp", "server/plugins/ML.cpp"]) {
      expect(read(f), f).toMatch(/#ifdef STATIC_PLUGINS\n(?:\/\/[^\n]*\n)*extern InterfaceTable\* ft;\n#else\nInterfaceTable\* ft;\n#endif/);
    }
    expect(read("server/plugins/FFTInterfaceTable.cpp")).toMatch(/^InterfaceTable\* ft;$/m);
  });
});

describe("sclang", () => {
  it("lives in /home/we, as on a norns (E9-249)", () => {
    expect(read("platform/wasm/sclang.pre.js")).toMatch(/ENV\['HOME'\] = '\/home\/we';/);
  });

  it("turns a primitive that throws into a failed primitive, as upstream does (E9-250)", () => {
    expect(read("lang/LangPrimSource/PyrPrimitive.cpp")).toMatch(
      /try \{[\s\S]{0,120}err = \(\*def->func\)\(g, numArgsNeeded\);[\s\S]{0,120}\} catch \(std::exception& ex\) \{/,
    );
    const cmake = read("lang/CMakeLists.txt");
    expect(cmake).toMatch(/set_source_files_properties\(LangPrimSource\/PyrPrimitive\.cpp PROPERTIES COMPILE_OPTIONS -fexceptions\)/);
    expect(cmake).toMatch(/set_property\(TARGET sclang APPEND_STRING PROPERTY LINK_FLAGS " -fexceptions"\)/);
  });
});
