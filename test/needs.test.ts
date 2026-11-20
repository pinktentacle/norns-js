// E9-32 — naming what a script still needs.
//
// Every case here is a real one. `amen` includes `midigrid/lib/mg_128`;
// `esper` sets `engine.name = "MxSynths"`, which `mx.synths` defines;
// `awake-ashsynth` wants the `Ash` engine and includes nothing from the
// script that has it, which is why the engine half exists at all.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { needsOf, sayNeeds } from "../src/community/needs.js";
import type { CatalogEntry } from "../src/community/catalog.js";

const entry = (name: string): CatalogEntry => ({
  name,
  url: `https://github.com/someone/${name}`,
  author: "someone",
  description: "",
  tags: [],
  discussion: null,
  documentation: null,
});

const CATALOGUE = [
  entry("midigrid"),
  entry("mx.synths"),
  entry("ashsynth"),
  entry("awake-ashsynth"),
  entry("amen"),
].map((e) => e);

const write = (vfs: Vfs, path: string, body: string): void => {
  vfs.write(path, new TextEncoder().encode(body));
};

describe("a script that needs another script's Lua", () => {
  it("names the library behind an include whose head is a catalogue entry", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/amen/amen.lua", 'local g = include("midigrid/lib/mg_128")\n');
    const needs = needsOf(vfs, "amen", CATALOGUE);
    expect(needs.map((n) => [n.kind, n.want])).toEqual([["script", "midigrid"]]);
    expect(needs[0]!.entry?.url).toContain("midigrid");
    expect(sayNeeds("amen", needs)).toBe("amen also needs midigrid");
  });

  it("says nothing once that library is in code/", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/amen/amen.lua", 'include("midigrid/lib/mg_128")\n');
    write(vfs, "/home/we/dust/code/midigrid/lib/mg_128.lua", "return {}\n");
    expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
  });

  // E9-184 — the same question asked about a deletion that has not
  // happened. maiden can remove several projects at once now, and 28 of
  // the catalogue's entries are libraries for other entries: a tick on
  // one of those is a mistake you can make without ever reading the name.
  //
  // Rather than a second scanner — which would recognise a dependency
  // this one does not and then disagree with it — the removal says which
  // projects it is about to delete and gets the answer it would get by
  // deleting them and asking again.
  describe("asked as if some projects were already gone", () => {
    const tree = (): Vfs => {
      const vfs = new Vfs();
      write(vfs, "/home/we/dust/code/amen/amen.lua", 'include("midigrid/lib/mg_128")\n');
      write(vfs, "/home/we/dust/code/midigrid/lib/mg_128.lua", "return {}\n");
      return vfs;
    };

    it("reports the library again when it is the one being deleted", () => {
      const vfs = tree();
      expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
      const after = needsOf(vfs, "amen", CATALOGUE, "/home/we/dust", [], ["midigrid"]);
      expect(after.map((n) => [n.kind, n.want])).toEqual([["script", "midigrid"]]);
    });

    it("matches the name however it is cased", () => {
      const vfs = tree();
      expect(
        needsOf(vfs, "amen", CATALOGUE, "/home/we/dust", [], ["MidiGrid"]).map((n) => n.want),
      ).toEqual(["midigrid"]);
    });

    it("says nothing about a project that is not going", () => {
      const vfs = tree();
      expect(needsOf(vfs, "amen", CATALOGUE, "/home/we/dust", [], ["mx.synths"])).toEqual([]);
    });

    it("an empty list is the question it always answered", () => {
      const vfs = tree();
      expect(needsOf(vfs, "amen", CATALOGUE, "/home/we/dust", [], [])).toEqual([]);
    });

    it("a project going does not supply its own engine class either", () => {
      // `enginesHere` is built from the same walk. A script whose engine
      // comes from a project being deleted has to be reported short of
      // it, or removing the pair would be silently fine.
      const vfs = new Vfs();
      write(vfs, "/home/we/dust/code/awake-ashsynth/awake.lua", 'engine.name = "Ash"\n');
      // `Engine_<name> :` is the declaration `needs.ts` looks for, which
      // is how norns names a CroneEngine subclass.
      write(vfs, "/home/we/dust/code/ashsynth/lib/Engine_Ash.sc", "Engine_Ash : CroneEngine {\n}\n");
      expect(needsOf(vfs, "awake-ashsynth", CATALOGUE)).toEqual([]);
      const after = needsOf(vfs, "awake-ashsynth", CATALOGUE, "/home/we/dust", [], ["ashsynth"]);
      expect(after.map((n) => n.kind)).toEqual(["engine"]);
      expect(after[0]!.want).toBe("Ash");
    });
  });

  it("leaves norns' own modules and the script's own folders alone", () => {
    // The false alarm this guards against: `core/` and `lib/` are not
    // missing libraries, they are norns and the script itself.
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/amen/amen.lua",
      [
        'local ParamSet = require "core/paramset"',
        'local x = include("lib/thing")',
        'local y = include("amen/lib/other")',
        'local mu = require "musicutil"',
      ].join("\n"),
    );
    expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
  });

  it("passes over a library nobody has, and no longer over one somebody does", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE for `shnth`: "naming them
    // would be naming something there is no way to install". E9-70 went
    // and looked — shnth is at github.com/cfdrake/shnth and six more like
    // it exist — so the ones that are real are named and installed now
    // (see the E9-71 block below), and only the ones that are nowhere are
    // still passed over.
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/amen/amen.lua", 'include("toga/lib/toga")\n');
    expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
  });

  it("ignores a commented-out include", () => {
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/amen/amen.lua",
      '-- local pattern_time = include("midigrid/lib/mg_128")\n',
    );
    expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
  });

  it("names each library once, however many files ask", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/amen/amen.lua", 'include("midigrid/lib/mg_128")\n');
    write(vfs, "/home/we/dust/code/amen/lib/a.lua", 'include("midigrid/lib/mg_64")\n');
    expect(needsOf(vfs, "amen", CATALOGUE)).toHaveLength(1);
  });
});

describe("a script that needs another script's ENGINE", () => {
  it("names the engine when no installed script declares the class", () => {
    // awake-ashsynth includes nothing from ashsynth — the dependency is a
    // class name, which is why an include scan cannot see it.
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/awake-ashsynth/awake-ashsynth.lua",
      'engine.name = "Ash"\n',
    );
    const needs = needsOf(vfs, "awake-ashsynth", CATALOGUE);
    expect(needs.map((n) => [n.kind, n.want])).toEqual([["engine", "Ash"]]);
    // E9-74 — THIS USED TO ASSERT THE OPPOSITE: "no index of engines is
    // carried". One is now, read off every .sc in all 355 repositories by
    // the same sweep that writes the blockers table, and it names the
    // script that declares the class so the panel can install it.
    expect(needs[0]!.entry?.name).toBe("ashsynth");
    expect(sayNeeds("awake-ashsynth", needs)).toBe(
      "awake-ashsynth also needs ashsynth, for the Ash engine",
    );
  });

  it("says nothing when another installed script declares it", () => {
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/awake-ashsynth/awake-ashsynth.lua",
      'engine.name = "Ash"\n',
    );
    write(
      vfs,
      "/home/we/dust/code/ashsynth/lib/Engine_Ash.sc",
      "Engine_Ash : CroneEngine {\n}\n",
    );
    expect(needsOf(vfs, "awake-ashsynth", CATALOGUE)).toEqual([]);
  });

  it("says nothing when the script brings its own", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/esper/esper.lua", 'engine.name = "Esper"\n');
    write(vfs, "/home/we/dust/code/esper/lib/Engine_Esper.sc", "Engine_Esper : CroneEngine {}\n");
    expect(needsOf(vfs, "esper", CATALOGUE)).toEqual([]);
  });

  it("is not fooled by engine.name = \"None\"", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/amen/amen.lua", 'engine.name = "None"\n');
    expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
  });

  it("skips an engine name built at runtime, rather than guessing", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/amen/amen.lua", "engine.name = chosen_engine\n");
    expect(needsOf(vfs, "amen", CATALOGUE)).toEqual([]);
  });
});

describe("an engine set conditionally", () => {
  it("takes the name out of shnthsalslied's line, verbatim", () => {
    // shnthsalslied.lua:16, as written. The condition is a UGen this build
    // really does have — FormantTriPTR is compiled into scsynth and
    // `declareExtensions` writes the marker file the line looks for — so
    // the branch that is taken here is the one that wants LiedMotor, and
    // LiedMotor is in schicksalslied.
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/shnthsalslied/shnthsalslied.lua",
      [
        'local extensions = "/home/we/.local/share/SuperCollider/Extensions"',
        `engine.name = util.file_exists(extensions .. "/FormantTriPTR/FormantTriPTR.sc") and 'LiedMotor' or nil`,
      ].join("" + String.fromCharCode(92) + "n"),
    );
    const needs = needsOf(vfs, "shnthsalslied", [...CATALOGUE, entry("schicksalslied")]);
    expect(needs.map((n) => [n.kind, n.want])).toEqual([["engine", "LiedMotor"]]);
    expect(needs[0]!.entry?.name).toBe("schicksalslied");
    expect(sayNeeds("shnthsalslied", needs)).toBe(
      "shnthsalslied also needs schicksalslied, for the LiedMotor engine",
    );
  });

  it("does not take a name out of a COMPARISON", () => {
    // 19 of the 43 non-plain lines in the catalogue are this, and the name
    // in them is one the script is asking ABOUT, not one it needs.
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/thing/thing.lua",
      'if engine.name == "MxSamples" then print("hi") end',
    );
    expect(needsOf(vfs, "thing", CATALOGUE)).toEqual([]);
  });

  it("leaves a variable alone, because there is no name in the line", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/thing/thing.lua", "engine.name = config.engine.name");
    expect(needsOf(vfs, "thing", CATALOGUE)).toEqual([]);
  });
});

describe("an engine the index does not name", () => {
  it("fails open, exactly as every engine did before E9-74", () => {
    // `Moonshine` is real and is in NO catalogue script: it is the engine
    // monome's engine study has you build yourself, and `streams` sets
    // `engine.name = "Moonshine"` expecting you to have done it. The index
    // leaves it out, so the need is honest and empty-handed rather than
    // wrong.
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/streams/streams.lua", 'engine.name = "Moonshine"' + String.fromCharCode(92) + "n");
    const needs = needsOf(vfs, "streams", CATALOGUE);
    expect(needs.map((n) => [n.kind, n.want])).toEqual([["engine", "Moonshine"]]);
    expect(needs[0]!.entry).toBeNull();
    expect(sayNeeds("streams", needs)).toBe(
      "streams also needs the Moonshine engine, which no catalogue script has",
    );
  });

  it("says nothing when the provider is already installed", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/awake-ashsynth/awake-ashsynth.lua", 'engine.name = "Ash"' + String.fromCharCode(92) + "n");
    write(vfs, "/home/we/dust/code/ashsynth/lib/Engine_Ash.sc", "Engine_Ash : CroneEngine {}" + String.fromCharCode(92) + "n");
    expect(needsOf(vfs, "awake-ashsynth", CATALOGUE)).toEqual([]);
  });
});

describe("both at once", () => {
  it("reads as one sentence", () => {
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/esper/esper.lua",
      ['include("mx.synths/lib/mx.synths")', 'engine.name = "MxSynths"'].join("\n"),
    );
    const needs = needsOf(vfs, "esper", CATALOGUE);
    expect(needs).toHaveLength(2);
    expect(sayNeeds("esper", needs)).toBe(
      // The provider is already named as a script need, so the engine
      // clause would be the same fact said twice.
      "esper also needs mx.synths",
    );
  });

  it("answers nothing for a folder that is not there", () => {
    expect(needsOf(new Vfs(), "ghost", CATALOGUE)).toEqual([]);
    expect(sayNeeds("ghost", [])).toBe("");
  });
});

// E9-71 — the libraries that are real without being in the catalogue.
//
// `needsOf` used to pass over a head the catalogue did not name, on the
// reasoning that "there would be nothing to offer". E9-70 measured the ten
// scripts that reasoning had left alone: all six libraries exist, every
// one was fetched and checked to hold the file its script asks for, and
// `off-catalogue.json` is where they are. They install with the script now,
// so enabling the mod or plugging the device in is all there is left to do.
describe("a library that is real and is not a catalogue entry", () => {
  it("names cheat_codes_2's namesizer, and where it is", () => {
    const vfs = new Vfs();
    write(
      vfs,
      "/home/we/dust/code/cheat_codes_2/cheat_codes_2.lua",
      ['if util.file_exists(_path.code.."namesizer") then', "  Namesizer = include 'namesizer/lib/namesizer'", "end"].join("\n"),
    );
    const needs = needsOf(vfs, "cheat_codes_2", CATALOGUE);
    expect(needs.map((n) => [n.kind, n.want])).toEqual([["script", "namesizer"]]);
    expect(needs[0]!.entry?.url).toBe("https://github.com/Quixotic7/namesizer");
    expect(needs[0]!.offCatalogue).toBe(true);
    // The whole point of the flag: a reader sent to the catalogue for this
    // would not find it.
    expect(sayNeeds("cheat_codes_2", needs)).toBe(
      "cheat_codes_2 also needs namesizer (github.com/Quixotic7/namesizer)",
    );
  });

  it("carries an installable entry, which is how it gets fetched", () => {
    // The panel installs any need that has an `entry`; a library that
    // arrived by some other road would be a second thing to maintain.
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/sines/sines.lua", "z_tuning = require('z_tuning/lib/mod')\n");
    const [need] = needsOf(vfs, "sines", CATALOGUE);
    expect(need?.entry).not.toBeNull();
    expect(need?.entry?.name).toBe("z_tuning");
    expect(need?.entry?.url).toBe("https://github.com/catfact/z_tuning");
  });

  it("keeps the exact spelling a script requires, not the lower-cased head", () => {
    // gridstep asks for `GridCapture/GridCapture`. The head is matched
    // lower-cased, as every head is; the entry keeps the capitals.
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/gridstep/gridstep.lua", "gcap = require 'GridCapture/GridCapture'\n");
    const [need] = needsOf(vfs, "gridstep", CATALOGUE);
    expect(need?.want).toBe("GridCapture");
  });

  it("says nothing once it is installed", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/tetrabobo/tetrabobo.lua", 'shnth = include("shnth/lib/shnth")\n');
    write(vfs, "/home/we/dust/code/shnth/lib/shnth.lua", "return {}\n");
    expect(needsOf(vfs, "tetrabobo", CATALOGUE)).toEqual([]);
  });

  it("lets the catalogue win if an entry ever appears under the same name", () => {
    // The catalogue is the thing being maintained; this file is a stopgap.
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/thing/thing.lua", "require 'matrix/lib/matrix'\n");
    const [need] = needsOf(vfs, "thing", [...CATALOGUE, entry("matrix")]);
    expect(need?.entry?.url).toBe("https://github.com/someone/matrix");
    expect(need?.offCatalogue).toBeUndefined();
    expect(sayNeeds("thing", [need!])).toBe("thing also needs matrix");
  });

  it("still says nothing about a library nobody has", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/thing/thing.lua", "require 'nowhere/lib/nowhere'\n");
    expect(needsOf(vfs, "thing", CATALOGUE)).toEqual([]);
  });
});
