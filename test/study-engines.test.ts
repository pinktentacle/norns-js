// E9-203 — an engine nobody publishes, because the study has you write it.
//
// `streams` sets `engine.name = "Moonshine"`, which is the engine of monome's
// engine studies and is in none of the 355 catalogue repositories. The study
// publishes it whole; this takes the two listings off that page and checks
// them before writing anything. The listings here are stand-ins: the real
// ones are monome's, and are fetched by the user's browser, not kept in
// this repository.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Vfs } from "../src/fs/vfs.js";
import { needsOf, sayNeeds } from "../src/community/needs.js";
import {
  extractListing,
  installStudyEngine,
  studyEngine,
  studyEngineOf,
  studyEntry,
  type StudyEngine,
} from "../src/community/study-engines.js";

const F = "```";
const hash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A page shaped like the study: an engine built up in three listings. */
const PAGE = [
  "# a study",
  "",
  F,
  "Thing {",
  "\t// first try",
  "}",
  F,
  "",
  "try it:",
  "",
  F,
  "x = Thing.new();",
  F,
  "",
  F,
  "// exercise 3: third (and final) adaptation",
  "// with smoothing",
  "",
  "Thing {",
  "\t// the one the engine file expects",
  "}",
  F,
  "",
  F,
  "Engine_Thing : CroneEngine {",
  "\talloc { kernel = Thing.new(Crone.server); }",
  "}",
  F,
  "",
  `${F}lua`,
  "engine.name = 'Thing'",
  F,
  "",
].join("\n");

const FINAL = "// exercise 3: third (and final) adaptation\n// with smoothing\n\nThing {\n\t// the one the engine file expects\n}\n";
const ENGINE = "Engine_Thing : CroneEngine {\n\talloc { kernel = Thing.new(Crone.server); }\n}\n";

const spec = (over: Partial<StudyEngine> = {}): StudyEngine => ({
  engine: "Thing",
  folder: "engine_study",
  page: "https://raw.example/pinned/study.md",
  read: "https://example.org/study/",
  title: "a study",
  credit: "Thing was written by somebody.",
  licence: "CC BY 4.0",
  files: [
    { path: "lib/thing.sc", starts: "Thing {", sha256: hash(FINAL) },
    { path: "lib/Engine_Thing.sc", starts: "Engine_Thing : CroneEngine {", sha256: hash(ENGINE) },
  ],
  ...over,
});

describe("taking a listing off a study's page", () => {
  it("takes the LAST one, past the comment lines it opens with", () => {
    expect(extractListing(PAGE, "Thing {")).toBe(FINAL);
    expect(extractListing(PAGE, "Engine_Thing : CroneEngine {")).toBe(ENGINE);
  });

  it("does not take a listing that only mentions the name", () => {
    // `x = Thing.new();` and the Lua that sets engine.name are not the class.
    expect(extractListing(PAGE, "Thing.new")).toBeNull();
    expect(extractListing(PAGE, "Nothing {")).toBeNull();
  });

  it("reads a page with Windows line endings the same", () => {
    expect(extractListing(PAGE.replace(/\n/g, "\r\n"), "Thing {")).toBe(FINAL);
  });
});

describe("installing a study's engine", () => {
  it("writes both listings and says where they are from", async () => {
    const vfs = new Vfs();
    let committed = 0;
    const r = await installStudyEngine(vfs, spec(), {
      fetchText: async (url) => {
        expect(url).toBe("https://raw.example/pinned/study.md");
        return PAGE;
      },
      commit: async () => void committed++,
    });
    expect(r).toMatchObject({ name: "engine_study", files: 3, needsReload: true, skipped: [] });
    expect(vfs.readText("/home/we/dust/code/engine_study/lib/thing.sc")).toBe(FINAL);
    expect(vfs.readText("/home/we/dust/code/engine_study/lib/Engine_Thing.sc")).toBe(ENGINE);
    const readme = vfs.readText("/home/we/dust/code/engine_study/README.md") ?? "";
    expect(readme).toContain("Thing was written by somebody.");
    expect(readme).toContain("https://example.org/study/");
    expect(readme).toContain("Licence: CC BY 4.0.");
    expect(committed).toBe(1);
  });

  it("installs NOTHING when a listing is not the one that was checked", async () => {
    // An engine runs in the audio server. "The page changed" is not a
    // reason to run something nobody looked at — and half an engine is a
    // class library that does not compile, so the good file stays out too.
    const vfs = new Vfs();
    const changed = PAGE.replace("alloc { kernel", "alloc { 1.postln; kernel");
    await expect(installStudyEngine(vfs, spec(), { fetchText: async () => changed })).rejects.toThrow(
      /lib\/Engine_Thing\.sc is not the one that was checked.*https:\/\/example\.org\/study\//,
    );
    expect(vfs.exists("/home/we/dust/code/engine_study/lib/thing.sc")).toBe(false);
    expect(vfs.exists("/home/we/dust/code/engine_study/README.md")).toBe(false);
  });

  it("says so when the page no longer has the listing at all", async () => {
    const vfs = new Vfs();
    await expect(installStudyEngine(vfs, spec(), { fetchText: async () => "# moved" })).rejects.toThrow(
      /no longer has the listing for lib\/thing\.sc/,
    );
    expect(vfs.walk("/home/we/dust/code").length).toBe(0);
  });
});

describe("the table itself", () => {
  it("pins Moonshine to a commit and carries a hash for each file", () => {
    const m = studyEngine("Moonshine");
    expect(m).not.toBeNull();
    expect(m!.folder).toBe("engine_study");
    // A commit, never a branch: what is fetched has to be what was checked.
    expect(m!.page).toMatch(/^https:\/\/raw\.githubusercontent\.com\/monome\/docs\/[0-9a-f]{40}\/norns\/engine-study-2\.md$/);
    expect(m!.files.map((f) => f.path)).toEqual(["lib/moonshine.sc", "lib/Engine_Moonshine.sc"]);
    for (const f of m!.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m!.credit).toContain("Dani Derks + Ezra Buchla");
  });

  it("knows a study url from a repository's", () => {
    expect(studyEngineOf("study:Moonshine")?.engine).toBe("Moonshine");
    expect(studyEngineOf("study:Nope")).toBeNull();
    expect(studyEngineOf("https://github.com/sonocircuit/streams")).toBeNull();
    expect(studyEntry("Moonshine")).toMatchObject({ name: "engine_study", url: "study:Moonshine" });
    expect(studyEntry("Nope")).toBeNull();
  });
});

describe("what streams needs", () => {
  const write = (vfs: Vfs, path: string, body: string): void => vfs.write(path, body);

  it("names the study's engine, which the install queue can then fetch", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/streams/streams.lua", 'engine.name = "Moonshine"');
    const needs = needsOf(vfs, "streams", []);
    expect(needs.map((n) => [n.kind, n.want])).toEqual([["engine", "Moonshine"]]);
    expect(needs[0]!.entry?.url).toBe("study:Moonshine");
    expect(sayNeeds("streams", needs)).toBe("streams also needs engine_study, for the Moonshine engine");
  });

  it("leaves alone somebody who did the study and has their own", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/streams/streams.lua", 'engine.name = "Moonshine"');
    write(vfs, "/home/we/dust/code/engine_study/lib/Engine_Moonshine.sc", "Engine_Moonshine : CroneEngine {}");
    expect(needsOf(vfs, "streams", [])).toEqual([]);
  });

  it("says nothing once the server reports the engine", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/streams/streams.lua", 'engine.name = "Moonshine"');
    expect(needsOf(vfs, "streams", [], "/home/we/dust", ["Moonshine"])).toEqual([]);
  });
});
