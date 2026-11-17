// Derive crone's command ids from Commands.h.
//
// WHY A TOOL AND NOT A TYPED-OUT TABLE: the id that crosses into wasm is the
// ENUM VALUE — an ordinal. `Commands::Id` is a plain unscoped enum with no
// explicit values, so every id is its POSITION in the list. Insert one
// command upstream and every id after it shifts. A hand-written table would
// still compile, still run, and quietly set the wrong level.
//
// This is the same rule as tools/extract-api.mjs and tools/extract-fonts.mjs:
// anything that is an index into something upstream maintains gets read from
// upstream, every build.
//
//   node tools/extract-crone-commands.mjs            # writes src/crone/commands.ts
//   node tools/extract-crone-commands.mjs --check    # fails if it is stale

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER = resolve(root, "third_party/norns/crone/src/Commands.h");
const OUT = resolve(root, "src/crone/commands.ts");

const src = readFileSync(HEADER, "utf8");

// The enum is `typedef enum { ... } Id;` inside `class Commands`.
const open = src.indexOf("typedef enum {");
if (open < 0) throw new Error("Commands.h: no `typedef enum {` — the shape changed");
const close = src.indexOf("} Id;", open);
if (close < 0) throw new Error("Commands.h: enum is not closed by `} Id;` — the shape changed");
const body = src.slice(open + "typedef enum {".length, close);

// Strip comments BEFORE splitting: upstream's `// level of stereo ext out ->
// stereo cut in` contains no comma, but a block comment could.
const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const names = [];
for (const raw of stripped.split(",")) {
  const name = raw.trim();
  if (name === "") continue;
  if (/=/.test(name)) {
    // An explicit value would break the position=id assumption this whole
    // file rests on. Refuse rather than emit something plausible.
    throw new Error(`Commands.h: ${name} has an explicit value; ids are no longer positional`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Commands.h: unexpected entry ${JSON.stringify(name)}`);
  names.push(name);
}
if (names.length < 20) throw new Error(`Commands.h: only ${names.length} ids found; expected the full list`);

// WHICH QUEUE each id belongs to is not in the enum. There are two command
// queues -- `Commands::mixerCommands` and `Commands::softcutCommands` -- and
// an id belongs to whichever client's `handleCommand` has a `case` for it.
// Getting it wrong is SILENT: the other client's switch simply has no case,
// so the command is dequeued and dropped. So that is read too, from the two
// switch statements, rather than decided here.
const handlers = {
  mixer: resolve(root, "third_party/norns/crone/src/MixerClient.cpp"),
  softcut: resolve(root, "third_party/norns/crone/src/SoftcutClient.cpp"),
};
const queueOf = new Map();
for (const [queue, file] of Object.entries(handlers)) {
  const text = readFileSync(file, "utf8");
  const fn = text.indexOf("::handleCommand");
  if (fn < 0) throw new Error(`${file}: no handleCommand`);
  for (const m of text.slice(fn).matchAll(/case\s+Commands::Id::([A-Z0-9_]+)\s*:/g)) {
    const name = m[1];
    const seen = queueOf.get(name);
    if (seen && seen !== queue) throw new Error(`${name} is handled by both ${seen} and ${queue}`);
    queueOf.set(name, queue);
  }
}
const unhandled = names.filter((n) => !queueOf.has(n));

const lines = names
  .map((n, i) => `  ${n}: { id: ${i}, queue: ${JSON.stringify(queueOf.get(n) ?? null)} },`)
  .join("\n");
// The PARAMETER names, and which of the three arities each one takes.
//
// This is not convenience. `crone_set_cut_param` looks its name up with
// `std::map::at` and catches `std::out_of_range` — and this build compiles
// WITHOUT exceptions, because it runs in an audio callback. A catch that is
// compiled away does not catch: upstream's one line of defence against a
// mistyped name becomes an abort of the whole audio engine, with a bare
// number for a message. (Measured: `crone_cut_param("buffer", ...)` — a real
// name, in the wrong family — aborted with `155138736` and nothing else.)
//
// So the names cross this boundary checked. The alternative, `-fexceptions`,
// would pay for the whole program's unwind tables to survive a typo.
const DISPATCH = resolve(root, "third_party/norns/crone/src/crone_param_dispatch.cpp");
const dispatch = readFileSync(DISPATCH, "utf8");

// Each family is one `std::map<...> NAME = { {"a", f}, ... };`
const FAMILIES = {
  cut_param_fn_map: "f",
  cut_param_fn_map_ii: "ii",
  cut_param_fn_map_iif: "iif",
  reverb_param_fn_map: "reverb",
  compressor_param_fn_map: "compressor",
};
const params = {};
for (const [symbol, family] of Object.entries(FAMILIES)) {
  // Anchor on the declaration, then take up to the `};` that closes it.
  const at = dispatch.indexOf(`${symbol} =`);
  if (at < 0) throw new Error(`crone_param_dispatch.cpp: no ${symbol} — the shape changed`);
  const end = dispatch.indexOf("};", at);
  const body = dispatch.slice(at, end);
  let n = 0;
  for (const m of body.matchAll(/\{\s*"([a-z0-9_]+)"\s*,/g)) {
    if (params[m[1]] && params[m[1]] !== family) {
      throw new Error(`${m[1]} is in both ${params[m[1]]} and ${family}`);
    }
    params[m[1]] = family;
    n++;
  }
  if (n === 0) throw new Error(`crone_param_dispatch.cpp: ${symbol} parsed to nothing`);
}
const paramLines = Object.entries(params)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join("\n");
const paramCount = Object.keys(params).length;

const out = `// GENERATED by tools/extract-crone-commands.mjs — do not edit.
//
// crone's \`Commands::Id\`, read from third_party/norns/crone/src/Commands.h.
// The value is the enum's POSITION, which is what crosses into wasm; see the
// tool for why this is derived rather than written.
//
// ${names.length} commands; ${names.length - unhandled.length} with a handler.
// A null queue means no client has a \`case\` for that id: upstream can post
// it and nothing consumes it.${unhandled.length ? " Here: " + unhandled.join(", ") + "." : ""}

export const CommandId = {
${lines}
} as const;

export type CommandName = keyof typeof CommandId;
/** Which of crone's two command queues consumes an id. */
export type CommandQueue = "mixer" | "softcut";

/**
 * crone's named parameters, and WHICH ENTRY POINT each one takes.
 *
 * ${paramCount} names, read from crone_param_dispatch.cpp. The family matters as
 * much as the name: \`buffer\` is a real softcut parameter, but it lives in
 * the (int, int) map, and sending it through the (int, float) one looks it up
 * in a map that does not have it. Upstream catches that; this build has
 * exceptions off, so it aborts instead. Check here, not there.
 */
export const CutParamFamily = {
${paramLines}
} as const;

export type ParamName = keyof typeof CutParamFamily;
`;

if (process.argv.includes("--check")) {
  const existing = (() => {
    try {
      return readFileSync(OUT, "utf8");
    } catch {
      return "";
    }
  })();
  if (existing !== out) {
    console.error("src/crone/commands.ts is stale — run node tools/extract-crone-commands.mjs");
    process.exit(1);
  }
  console.log(`crone commands: ${names.length}, up to date`);
} else {
  writeFileSync(OUT, out);
  console.log(`crone commands: wrote ${names.length} ids to src/crone/commands.ts`);
}
