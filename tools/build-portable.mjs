// Assemble the portable copy: a folder that runs norns-js on another machine
// with nothing installed but Node.
//
//   node tools/build-portable.mjs            # -> build-portable/norns-js
//
// WHY A SCRIPT rather than a few copies by hand. The first archive was built
// by hand, and the README that explains it ended up living only inside the
// output folder -- which is gitignored, because it is a build product. One
// clean and the document the user reads on the other machine would have been
// gone. The canonical README is PORTABLE.md at the repository root; this
// copies it in. AT THE ROOT and not under docs/, which is export-ignored:
// this script is published, the desktop build needs it, and a build that
// cannot run from the published source is not corresponding source (E9-129).
//
// WHAT GOES IN, and why there are three parts:
//
//   app/      the built page. `vite build` output, which is the whole
//             instrument: the wasm, the worklets, the fonts, the dust tree.
//   serve.mjs the only way to run it. See its own header: cross-origin
//             isolation is not optional, and file:// cannot grant it.
//   app/source/
//             the corresponding source, because norns-js is AGPL and the
//             page above is a conveying of it. INSIDE the served tree, not
//             beside it: the built page offers its source at `./source/`,
//             and a sibling folder outside the server's root is a link that
//             404s. That was measured on the first archive, where it did.
//             NOT the vendored upstream trees or the prebuilt wasm, which
//             are large and come from their own projects -- the full working
//             tree is the complete corresponding source, and the README
//             says so.

import { chmod, cp, mkdir, readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, process.argv[2] ?? "build-portable/norns-js");
const skipBuild = process.argv.includes("--no-build");

async function size(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += (await stat(join(e.parentPath ?? e.path, e.name))).size;
  }
  return total;
}

// NOBODY ELSE'S WORK GOES IN, and this is where that is enforced.
//
// `public/` is copied into the build wholesale, and a development `public/`
// holds whatever was installed while testing -- 18 MB of other people's
// scripts and samples when this was written, including a nine-megabyte
// sampled break. The archive states that it ships none of that, and that
// has to be true: of the scripts this project tested with, seventeen of
// thirty-five carry no licence at all, which means all rights reserved.
//
// The build output is PRUNED rather than the development tree moved aside.
// Moving it was tried first and was a mistake twice over: `fs.rename` on a
// watched directory fails with EPERM on Windows, and a stash is a second
// place for the only copy of something to live. Pruning touches nothing but
// the archive.
//
// WHAT PRUNING MEANS. Everything under `/home/we/dust/code/` is somebody
// else's script and goes; everything under `/home/we/dust/audio/` is the
// stock sample library, which E9-41 SYNTHESISES (tools/kit-808.mjs) and
// which is therefore ours to ship. It stays, and it has to: the archive
// carries no scripts, so the scripts that reach it are installed from the
// catalogue — and `bakeneko` reads that directory on its first tick and
// dies in `init` if it is empty. Pruning it would ship a build in which an
// installed script breaks for a reason nothing in the build could explain.
//
// Anything that is NEITHER stops the build, because a third kind of entry
// is either a licence question or a mistake, and both deserve a person.
const KEEP = "/home/we/dust/audio/";
const DROP = "/home/we/dust/code/";

async function pruneScripts(app) {
  const before = await size(app);
  // `dust-bin/` is one directory per script, plus `_stock/` for the kit.
  const bin = join(app, "dust-bin");
  if (existsSync(bin)) {
    for (const e of await readdir(bin)) {
      if (e === "_stock") continue;
      await rm(join(bin, e), { recursive: true, force: true });
    }
  }
  for (const f of ["dust.json", "dust-assets.json"]) {
    const target = join(app, f);
    if (!existsSync(target)) continue;
    const all = JSON.parse(await readFile(target, "utf8"));
    const strange = Object.keys(all).filter((k) => !k.startsWith(DROP) && !k.startsWith(KEEP));
    if (strange.length > 0) {
      // Someone has added something to the dust tree that is neither a
      // script nor ours. Stop rather than silently ship it or silently
      // drop it.
      throw new Error(
        `${f}: ${strange.length} entries outside dust/code and dust/audio ` +
          `(${strange[0]}) — prune rule is stale`,
      );
    }
    const kept = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith(KEEP)) kept[k] = v;
    await writeFile(target, JSON.stringify(kept));
  }
  return before - (await size(app));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

if (!skipBuild) run("npx", ["vite", "build"]);

const SRC = join(OUT, "app", "source");

await rm(OUT, { recursive: true, force: true });
await cp(join(ROOT, "dist"), join(OUT, "app"), { recursive: true });
const pruned = await pruneScripts(join(OUT, "app"));
await mkdir(SRC, { recursive: true });
await cp(join(ROOT, "tools/serve.mjs"), join(OUT, "serve.mjs"));
// E9-227 — serve.mjs imports the GitHub release relay from beside itself.
await cp(join(ROOT, "tools/gh-release.mjs"), join(OUT, "gh-release.mjs"));
// Two servers, because two machines have different things installed: Node
// on a desktop, Python on a Steam Deck (whose root filesystem is immutable,
// so installing Node there does not survive an update). Both send the two
// headers and nothing else does.
await cp(join(ROOT, "tools/serve.py"), join(OUT, "serve.py"));
await cp(join(ROOT, "tools/steamdeck/norns-js.sh"), join(OUT, "norns-js.sh"));
await chmod(join(OUT, "norns-js.sh"), 0o755);
await cp(join(ROOT, "PORTABLE.md"), join(OUT, "README.md"));

// THE SAME SOURCE THE REPOSITORY PUBLISHES, cut the same way.
//
// E9-85. This used to copy a hand-kept list — src, tools, docs, four files —
// and that list was wrong in both directions. It carried `docs/`, which is
// working material and is export-ignored from the published tree; and it
// left out `patches/`, `PINS.md`, `LICENCES.md` and `package-lock.json`,
// without which the thing it calls "the corresponding source" cannot be
// rebuilt at all. A tree that cannot be built is not Corresponding Source,
// it is a gesture.
//
// `git archive HEAD` is what `.gitattributes` decides, which is what the
// repository publishes. One filter, three consumers: the public repository,
// the release tarball, and this. They cannot disagree because they are the
// same command.
//
// COMMITTED CONTENT ONLY, which is right for something being conveyed: a
// binary that offers a source tree with somebody's uncommitted edits in it
// is offering a tree that exists nowhere else.
await mkdir(SRC, { recursive: true });
{
  // THE TARBALL LANDS IN `SRC` AND IS EXTRACTED BY ITS BARE NAME, which
  // looks like fussiness and is not. Windows has two tars on it:
  // its own bsdtar, and GNU tar if Git for Windows is on PATH first.
  // GNU tar reads `C:/...` as HOST:PATH and tries to open an rsh
  // connection — `tar: Cannot connect to C: resolve failed`, which is a
  // failure that says nothing about the real problem. `--force-local`
  // fixes GNU tar and bsdtar rejects it, so there is no flag that works on
  // both. Giving neither of them a colon is the fix that does: `cwd` sets
  // where, and the name has no drive letter in it.
  const tarName = "source.tar";
  const tar = join(SRC, tarName);
  const ar = spawnSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (ar.status !== 0) throw new Error("git archive failed; is this a checkout?");
  const ex = spawnSync("tar", ["-xf", tarName], { cwd: SRC, stdio: "inherit" });
  if (ex.status !== 0) throw new Error("tar -xf failed");
  await rm(tar);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
process.stdout.write(
  `portable copy: ${OUT}\n` +
    `  app      ${mb(await size(join(OUT, "app")))}  (source included)\n` +
    `  source   ${mb(await size(SRC))}\n` +
    `  left out ${mb(pruned)} of scripts and samples\n` +
    `  run it:  node serve.mjs\n`,
);
