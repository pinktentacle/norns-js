// E7-13 — which of the bundled scripts may actually be served.
//
// Running a script on your own machine is not distribution. Serving it from
// a public URL is, and a script with no licence defaults to all rights
// reserved — so the default bundle cannot simply be "everything in the
// folder" once this is deployed.
//
// This reads the tree and writes `licences.json`, which the dust build
// then uses to decide what goes into a redistributable build. It is a
// GENERATED fact rather than a list someone keeps up to date by hand,
// because the failure mode of a hand-kept list is silent: a script is added,
// nobody edits the list, and it ships anyway.
//
//   node tools/audit-licences.mjs            # print and write
//   node tools/audit-licences.mjs --check    # fail if the file is stale
//
// WHAT IT CANNOT DO. It recognises a licence by the text of a LICENSE file
// or an SPDX line; it cannot read a README that says "do what you like" in
// prose, and it does not try. Anything it cannot place comes back as NONE,
// which is the safe direction to be wrong in.

import fs from "node:fs";
import path from "node:path";

const ROOT = "community patches";
const OUT = "licences.json";

/** Recognise a licence from the first part of a file. */
function identify(text) {
  const t = text.slice(0, 4000);
  // THE TITLE, not the body. GPLv2's preamble ends by recommending "the GNU
  // Lesser General Public License" for libraries, so a search of the whole
  // text calls every GPLv2 file an LGPL one — measured, on `passthrough`.
  const title = t.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ");
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(title)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(title)) return "LGPL";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(title)) {
    if (/Version 3/i.test(title)) return "GPL-3.0";
    if (/Version 2/i.test(title)) return "GPL-2.0";
    return "GPL";
  }
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Apache License/i.test(t)) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms/i.test(t)) return "BSD";
  if (/CC0 1\.0|Creative Commons Zero/i.test(t)) return "CC0";
  if (/Creative Commons/i.test(t)) return "CC";
  if (/This is free and unencumbered software released into the public domain/i.test(t)) {
    return "Unlicense";
  }
  return "other";
}

const LICENCE_FILE = /^(licen[sc]e|copying|unlicen[sc]e)(\.(md|txt))?$/i;

function auditOne(dir) {
  const files = fs.readdirSync(dir);
  const licFile = files.find((f) => LICENCE_FILE.test(f));
  if (licFile) {
    const kind = identify(fs.readFileSync(path.join(dir, licFile), "utf8"));
    return { licence: kind, evidence: licFile };
  }
  // An SPDX line in the script itself is the other common shape.
  for (const f of files.filter((f) => f.endsWith(".lua"))) {
    const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 4000);
    const m = /SPDX-License-Identifier:\s*([A-Za-z0-9.\-+]+)/.exec(head);
    if (m) return { licence: m[1], evidence: `${f} (SPDX)` };
  }
  return { licence: "NONE", evidence: null };
}

/**
 * May this be served from a public URL?
 *
 * Everything with a recognised licence may; `other` may not, because "there
 * is a LICENSE file and I could not read it" is not permission. NONE
 * certainly may not.
 */
const REDISTRIBUTABLE = new Set([
  "AGPL-3.0",
  "LGPL",
  "GPL",
  "GPL-2.0",
  "GPL-3.0",
  "MIT",
  "Apache-2.0",
  "BSD",
  "CC0",
  "Unlicense",
]);

// `community patches/` IS NOT IN THE REPOSITORY. It is 34 scripts cloned
// for reference, gitignored, and 91 MB — so a clone of the published tree
// does not have it, and `npm run licences:check` died here with a bare
// ENOENT stack. Said rather than thrown: the file this writes IS published,
// and the only honest thing a tree without the source material can do is
// decline to check it rather than claim it passed.
if (!fs.existsSync(ROOT)) {
  const have = fs.existsSync(OUT);
  console.log(`no \`${ROOT}/\` here — nothing to audit.`);
  console.log(
    have
      ? `\`${OUT}\` is in the tree and is left alone. It is generated on the machine that has the scripts; see LICENCES.md for what it says.`
      : `\`${OUT}\` is missing too, which is a broken checkout rather than a missing directory.`,
  );
  process.exit(have ? 0 : 1);
}

const scripts = [];
for (const cat of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!cat.isDirectory()) continue;
  const catDir = path.join(ROOT, cat.name);
  for (const d of fs.readdirSync(catDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const { licence, evidence } = auditOne(path.join(catDir, d.name));
    scripts.push({
      name: d.name,
      category: cat.name,
      licence,
      evidence,
      redistributable: REDISTRIBUTABLE.has(licence),
    });
  }
}
scripts.sort((a, b) => a.name.localeCompare(b.name));

const byLicence = {};
for (const s of scripts) byLicence[s.licence] = (byLicence[s.licence] ?? 0) + 1;
const ok = scripts.filter((s) => s.redistributable);
const no = scripts.filter((s) => !s.redistributable);

const report = {
  // No timestamp: this file is committed, and a date would make every run a
  // diff. What matters is the content.
  scripts: scripts.length,
  redistributable: ok.length,
  byLicence,
  list: scripts,
};
const json = JSON.stringify(report, null, 2) + "\n";

console.log(`${scripts.length} scripts`);
for (const [k, v] of Object.entries(byLicence).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
console.log(`\n  redistributable  ${ok.length}`);
console.log(`  NOT              ${no.length}: ${no.map((s) => s.name).join(", ")}`);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== json) {
    console.error(`\n${OUT} is out of date. Run: node tools/audit-licences.mjs`);
    process.exit(1);
  }
  console.log(`\n${OUT} is up to date.`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`\nwrote ${OUT}`);
}
