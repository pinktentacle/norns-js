// E9-233 — softcut's voices and buffers cross from Lua's 1-based numbering
// to crone's 0-based one in exactly the places matron makes them cross.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_BASED } from "../src/crone/register.js";

const WEAVER = path.join(__dirname, "..", "third_party", "norns", "matron", "src", "weaver.cc");

/** `_norns` name → the 0-based positions of the arguments weaver.cc takes one off. */
function fromWeaver(src: string): Map<string, number[]> {
  const names = new Map<string, string>();
  for (const m of src.matchAll(/lua_register_norns\("([a-z_]+)", &(_[a-z_]+)\);/g)) names.set(m[2]!, m[1]!);
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(/^int (_[a-z_]+)\(lua_State \*l\) \{([\s\S]*?)^\}/gm)) {
    const lua = names.get(m[1]!);
    if (lua === undefined) continue;
    const minus = [...m[2]!.matchAll(/luaL_check(?:integer|number)\(l, (\d+)\) - 1;/g)].map((x) => Number(x[1]) - 1);
    if (minus.length > 0) out.set(lua, minus);
  }
  return out;
}

describe("where a softcut index is taken from 1 to 0", () => {
  it.skipIf(!fs.existsSync(WEAVER))("is exactly where matron's weaver.cc does it", () => {
    const upstream = fromWeaver(fs.readFileSync(WEAVER, "utf8"));
    const cut = [...upstream].filter(([name]) => /cut|softcut/.test(name));
    expect(Object.fromEntries(cut)).toEqual(ONE_BASED);
  });

  it("includes the buffer a voice reads, which is cut_param_ii's VALUE", () => {
    // `softcut.buffer(voice, buffer)` is `_norns.cut_param_ii("buffer", voice, buffer)`.
    expect(ONE_BASED.cut_param_ii).toEqual([1, 2]);
  });
});
