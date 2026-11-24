#!/usr/bin/env node
// E9-213 — put the scripts made for norns-js where the script store finds them.
//
//   node tools/build-own-scripts.mjs            report what would change
//   node tools/build-own-scripts.mjs --write    write public/own-scripts/
//
// For each script named in tools/own-scripts.json it copies
// norns-scripts/<name>/ into public/own-scripts/<name>/, writes the
// `files.json` the installer lists it by, and copies the screenshot the list
// names as `cover` (else `screenshots/cover.png`, else the first) to
// `cover.png` for the store. Then it writes
// `index.json`. A folder under public/own-scripts that the list no longer
// names is removed.
//
// norns-scripts/ is the scripts' own working folder and is not in this
// repository; public/own-scripts/ is, so a checkout serves them without it.
// Run this with --write after changing a script, and commit the result.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "norns-scripts");
const OUT = join(ROOT, "public", "own-scripts");
const write = process.argv.includes("--write");

const list = JSON.parse(readFileSync(join(ROOT, "tools", "own-scripts.json"), "utf8"));

/** Every file under `dir`, as paths relative to it with `/`, skipping dotfiles. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let changed = 0;
const note = (line) => {
  changed++;
  console.log(line);
};

const index = { what: "Written by tools/build-own-scripts.mjs; read by src/community/own-scripts.ts.", scripts: [] };
const keep = new Set();
for (const s of list.scripts) {
  const from = join(SRC, s.name);
  if (!existsSync(join(from, `${s.name}.lua`))) {
    console.error(`build-own-scripts: ${from} has no ${s.name}.lua — is norns-scripts/ here?`);
    process.exit(1);
  }
  keep.add(s.name);
  const to = join(OUT, s.name);
  const files = walk(from);
  const listing = files.map((f) => ({ path: f, size: statSync(join(from, f)).size }));
  for (const f of files) {
    const a = join(from, f);
    const b = join(to, f);
    if (existsSync(b) && digest(a) === digest(b)) continue;
    note(`${s.name}/${f}`);
    if (write) {
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(a, b);
    }
  }
  // what the source no longer has
  if (existsSync(to)) {
    const want = new Set([...files, "files.json", "cover.png"]);
    for (const f of walk(to)) {
      if (want.has(f)) continue;
      note(`${s.name}/${f} (removed)`);
      if (write) rmSync(join(to, f));
    }
  }
  const shots = files.filter((f) => f.startsWith("screenshots/") && f.endsWith(".png"));
  const cover = s.cover ?? shots.find((f) => f === "screenshots/cover.png") ?? shots[0];
  if (cover === undefined) {
    console.error(`build-own-scripts: ${s.name} has no screenshots/*.png for the store's picture`);
    process.exit(1);
  }
  const coverTo = join(to, "cover.png");
  if (!existsSync(coverTo) || digest(join(from, cover)) !== digest(coverTo)) {
    note(`${s.name}/cover.png`);
    if (write) {
      mkdirSync(to, { recursive: true });
      copyFileSync(join(from, cover), coverTo);
    }
  }
  const text = `${JSON.stringify({ files: listing }, null, 1)}\n`;
  const lp = join(to, "files.json");
  if (!existsSync(lp) || readFileSync(lp, "utf8") !== text) {
    note(`${s.name}/files.json`);
    if (write) {
      mkdirSync(to, { recursive: true });
      writeFileSync(lp, text);
    }
  }
  index.scripts.push({ name: s.name, author: list.author, description: s.description, tags: s.tags });
}

if (existsSync(OUT)) {
  for (const name of readdirSync(OUT)) {
    if (name === "index.json" || keep.has(name)) continue;
    note(`${name}/ (removed)`);
    if (write) rmSync(join(OUT, name), { recursive: true });
  }
}
const indexText = `${JSON.stringify(index, null, 2)}\n`;
const ip = join(OUT, "index.json");
if (!existsSync(ip) || readFileSync(ip, "utf8") !== indexText) {
  note("index.json");
  if (write) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(ip, indexText);
  }
}
console.log(
  changed === 0
    ? "build-own-scripts: public/own-scripts is up to date"
    : `build-own-scripts: ${changed} change(s)${write ? " written" : " — run with --write"}`,
);
