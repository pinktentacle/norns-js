// Node-side dust tree, read straight from `public/dust.json`.
//
// Lazy on purpose: the VFS stores a supplier per path and parses nothing until
// a file is read. Booting norns touches a handful of them, so a test does not
// pay for 690.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Vfs, seedDust } from "./vfs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DUST = path.join(ROOT, "public", "dust.json");

export function loadDustNode(vfs = new Vfs()): Vfs {
  if (!fs.existsSync(DUST)) {
    throw new Error(`no ${path.relative(ROOT, DUST)} — run \`node tools/build-dust.mjs --write\``);
  }
  const tree = JSON.parse(fs.readFileSync(DUST, "utf8")) as Record<string, string>;
  for (const [p, content] of Object.entries(tree)) vfs.mount(p, () => content);
  seedDust(vfs);
  return vfs;
}
