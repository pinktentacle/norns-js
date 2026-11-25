// E9-224 — `screen.blend_mode(i)` is an index into matron's operator table,
// and lua/core/screen.lua's BLEND_MODES names the indexes. Ours had the four
// HSL operators at 14-17 instead of 25-28, so everything from CLEAR on was
// four places out. Read straight from the two C files and the Lua table.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const opsIn = (file: string, from: string): string[] => {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const start = text.indexOf(from);
  const body = text.slice(start, text.indexOf("};", start));
  return [...body.matchAll(/CAIRO_OPERATOR_([A-Z_]+)/g)].map((m) => m[1]!);
};

describe("blend modes", () => {
  const ours = opsIn("src/screen/screen.c", "ops[NUM_OPS]");
  const upstream = opsIn("third_party/norns/matron/src/hardware/screen.cc", "CAIRO_OPERATOR_OVER,");

  it("are in matron's order, index for index", () => {
    expect(upstream.length).toBeGreaterThan(20);
    expect(ours).toEqual(upstream);
  });

  it("match the names the Lua side gives them", () => {
    const lua = fs.readFileSync(path.join(root, "third_party/norns/lua/core/screen.lua"), "utf8");
    for (const [name, i] of [...lua.matchAll(/\['([A-Z_]+)'\]\s*=\s*(\d+)/g)].map((m) => [m[1]!, Number(m[2])] as const)) {
      if (name === "NONE" || name === "DEFAULT") continue;
      expect(ours[i], `${name} is ${i}`).toBe(name);
    }
  });
});
