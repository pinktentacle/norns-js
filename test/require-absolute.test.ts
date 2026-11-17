// E9-46 — `require` with an absolute path.
//
// `bline/lib/classes/class_channel.lua:19` writes
//
//   require("/home/we/dust/code/bline/lib/data/dat_pattern_data")
//
// and every template in `package.path` then puts something in FRONT of it:
// `/home/we/dust/code//home/we/dust/code/bline/...`. The script died in its
// main chunk with "module not found" and a page of paths that were all the
// same path with a prefix.
//
// Collapsing the double slash was tried first and is not the fix — it gives
// `/home/we/dust/code/home/we/dust/...`, concatenation with tidier
// punctuation. What the script asked for is the path it wrote.

import { beforeAll, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

let host: Host;

const out = (code: string): string => {
  const before = host.output.length;
  const err = host.run(code);
  if (err) return `ERROR: ${err}`;
  return host.output.slice(before).join("").trim();
};

beforeAll(() => {
  const vfs = new Vfs();
  vfs.write("/home/we/dust/code/bline/lib/data/dat_pattern_data.lua", "return 'the pattern data'");
  vfs.write("/home/we/dust/code/bline/lib/rel.lua", "return 'relative'");
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
});

describe("require with a path rather than a module name", () => {
  it("loads the file an absolute path names", () => {
    expect(out(`print(require('/home/we/dust/code/bline/lib/data/dat_pattern_data'))`)).toContain(
      "the pattern data",
    );
  });

  it("still resolves an ordinary name against the dust tree", () => {
    // The fix must not cost the form ten of the bundled scripts use.
    expect(out(`print(require('bline/lib/rel'))`)).toContain("relative");
  });

  it("still fails for an absolute path that is not there", () => {
    // A miss has to stay a miss, or a script's own `pcall(require, …)`
    // stops recognising it.
    const said = out(`local ok, e = pcall(require, '/home/we/dust/code/bline/lib/nope')
print(tostring(ok))`);
    expect(said).toContain("false");
  });
});
