// Derive WHICH `_norns` functions belong to crone, and what each one calls.
//
// The chain is three files deep and every step is a place to be wrong:
//
//   weaver.cc   lua_register_norns("level_adc", &_set_level_adc)
//   weaver.cc   _set_level_adc  reads 1 number, calls o_set_level_adc
//   oracle.cc   o_set_level_adc calls crone_set_level_adc
//   crone.h     crone_set_level_adc posts SET_LEVEL_ADC to the mixer queue
//
// Reading that by hand for 56 functions is 56 chances to bind `level_tape` to
// the tape's REVERB send, which would compile, run, and sound almost right.
//
// This does not generate the bindings: three of them are not one-to-one
// (`monitor_mix_mono` is four `crone_set_level_monitor_mix` calls with
// literal arguments). It generates the LIST, with each function's argument
// count and the calls it makes, and test/crone-lua.test.ts asserts that
// src/crone/register.ts implements exactly that list minus a named,
// explained set of exclusions. Coverage is derived; behaviour is written.
//
//   node tools/extract-crone-lua.mjs            # report
//   node tools/extract-crone-lua.mjs --write    # write src/crone/lua-surface.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEAVER = resolve(root, "third_party/norns/matron/src/weaver.cc");
const CRONE_H = resolve(root, "third_party/norns/crone/src/crone.h");
const ORACLE = resolve(root, "third_party/norns/matron/src/oracle.cc");
const OUT = resolve(root, "src/crone/lua-surface.json");

const weaver = readFileSync(WEAVER, "utf8");
const oracle = readFileSync(ORACLE, "utf8");
const croneH = readFileSync(CRONE_H, "utf8");

// ---- crone.h: which command id each crone_* posts, and to which queue ----
//
// THIS IS THE STEP THAT MOST REPAYS BEING DERIVED. The names do not line up:
//
//   crone_set_level_monitor_rev  ->  SET_LEVEL_MONITOR_AUX
//   crone_set_level_cut_rev      ->  SET_LEVEL_CUT_AUX
//
// `_norns.level_cut_rev` is the reverb send from softcut, and the command is
// called AUX. Written by hand that is either a command that does not exist
// or, worse, `SET_LEVEL_CUT` — which exists, takes different arguments, and
// would set a voice's output level instead.
const posts = new Map();
for (const m of croneH.matchAll(
  /inline void (crone_[a-z0-9_]+)\(([^)]*)\)\s*\{\s*crone::Commands::(mixer|softcut)Commands\.post\(\s*crone::Commands::Id::([A-Z0-9_]+)\s*,([^;]*)\);/g,
)) {
  const [, fn, params, queue, id, rest] = m;
  // The TYPES, not just the count. The four entry points on the wasm side
  // are _f, _if, _ii and _iif, and they differ in which union members the
  // command packet gets. `crone_set_param_cut_buffer(int, int)` and
  // `crone_set_level_cut(int, float)` both have two arguments and must not
  // go through the same one.
  const argTypes =
    params.trim() === ""
      ? []
      : params.split(",").map((p) => (p.includes("int") ? "i" : "f"));
  const argc = argTypes.length;
  const forwarded = rest.split(",").map((s) => s.trim()).filter((s) => s !== "");
  posts.set(fn, { queue, id, argc, arity: argTypes.join(""), forwarded });
}
if (posts.size < 40) {
  throw new Error(`crone.h: only ${posts.size} posting wrappers parsed; the shape changed`);
}

/** The three named-parameter dispatchers, which take a name, not an id. */
const DISPATCH = {
  crone_set_cut_param: "cut",
  crone_set_cut_param_ii: "cut_ii",
  crone_set_cut_param_iif: "cut_iif",
  crone_set_reverb_param: "reverb",
  crone_set_compressor_param: "compressor",
};

// ---- weaver.cc: the name, the symbol, and the body ----------------------

const registrations = [...weaver.matchAll(/lua_register_norns\("([a-z0-9_]+)",\s*&(_[A-Za-z0-9_]+)\)/g)].map(
  (m) => ({ name: m[1], symbol: m[2] }),
);
if (registrations.length < 170) {
  throw new Error(`weaver.cc: only ${registrations.length} registrations found; the shape changed`);
}

const bodies = new Map();
for (const m of weaver.matchAll(/^(?:static\s+)?int (_[A-Za-z0-9_]+)\(lua_State \*l\) \{([\s\S]*?)^\}/gm)) {
  bodies.set(m[1], m[2]);
}

// ---- oracle.cc: what each o_* forwards to -------------------------------

const oracleBodies = new Map();
for (const m of oracle.matchAll(/^(?:void|int|float|bool|char)\s*\**\s*(o_[a-z0-9_]+)\s*\(([^)]*)\)\s*\{([\s\S]*?)^\}/gm)) {
  oracleBodies.set(m[1], m[3]);
}
if (oracleBodies.size < 50) {
  throw new Error(`oracle.cc: only ${oracleBodies.size} o_* bodies parsed; the shape changed`);
}

/**
 * What an oracle function actually does, as one of four kinds.
 *
 * `osc` matters: `audio_pitch_on` looks like a crone function from its name
 * and is not one — `o_set_audio_pitch_on` is an `lo_send` to sclang. Binding
 * it to crone would send a command crone has no case for, which is consumed
 * and dropped in silence.
 */
function classify(oName) {
  const body = oracleBodies.get(oName);
  if (body === undefined) return { kind: "unknown", calls: [] };
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const calls = [...new Set([...stripped.matchAll(/\b(crone_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  if (calls.length > 0) return { kind: "crone", calls };
  if (/\blo_send\w*\s*\(/.test(stripped)) return { kind: "osc", calls: [] };
  if (/\bevent_post\s*\(/.test(stripped)) return { kind: "event", calls: [] };
  return { kind: "other", calls: [] };
}

// ---- join ---------------------------------------------------------------

const functions = [];
for (const { name, symbol } of registrations) {
  const body = bodies.get(symbol);
  if (body === undefined) continue; // raw tables, class methods: not these
  const oCalls = [...new Set([...body.matchAll(/\b(o_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  if (oCalls.length === 0) continue;

  const classified = oCalls.map((o) => ({ oracle: o, ...classify(o) }));
  // A function is crone's if ANY of its oracle calls reaches crone. None do
  // both, but asserting that is cheaper than assuming it.
  const croneCalls = classified.filter((c) => c.kind === "crone");
  if (croneCalls.length === 0) continue;
  if (croneCalls.length !== classified.length) {
    const mixed = classified.map((c) => `${c.oracle}:${c.kind}`).join(" ");
    throw new Error(`${name} reaches crone AND something else (${mixed}); this tool assumes it is one or the other`);
  }

  // `lua_check_num_args(N)` is how every one of these states its arity. A
  // function without it takes none — upstream relies on that rather than
  // writing `lua_check_num_args(0)`.
  const m = body.match(/lua_check_num_args\((\d+)\)/);
  const croneFns = [...new Set(croneCalls.flatMap((c) => c.calls))];

  // How this reaches crone, which is what register.ts needs to know:
  //   post      one command id on one queue, with a fixed arity
  //   dispatch  a named parameter, resolved by string in crone's own table
  //   direct    a real function in crone.cpp (polls, buffers, tape)
  // A function that posts the SAME command from several wrappers (rev_on and
  // rev_off both post SET_ENABLED_REVERB) keeps both, because the difference
  // is the literal argument and that is in oracle.cc, not here.
  let via;
  if (croneFns.every((f) => posts.has(f))) {
    via = { kind: "post", posts: croneFns.map((f) => ({ fn: f, ...posts.get(f) })) };
  } else if (croneFns.length === 1 && DISPATCH[croneFns[0]]) {
    via = { kind: "dispatch", family: DISPATCH[croneFns[0]] };
  } else {
    via = { kind: "direct" };
  }

  functions.push({
    name,
    symbol,
    args: m ? Number(m[1]) : 0,
    oracle: oCalls,
    crone: croneFns,
    via,
  });
}

functions.sort((a, b) => a.name.localeCompare(b.name));

const out = {
  generatedFrom: ["matron/src/weaver.cc", "matron/src/oracle.cc"],
  generatedBy: "tools/extract-crone-lua.mjs",
  note: "The `_norns` functions whose oracle call reaches crone. `args` is from lua_check_num_args; a function without one takes none.",
  count: functions.length,
  functions,
};

const text = JSON.stringify(out, null, 2) + "\n";

console.log(`weaver.cc: ${registrations.length} registrations, ${bodies.size} bodies`);
console.log(`oracle.cc: ${oracleBodies.size} o_* bodies`);
console.log(`crone-bound _norns functions: ${functions.length}`);
const byVia = new Map();
for (const f of functions) byVia.set(f.via.kind, (byVia.get(f.via.kind) ?? 0) + 1);
console.log("  how they reach crone: " + [...byVia].map(([k, v]) => `${k}:${v}`).join("  "));
const byArity = new Map();
for (const f of functions) byArity.set(f.args, (byArity.get(f.args) ?? 0) + 1);
console.log(
  "  by argument count: " +
    [...byArity.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  "),
);

if (process.argv.includes("--write")) {
  writeFileSync(OUT, text);
  console.log(`wrote src/crone/lua-surface.json`);
} else {
  let existing = "";
  try {
    existing = readFileSync(OUT, "utf8");
  } catch {
    /* not written yet */
  }
  if (existing !== text) {
    console.error("src/crone/lua-surface.json is stale — run `npm run crone:lua`");
    process.exit(1);
  }
  console.log("src/crone/lua-surface.json is up to date");
}
