// E9-149 — read a trace from `?profile` and say where the time went.
//
//     node tools/profile-report.mjs <trace.json>
//
// The page prints the same summary into its own console, which is how a
// profile gets off a phone at all. This is for the file: the console
// summary is the top twelve and this can be edited to ask anything else
// of the same trace.
//
// SELF TIME IS THE RANKING. A frame high on the stack has a large total
// and tells you nothing you did not know; the leaf is where the work is.
// Total is carried beside it, since a function that is nowhere near the
// leaf and still accounts for most of the run is the other shape worth
// seeing.
//
// IDLE SAMPLES ARE NOT WORK and are excluded from the denominator, but
// counted and reported: a page that is 98% idle has not been profiled,
// it has been watched, and the percentages below would be of nothing.

import fs from "node:fs";
const t = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const span = (t.samples.at(-1).timestamp - t.samples[0].timestamp) / 1000;
const idle = t.samples.filter((s) => s.stackId === undefined).length;
console.log(`frames ${t.frames.length} stacks ${t.stacks.length} samples ${t.samples.length}`);
console.log(`wall ${span.toFixed(1)} s | idle ${idle} (${(100 * idle / t.samples.length).toFixed(1)}%)`);
const res = t.resources.map((r) => r.split("/").pop());
const nameOf = (fid) => {
  const f = t.frames[fid];
  if (!f) return "(unknown)";
  const w = f.resourceId !== undefined && res[f.resourceId] ? ` ${res[f.resourceId]}${f.line ? ":" + f.line : ""}` : "";
  return (f.name || "(anonymous)") + w;
};
const self = new Map(), total = new Map();
let n = 0;
for (const s of t.samples) {
  if (s.stackId === undefined) continue;
  n++;
  const leaf = t.stacks[s.stackId];
  if (leaf) self.set(nameOf(leaf.frameId), (self.get(nameOf(leaf.frameId)) || 0) + 1);
  const seen = new Set(); let at = s.stackId;
  while (at !== undefined) { const node = t.stacks[at]; if (!node) break;
    const nm = nameOf(node.frameId);
    if (!seen.has(nm)) { seen.add(nm); total.set(nm, (total.get(nm) || 0) + 1); }
    at = node.parentId; }
}
console.log(`\nnon-idle samples: ${n} of ${t.samples.length}  (${((n * 10) / 1000).toFixed(1)} s of CPU across ${span.toFixed(0)} s of wall)`);
console.log(`the percentages below are of those ${n}, NOT of the ${span.toFixed(0)} seconds.\n`);
console.log("SELF%  TOTAL%  frame");
[...self].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, v]) =>
  console.log(`${(100*v/n).toFixed(1).padStart(5)}  ${(100*(total.get(k)||0)/n).toFixed(1).padStart(6)}  ${k}`));
