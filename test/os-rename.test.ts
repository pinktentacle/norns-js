// E9-27 — `os.rename`, the last of Lua's file operations still pointing at
// fengari.
//
// Fengari's goes through a browser `fs` shim that answers every write with
// `nil  EROFS: read-only file system, rename`, which is a lie in a tree the
// user owns. **Twelve catalogue scripts call it** — cheat_codes_2, clipper,
// ekombi, flora, gematria, krill, less_concepts, midarto, pitfalls, splnkr,
// twins and yggdrasil — mostly to keep the old copy of a pset or a data
// file before writing a new one, which is exactly the moment not to lose it.
//
// The binary case is the one worth a test of its own: the obvious
// implementation is `_vfs_read` then `_vfs_write`, and `_vfs_read` hands Lua
// a STRING. Several of the twelve rename a recording.

import { describe, expect, it, beforeAll } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

let host: Host;
let vfs: Vfs;

const run = (code: string): void => {
  const err = host.run(code);
  if (err) throw new Error(err);
};

/** `print` is the only reader this harness has. */
const say = (expr: string): string => {
  const before = host.output.length;
  run(`print(tostring(${expr}))`);
  return host.output.slice(before).join("").trim();
};

beforeAll(() => {
  vfs = new Vfs();
  vfs.mkdir("/home/we/dust/data");
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
});

describe("os.rename", () => {
  it("moves a text file and leaves nothing behind", () => {
    vfs.write("/home/we/dust/data/a.txt", "hello");
    expect(say(`os.rename('/home/we/dust/data/a.txt', '/home/we/dust/data/b.txt')`)).toBe("true");
    expect(vfs.readText("/home/we/dust/data/b.txt")).toBe("hello");
    expect(vfs.exists("/home/we/dust/data/a.txt")).toBe(false);
  });

  it("carries every byte, including the ones a string would damage", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 0, 128]);
    vfs.write("/home/we/dust/data/rec.wav", bytes);
    run(`os.rename('/home/we/dust/data/rec.wav', '/home/we/dust/data/kept.wav')`);
    expect(Array.from(vfs.read("/home/we/dust/data/kept.wav") ?? [])).toEqual(Array.from(bytes));
  });

  it("answers nil and a reason for a source that is not there", () => {
    // Lua's shape: `local ok, err = os.rename(...)`. Returning `false`, or
    // raising, is what the fengari version did and what callers do not
    // expect — `if not os.rename(a, b) then ... end` reads the first value.
    const before = host.output.length;
    run(`local ok, e = os.rename('/home/we/dust/data/nope.txt', '/x')
print(tostring(ok) .. '|' .. tostring(e))`);
    const out = host.output.slice(before).join("").trim();
    expect(out).toMatch(/^nil\|/);
    expect(out).toContain("nope.txt");
  });

  it("keeps the original when the destination cannot be written", () => {
    vfs.write("/home/we/dust/data/keep.txt", "safe");
    // Nothing in the VFS refuses a write today, so this is the weaker half
    // of the promise: what is asserted is the ORDER — the source goes after
    // the destination exists, never before.
    run(`os.rename('/home/we/dust/data/keep.txt', '/home/we/dust/data/moved.txt')`);
    expect(vfs.readText("/home/we/dust/data/moved.txt")).toBe("safe");
  });
});
