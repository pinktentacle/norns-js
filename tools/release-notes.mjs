// E9-90 — the release notes, generated from PINS.md.
//
//   node tools/release-notes.mjs <account> > ..\release-notes.md
//
// The release is where the AGPL offer actually lands: the tarball of the
// nine upstream trees that are not git clones, the two Windows binaries,
// and — the part that is only words — WHICH COMMIT of each forked tree the
// binaries were built from.
//
// Generated, because that last part is a table that already exists and has
// already gone stale once by being retyped. `PINS.md` is written by
// `tools/pins.mjs` from the trees the build actually used; this reads it
// and nothing else, so a tree added or repinned reaches the notes without
// anybody remembering.
//
// FULL COMMITS, as PINS.md carries them since E9-78: `git fetch <url> <sha>`
// refuses an abbreviation, and a pin nobody can fetch only documents.

import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const account = process.argv[2];
if (!account) {
  console.error("usage: node tools/release-notes.mjs <github-account> [--emsdk] [--no-desktop]");
  process.exit(1);
}
// emsdk is opt-in in `fork-upstreams.ps1`, so it is opt-in here: the notes
// must not advertise a fork nobody made. A compiler is a tool and not
// Corresponding Source, which is why it is a choice in the first place.
const forkedEmsdk = process.argv.includes("--emsdk");

// E9-104 — THE WINDOWS APP IS A SEPARATE DECISION FROM THE WEB BUILD, and
// the notes must not advertise a file that is not attached. The two are one
// version; they do not have to SHIP as one, and a release whose first
// section lists two .exe files that 404 is worse than one that does not
// mention them.
//
// `--no-desktop` leaves that section out. Attach the binaries later with
// `gh release upload` and regenerate these notes without the flag.
const withDesktop = !process.argv.includes("--no-desktop");

const pins = readFileSync(new URL("PINS.md", ROOT), "utf8");
const version = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")).version;

/** The generated table, one row per git tree: name, url, full sha. */
const trees = [];
for (const line of pins.split("\n")) {
  const m = /^\|\s*`([^`]+)`\s*\|\s*(https?:\/\/[^\s|]+)\s*\|\s*`([0-9a-f]{40})`(.*)\|/.exec(line);
  if (!m) continue;
  trees.push({
    name: m[1],
    url: m[2],
    commit: m[3],
    patched: /\+ patches/.test(m[4] ?? ""),
  });
}
if (trees.length === 0) {
  console.error("PINS.md has no git trees with a full commit id — run: npm run pins");
  process.exit(1);
}

/** The unpacked releases, which travel in the tarball rather than as forks. */
const releases = [];
let inReleases = false;
for (const line of pins.split("\n")) {
  if (/^## Releases/.test(line)) { inReleases = true; continue; }
  if (inReleases && /^## /.test(line)) break;
  const m = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|/.exec(line);
  if (inReleases && m && m[1] !== "Tree") releases.push({ name: m[1], what: m[2] });
}

const out = [];
out.push(`norns-js ${version} — the first public build.`);
out.push("");
out.push("**A [monome norns](https://monome.org/docs/norns/) in a browser tab**:");
out.push("the upstream norns Lua unmodified, on real SuperCollider — `sclang`");
out.push("*and* `scsynth` — compiled to WebAssembly. Scripts install from");
out.push("[norns.community](https://norns.community/) at the click of a button,");
out.push("from their authors' own repositories.");
out.push("");
out.push("Try it in a browser: **https://norns-js.pages.dev/**");
out.push("");
if (withDesktop) {
  out.push("## The Windows app");
  out.push("");
  out.push(`* \`norns-js-${version}-setup.exe\` — an installer.`);
  out.push(`* \`norns-js-${version}-portable.exe\` — one file, runs from anywhere.`);
  out.push("");
  out.push("**Neither is signed**, so Windows SmartScreen will warn you on first");
  out.push("run: *More info → Run anyway*. Signing needs a certificate, and there");
  out.push("is not one. The alternative is the browser, which needs nothing.");
  out.push("");
  out.push("Both carry their own source at `app/source/`, which the running app");
  out.push("serves at `/source/` — that is the AGPL §6 offer for a conveyed");
  out.push("binary, and it is the same tree as this repository.");
  out.push("");
} else {
  // Said rather than left silent: somebody who read about the app and
  // cannot find it should learn why in one line instead of wondering.
  out.push("## The Windows app");
  out.push("");
  out.push("Not in this release. The browser build is the whole of it for now;");
  out.push("the desktop shell is the same page in an Electron window, and it will");
  out.push("be attached here when it is built. Its source is in this repository");
  out.push("either way — `desktop/` and `electron-builder.yml` — because a");
  out.push("conveyed binary is \u00a76 of the AGPL rather than \u00a713, and the source");
  out.push("goes WITH it.");
  out.push("");
}

out.push("## Building it again");
out.push("");
out.push("`third_party/` is other projects' code and is not in the repository.");
out.push("Everything needed to put it back is here.");
out.push("");
out.push("### Forked, so the pins cannot go missing");
out.push("");
out.push("Each fork is a complete copy with its history, and each of the commits");
out.push("below was fetched back out of it by its full forty characters to prove");
out.push("it survived the copy. Where one had not, a tag `norns-js-pin` was");
out.push("pushed onto it from the tree the binaries were built from.");
out.push("");
out.push("| tree | built from | fork |");
out.push("|---|---|---|");
for (const t of trees) {
  const mark = t.patched ? " **+ patches**" : "";
  const where =
    t.name === "emsdk" && !forkedEmsdk ? `${t.url} (not forked — a toolchain, not source)` : `https://github.com/${account}/${t.name}`;
  out.push(`| \`${t.name}\`${mark} | \`${t.commit}\` | ${where} |`);
}
out.push("");
out.push("Three of them need the patches in `patches/`, which are kept as diffs");
out.push("rather than applied in place so what is ours and what is theirs stay");
out.push("separable. A diff is meaningless without the commit it applies to,");
out.push("which is why the whole forty characters are above.");
out.push("");
out.push("### Unpacked rather than cloned");
out.push("");
out.push("`norns-js-third-party.tar.gz`, attached, carries the upstream archives");
out.push("exactly as upstream shipped them:");
out.push("");
for (const r of releases) out.push(`* \`${r.name}\` — ${r.what}`);
out.push("");
out.push("## Licence");
out.push("");
out.push(`norns-js is © 2026 ${account}, free software under the`);
out.push("[GNU AGPL v3.0 or later](LICENSE). It stands on work under other terms");
out.push("— norns is monome's and is GPL-3.0, SuperCollider is GPL-3.0-or-later,");
out.push("and sixteen more are named with their licences in full in");
out.push("[`NOTICES.txt`](public/NOTICES.txt), which the running app serves at");
out.push("`/NOTICES.txt`.");
out.push("");
out.push("**No community script is in this build.** They are fetched from their");
out.push("own repositories into your own browser storage, with their authors'");
out.push("licence files beside them. [`LICENCES.md`](LICENCES.md) is why.");
out.push("");
out.push("norns-js is **not a monome product**. monome, norns, Mutable");
out.push("Instruments and all other product names are trademarks of their");
out.push("respective owners, named only to say what this is built on and what it");
out.push("works with. No affiliation or endorsement is implied.");
out.push("");
out.push("## Known");
out.push("");
out.push("**Every number in this project was measured on Chromium.** Firefox and");
out.push("Safari are untested — not believed broken, simply never opened. A");
out.push("report from either is the most useful thing anybody could send.");
out.push("");
out.push("Twenty of the catalogue's 355 scripts need something a browser cannot");
out.push("give them: a file from a GitHub release, a network reply that has to");
out.push("arrive during `init`, a MIDI device. The project panel says which, per");
out.push("script, before you install it.");

process.stdout.write(out.join("\n") + "\n");
