// E9-27 — `include`, when the only thing wrong is the capitals.
//
// `startup.lua:52` resolves an include against three directories with the
// name exactly as written. Our installer lower-cases the folder it creates;
// maiden keeps the repository's own spelling. A script that builds its
// include path out of something capitalised then misses by case alone:
//
//     Ygg.lua:28  include(engine.name .. '/lib/gen_sequence')
//     ### MISSING INCLUDE: Ygg/lib/gen_sequence
//
// One catalogue script in 354 does this, which is not a reason to rename
// folders already sitting on somebody's disk. The fallback is a LAST
// resort, so nothing about an include that already resolved changes.

import { describe, expect, it, beforeAll } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

let host: Host;
let vfs: Vfs;

const out = (code: string): string => {
  const before = host.output.length;
  const err = host.run(code);
  if (err) return `ERROR: ${err}`;
  return host.output.slice(before).join("").trim();
};

beforeAll(() => {
  vfs = new Vfs();
  // The folder is lower-case, as the installer writes it.
  vfs.write("/home/we/dust/code/ygg/lib/gen_sequence.lua", "return 'the library'");
  // And one that is capitalised, for the opposite mistake.
  vfs.write("/home/we/dust/code/Capital/lib/thing.lua", "return 'capital'");
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
});

describe("include and the capitals", () => {
  it("finds a lower-case folder asked for in capitals", () => {
    expect(out(`print(include('Ygg/lib/gen_sequence'))`)).toContain("the library");
  });

  it("finds a capitalised folder asked for in lower case", () => {
    expect(out(`print(include('capital/lib/thing'))`)).toContain("capital");
  });

  // E9-55 moved the fold one layer DOWN, into the Vfs, because `include`
  // was never the only door: `Ygg.lua:1172` reaches the same folder through
  // `screen.load_png`, and `io.open`, `util.file_exists` and `util.scandir`
  // all got the same miss. So the capitalised path now resolves in the
  // lookup itself, and `include` takes its ordinary exact branch — which is
  // why the "matched by case" line below is NOT printed any more. The
  // wrapper stays as the last resort for the directories the Vfs fold does
  // not cover (`norns.state.path`, `_path.extn`).
  it("resolves without the fallback having to say anything", () => {
    const said = out(`include('Ygg/lib/gen_sequence')`);
    expect(said).toContain("Ygg/lib/gen_sequence.lua");
    expect(said).not.toMatch(/matched Ygg by case/);
  });

  it("still takes the exact path first, and says nothing about case", () => {
    const said = out(`include('ygg/lib/gen_sequence')`);
    expect(said).toContain("/home/we/dust/code/ygg/lib/gen_sequence.lua");
    expect(said).not.toMatch(/by case/);
  });

  it("still fails, with startup.lua's own message, when the file is absent", () => {
    // The fallback must not turn a real miss into a different error, or a
    // script's own `pcall(include, ...)` stops recognising it.
    const said = out(`local ok, e = pcall(include, 'Nope/lib/nothing')
print(tostring(ok) .. '|' .. tostring(e))`);
    expect(said).toContain("MISSING INCLUDE: Nope/lib/nothing");
    expect(said).toMatch(/^### MISSING INCLUDE|false\|/m);
  });

  it("does not fold a bare name, only a path with a folder in front", () => {
    // `include('thing')` has no folder to match, so there is nothing to
    // fold and the exact lookup is the whole of it.
    expect(out(`local ok = pcall(include, 'Thing')
print(tostring(ok))`)).toContain("false");
  });
});

// E9-59 — norns' own Lua is on the filesystem, which is where `include`
// looks. `require` reads a map of bundled sources; `include` does not —
// startup.lua resolves a name against the script's path, `_path.code` and
// `_path.extn`, with `util.file_exists`. `_path.extn` is
// `/home/we/norns/lua/extn/` and held nothing, so `tambla`'s
// `include('sky/unstable')` missed a file that was in the bundle.
describe("include, for norns' own extn tree", () => {
  it("finds sky where _path.extn says it is", () => {
    const vfs = new Vfs();
    const sources = loadNornsLua();
    for (const [name, src] of sources) vfs.mount(`/home/we/norns/lua/${name}.lua`, () => src);
    const h = createHost({ sources, vfs });
    registerFs(h.registry, vfs);
    const err = boot(h, loadConfig());
    if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
    const before = h.output.length;
    const e = h.run("local sky = include('sky/unstable') print(type(sky))");
    const said = h.output.slice(before).join("");
    expect(e, said).toBeNull();
    expect(said).toContain("table");
  });
});
