// What `third_party/` is, exactly, so a published source can be rebuilt.
//
//   node tools/pins.mjs --write     # regenerate PINS.md and patches/
//   node tools/pins.mjs --check     # fail if either is out of date
//
// WHY THIS EXISTS. norns-js is AGPL, and a source offer that cannot be built
// is not an offer. `third_party/` is gitignored -- twelve upstream trees and
// toolchains, none of it ours to redistribute -- so the published repository
// says "fetch these yourself" without saying WHICH. Twelve trees at unknown
// commits is a build nobody can reproduce.
//
// WHY GENERATED, AND WHY `--check`. The failure mode of a hand-kept list is
// silent: somebody bumps SuperCollider, nobody edits the list, and the file
// now states a commit that was never built. Exactly the reasoning behind
// `tools/audit-licences.mjs`, and the same remedy.
//
// WHY IT EXPORTS LOCAL MODIFICATIONS. SuperCollider is not vendored
// unmodified: it carries changes this project needs and upstream has not
// taken (E0-35, E0-36, E0-38a, and the static plugin list of E4-15/E4-17).
// A pin naming only the commit would be WORSE than no pin -- it would look
// complete while omitting the one part that cannot be downloaded from
// anywhere. So the diff is written to `patches/` and checked for drift.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR = join(ROOT, "third_party");
const OUT = join(ROOT, "PINS.md");
const PATCHES = join(ROOT, "patches");

const write = process.argv.includes("--write");
const check = process.argv.includes("--check");

/** Run git in a directory, or return null if it is not a checkout. */
function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * What a tree that is NOT a git checkout is, read from what is inside it.
 *
 * These arrive as release tarballs, and the version is in the directory the
 * tarball unpacks to -- `freetype-VER-2-10-4`, `pixman-0.40.0`. Reading the
 * parent folder's name instead would be reading our own abbreviation back.
 */
function fromContents(dir) {
  // SORTED, AND THAT IS NOT TIDINESS. E9-99: `readdirSync` returns what the
  // filesystem hands back, which on NTFS is the directory’s own order and
  // follows the order the files were WRITTEN. This machine answered
  // `eslint.config.mjs, LICENSE, logo.png` for fengari and
  // `CHANGELOG.md, cliff.toml, CMakeLists.txt` for portedplugins; a machine
  // that unpacked the same archives in another order answers something else,
  // and `pins:check` calls it stale over a difference that is not one.
  //
  // Third time in this file, after the modification times in the fengari
  // diff (E9-94, and that function left with fengari in E9-118) and the
  // abbreviated `index` lines in `diffOf` (E9-98): a generated document
  // must record nothing about the machine that generated it.
  const names = readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .sort();
  const versioned = names.filter((n) => /\d+[._-]\d+/.test(n));
  return (versioned.length > 0 ? versioned : names.slice(0, 3)).join(", ");
}

/**
 * Is this directory a repository, or merely INSIDE one?
 *
 * `git -C third_party/cmake rev-parse HEAD` succeeds: it walks up and
 * answers for norns-js itself. Without this, every unpacked tarball was
 * reported as a git checkout carrying "local modifications" that were
 * actually this project's own uncommitted files. Measured, by watching six
 * empty patch files appear.
 */
function isRepoRoot(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top === null) return false;
  return resolve(top) === resolve(dir);
}

function describe(name) {
  const dir = join(VENDOR, name);
  const head = isRepoRoot(dir) ? git(dir, ["rev-parse", "HEAD"]) : null;
  if (head === null) return { name, kind: "release", what: fromContents(dir) };
  // The file list comes from the DIFF, not from `status --porcelain`.
  // Porcelain's first two columns are the status and the third is a space,
  // so the path starts at index 3 -- except that trimming the output eats
  // the leading space of the first line, which silently turned
  // `lang/CMakeLists.txt` into `ang/CMakeLists.txt`. The diff's own file
  // list needs no slicing and is exactly what the patch carries.
  const changed = git(dir, ["diff", "--name-only"]) ?? "";
  return {
    name,
    kind: "git",
    url: git(dir, ["remote", "get-url", "origin"]) ?? "(no remote)",
    commit: head,
    tag: git(dir, ["describe", "--tags", "--exact-match"]),
    modified: changed.length > 0,
    files: changed.split("\n").filter(Boolean),
    submodules: submodulesOf(dir),
  };
}

/**
 * The submodules a tree carries, and whether they are actually HERE.
 *
 * `git clone` does not fetch them, and what is missing does not announce
 * itself: mi-UGens keeps libsamplerate this way, and without it the build
 * drops MiBraids — silently, by design, because a UGen whose library is
 * absent is worse than no UGen. A pin naming only the commit would describe
 * a tree that builds four plugins where this one builds five.
 *
 * Read from `git submodule status` rather than from `.gitmodules`: the
 * leading `-` is git's own answer to "is it populated", and the question
 * here is about this working copy, not about upstream's intentions.
 */
function submodulesOf(dir) {
  const out = git(dir, ["submodule", "status"]);
  if (out === null || out.length === 0) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      here: !line.startsWith("-"),
      path: line.trim().split(/\s+/)[1] ?? "",
    }));
}

/** The emscripten the build must match, which is not emsdk's own commit. */
function emscriptenVersion() {
  const f = join(VENDOR, "emsdk", "upstream", "emscripten", "emscripten-version.txt");
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").trim().replace(/"/g, "");
}

/**
 * The patch a tree carries, as a diff that is the SAME ON EVERY MACHINE.
 *
 * `--full-index` is not decoration. E9-98: a build machine applied
 * `patches/supercollider.patch`, regenerated it, and got a file 36 bytes
 * longer — identical except that every `index` line carried a ten-character
 * hash where this one carries seven. `git diff` abbreviates object names to
 * `core.abbrev`, which is AUTOMATIC and scales with how many objects the
 * repository has: a full clone of SuperCollider is 27,236 commits and the
 * copy here is a shallow one. So the same tree, patched the same way, wrote
 * two different patches and `pins:check` called the machine stale.
 *
 * Full forty characters everywhere removes the variable. It also makes the
 * patch better: `git apply --3way` can use a full index line and cannot use
 * an abbreviated one.
 *
 * Same family as the modification times in the fengari diff (E9-94, gone
 * with fengari in E9-118), and the same lesson: a generated file that
 * embeds anything about THIS machine is a check that fails on every other
 * one.
 */
function diffOf(name) {
  return execFileSync("git", ["-C", join(VENDOR, name), "diff", "--full-index"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

if (!existsSync(VENDOR)) {
  console.error("third_party/ is not here, so there is nothing to pin.");
  process.exit(1);
}

/**
 * Where an assembled tree's directories come from.
 *
 * A release tree is normally one download, and the row that names what is
 * in it is enough. `sc-plugins-extra` is not: it is one directory per
 * upstream repository, vendored by hand because each of those projects
 * ships a single UGen and its own CMake. Without this a reader can see the
 * directory names and still have no way to fetch them.
 */
const ORIGINS = {
  "sc-plugins-extra": [
    "`ByteBeat/` — https://github.com/midouest/bytebeat",
    "`FormantTriPTR/` — https://github.com/robbielyman/FormantTriPTR",
    "`PulsePTR/` — https://github.com/robbielyman/pulseptr",
    "`TrianglePTR/` — https://github.com/robbielyman/triangleptr",
  ],
};

/**
 * Three directories under `third_party/` that this document does not pin.
 *
 * E9-97, and the reason is the one `tools/release-notes.mjs` already gives
 * for not forking the emsdk: a compiler is a tool and not Corresponding
 * Source. `cmake` is a Windows binary distribution and `ninja` is one .exe
 * — which version matters is real (CMake 4 will not configure
 * SuperCollider at all) and it is pinned where it is enforced, in
 * `tools/setup-windows.ps1`. A row reading "`ninja` | ninja.exe" documents
 * nothing.
 *
 * `emforge` is the download cache the build scripts' own recipes name,
 * plus what is left of a spike that asked whether emscripten-forge's
 * prebuilt cairo could be used. It could not. Its contents are copies of
 * tarballs pinned elsewhere in this file, so pinning it twice says less
 * than once.
 *
 * It is also what makes this document the SAME on both machines. The three
 * are on the development machine and are not fetched by
 * `tools/fetch-third-party.ps1`, so without this the build machine
 * regenerates a PINS.md fourteen trees long and `pins:check` can never
 * pass there — which is exactly what happened on the first real run.
 */
const NOT_PINNED = new Set(["cmake", "ninja", "emforge"]);

const trees = readdirSync(VENDOR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => !NOT_PINNED.has(n))
  .sort()
  .map(describe);

const patched = trees.filter((t) => t.kind === "git" && t.modified);
const em = emscriptenVersion();

const L = [];
L.push("# 06 — Upstream pins");
L.push("");
L.push("**Generated by `node tools/pins.mjs --write`. Do not edit by hand.**");
L.push("`--check` fails when it is stale, because a pin nobody updates is worse");
L.push("than no pin at all: it states a commit that was never built.");
L.push("");
L.push("`third_party/` is not in this repository — it is other projects' code and");
L.push("toolchains, none of it ours to redistribute. This file is what makes the");
L.push("rest of the repository buildable: fetch each tree at the commit named");
L.push("here, apply anything under `patches/`, then follow");
L.push("[`02-ARCHITECTURE.md`](02-ARCHITECTURE.md).");
L.push("");
if (em) {
  L.push(`The toolchain is **emscripten ${em}**, and that is not a suggestion:`);
  L.push("SuperCollider's wasm build is pinned to it, and an older one fails in");
  L.push("ways that read as bugs in this project rather than as a version skew.");
  L.push("");
}
L.push("## Source trees");
L.push("");
// E9-78 — THE WHOLE FORTY CHARACTERS, and that is not pedantry.
//
// These were abbreviated to twelve, which is fine to read and useless to
// use: `git fetch <url> <sha>` refuses an abbreviation. Measured, against
// the real repository —
//
//   git fetch --depth=1 …/supercollider.git 0c5a96d701be                 exit 128
//   git fetch --depth=1 …/supercollider.git 0c5a96d701be992627b4…120f0   exit 0
//
// A pin nobody can fetch is a pin that only documents; the point of this
// file is that somebody can rebuild what was served to them.
L.push("| Tree | Upstream | Commit |");
L.push("|---|---|---|");
for (const t of trees.filter((x) => x.kind === "git")) {
  const tag = t.tag ? ` (\`${t.tag}\`)` : "";
  const mark = t.modified ? " **+ patches**" : "";
  L.push(`| \`${t.name}\` | ${t.url} | \`${t.commit}\`${tag}${mark} |`);
}
L.push("");
L.push("## Releases, unpacked rather than cloned");
L.push("");
L.push("| Tree | What is in it |");
L.push("|---|---|");
for (const t of trees.filter((x) => x.kind === "release")) {
  L.push(`| \`${t.name}\` | ${t.what} |`);
}
L.push("");

// A tree that was ASSEMBLED rather than unpacked needs its parts named,
// or the row above is unbuildable: `sc-plugins-extra` is four upstream
// repositories, one directory each, and nothing in the directory says so.
for (const t of trees.filter((x) => x.kind === "release" && ORIGINS[x.name])) {
  L.push("### `" + t.name + "` — one directory per upstream repository");
  L.push("");
  for (const line of ORIGINS[t.name]) L.push(`- ${line}`);
  L.push("");
}

// WHAT IS LISTED IS WHAT IS POPULATED, and that is the whole claim. A
// submodule that is checked out here is one this build reached for; an empty
// one was not needed by anything that was built, and listing every empty one
// would print seven rows of norns' C dependencies as if they were missing
// pieces. They are not — that tree is read, not compiled.
const nested = trees
  .filter((t) => t.kind === "git")
  .map((t) => ({ name: t.name, subs: t.submodules.filter((s) => s.here) }))
  .filter((t) => t.subs.length > 0);
if (nested.length > 0) {
  L.push("## Submodules, which a clone does not bring");
  L.push("");
  L.push("`git clone` stops at the tree itself, and what a submodule carries goes");
  L.push("missing quietly rather than loudly — mi-UGens keeps libsamplerate this");
  L.push("way, and without it the build leaves MiBraids out on purpose, because a");
  L.push("UGen whose library is absent is worse than no UGen at all.");
  L.push("");
  L.push("These are the ones populated in the trees that were built here. Any");
  L.push("other submodule in them was not needed by anything this project");
  L.push("compiles.");
  L.push("");
  L.push("| Tree | Submodule |");
  L.push("|---|---|");
  for (const t of nested) {
    for (const s of t.subs) L.push(`| \`${t.name}\` | \`${s.path}\` |`);
  }
  L.push("");
  L.push("```");
  for (const t of nested) {
    L.push(`git -C third_party/${t.name} submodule update --init --recursive`);
  }
  L.push("```");
  L.push("");
}

/**
 * E9-117 — Lua, which is a tarball rather than a checkout or a patch.
 *
 * `tools/lua53/build.sh` fetches it and VERIFIES THE HASH before it
 * unpacks anything, so the build script is where the pin actually lives
 * and this reads it back rather than restating it. A second copy of a
 * sha256 is a second thing to forget.
 *
 * Unconditional, unlike the trees above: this one does not depend on what
 * `third_party/` holds here, because the script does not either.
 */
function luaPin() {
  try {
    const sh = readFileSync(join(ROOT, "tools", "lua53", "build.sh"), "utf8");
    const g = (k) => sh.match(new RegExp('^' + k + '="([^"]+)"', "m"))?.[1] ?? null;
    const version = g("VERSION");
    const sha = g("SHA256");
    if (!version || !sha) return null;
    return { version, sha, url: `https://www.lua.org/ftp/lua-${version}.tar.gz` };
  } catch {
    return null;
  }
}

const lua = luaPin();
if (lua !== null) {
  L.push("## `lua53`, a release tarball with a hash");
  L.push("");
  L.push("The Lua runtime, and the whole of ADR-02: norns runs **Lua " + lua.version + "**, so");
  L.push("this does. `tools/lua53/build.sh` downloads it, refuses to unpack it unless");
  L.push("the hash matches, and compiles 33 translation units to `src/lua/lua53/`.");
  L.push("No patch — nothing in it needed changing. MIT.");
  L.push("");
  L.push("```");
  L.push(lua.url);
  L.push("sha256  " + lua.sha);
  L.push("```");
  L.push("");
  L.push("Until E9-117 this was **fengari**, Lua written in JavaScript, vendored from");
  L.push("npm and patched to 64-bit integers because its own were 32-bit. The patch");
  L.push("is gone with it: Lua's integers are 64-bit, and `test/integers.test.ts` —");
  L.push("which that patch is what created — still passes.");
  L.push("");
}


if (patched.length > 0) {
  L.push("## Trees that are NOT vendored unmodified");
  L.push("");
  L.push("These carry changes this project needs and upstream has not taken. The");
  L.push("commit alone would not rebuild them, so the changes are kept here:");
  L.push("");
  for (const t of patched) {
    L.push(`### \`${t.name}\``);
    L.push("");
    L.push(`Base \`${t.commit.slice(0, 12)}\`, ${t.files.length} file(s) changed:`);
    L.push("");
    for (const f of t.files) L.push(`- \`${f}\``);
    L.push("");
    // Stated unconditionally: `--write` creates the patch in the same run,
    // and `--check` verifies it separately. Letting the document describe
    // the filesystem it is being written into made it differ between the
    // two runs and report itself as permanently stale.
    L.push("```");
    L.push(`git -C third_party/${t.name} apply ../../patches/${t.name}.patch`);
    L.push("```");
    L.push("");
  }
}

const body = L.join("\n");

if (write) {
  // The patches first, so the document never promises one that is absent.
  if (patched.length > 0) mkdirSync(PATCHES, { recursive: true });
  for (const t of patched) {
    const diff = diffOf(t.name);
    writeFileSync(join(PATCHES, `${t.name}.patch`), diff, "utf8");
    process.stdout.write(`patches/${t.name}.patch  ${(diff.length / 1024).toFixed(1)} KB\n`);
  }
  writeFileSync(OUT, body, "utf8");
  process.stdout.write(`PINS.md  ${trees.length} trees, ${patched.length} patched\n`);
} else if (check) {
  /**
   * SAY WHAT DIFFERS, not that something does.
   *
   * E9-99. `stale. Run: node tools/pins.mjs --write` was the whole of the
   * report, and it cost three round trips between two machines — because
   * the obvious answer to it REWRITES A PUBLISHED FILE from whatever this
   * machine happens to have. That is how PINS.md became a fourteen-tree
   * document with no patches recorded, and how a 698 KB patch became 0.6 KB.
   *
   * So this prints the first differing lines, and before them the thing
   * that is usually wrong: which trees are named and not here, or here and
   * not named.
   */
  function reportBody(current, wanted) {
    const inFile = new Set();
    for (const line of current.split("\n")) {
      const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
      if (m && m[1] !== "Tree") inFile.add(m[1]);
    }
    const onDisk = new Set(trees.map((t) => t.name));
    const missing = [...inFile].filter((n) => !onDisk.has(n));
    const extra = [...onDisk].filter((n) => !inFile.has(n));
    if (missing.length > 0) {
      process.stderr.write(
        `PINS.md names ${missing.length} tree(s) that are not in third_party/: ${missing.join(", ")}\n`,
      );
      process.stderr.write("  fetch them with ./tools/fetch-third-party.ps1\n");
    }
    if (extra.length > 0) {
      process.stderr.write(
        `third_party/ has ${extra.length} tree(s) PINS.md does not name: ${extra.join(", ")}\n`,
      );
    }

    if (missing.length > 0 || extra.length > 0) {
      process.stderr.write(
        "  That is the difference. Every row after it shifts, so the\n" +
          "  line-by-line comparison below is suppressed until it is fixed.\n",
      );
      return;
    }

    const a = current.split("\n");
    const b = wanted.split("\n");
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 5; i++) {
      if (a[i] === b[i]) continue;
      shown++;
      process.stderr.write(`PINS.md:${i + 1}\n`);
      process.stderr.write(`  the file says: ${a[i] === undefined ? "(no line)" : a[i]}\n`);
      process.stderr.write(`  the tree says: ${b[i] === undefined ? "(no line)" : b[i]}\n`);
    }
    if (shown === 0 && missing.length === 0 && extra.length === 0) {
      process.stderr.write("PINS.md differs only in line endings or trailing space.\n");
    }
  }

  const currentBody = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  let stale = currentBody === null || currentBody !== body;
  if (currentBody === null) process.stderr.write(`no ${OUT}\n`);
  else if (stale) reportBody(currentBody, body);
  for (const t of patched) {
    const p = join(PATCHES, `${t.name}.patch`);
    if (!existsSync(p) || readFileSync(p, "utf8") !== diffOf(t.name)) {
      process.stderr.write(`patches/${t.name}.patch is out of date\n`);
      stale = true;
    }
  }
  if (stale) {
    // NOT "run --write". That is the move this check must not invite: it
    // regenerates PUBLISHED files from this machine’s `third_party/`, and a
    // build machine’s is not the tree the document describes. Read what is
    // above, fix the tree, run this again.
    process.stderr.write(
      "\nstale. Fix the TREE rather than the document: the lines above say what\n" +
        "differs. `node tools/pins.mjs --write` rewrites PINS.md and patches/ from\n" +
        "whatever third_party/ holds here, which is right on the machine that owns\n" +
        "the pins and wrong on every other one.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`pins are current: ${trees.length} trees, ${patched.length} patched\n`);
} else {
  process.stdout.write(body + "\n");
}
