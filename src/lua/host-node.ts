// Node-side loading of norns' Lua tree. Not shipped to the browser — there the
// same map is produced at build time by the bundler.

import fs from "node:fs";
import { applyLuaPatches } from "./patches.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const NORNS_LUA = path.join(REPO_ROOT, "third_party/norns/lua");

/**
 * Every `.lua` under `third_party/norns/lua`, keyed by module name.
 *
 * The key is the path relative to that directory, without the extension and
 * with forward slashes — `core/norns`, `lib/util` — which is what the
 * searcher in `host.ts` looks up.
 */
export function loadNornsLua(dir = NORNS_LUA): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".lua")) {
        const key = path.relative(dir, full).split(path.sep).join("/").replace(/\.lua$/, "");
        out.set(key, fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  // The same patches the browser path applies; the tests must see the
  // same Lua the page does, or a patch is only tested by being used.
  applyLuaPatches(out);
  return out;
}

/** `core/config.lua`, which matron `dofile`s rather than `require`s. */
export function loadConfig(dir = NORNS_LUA): string {
  return fs.readFileSync(path.join(dir, "core", "config.lua"), "utf8");
}
