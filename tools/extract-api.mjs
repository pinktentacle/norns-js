// E1-03 — derive the `_norns` surface from matron's own source.
//
// Why a tool and not a checked-in list: `research/api-surface.md` was built
// with `grep -oE 'lua_register_norns\("[a-z_0-9]+"'` and **missed four
// functions**, because they are registered through a `luaL_Reg` table literal
// rather than a direct call (p1-api-plan.md §0.1). A hand-maintained list is a
// list that drifts from the C the first time upstream adds a function. This
// reads `weaver.cc` and fails loudly if anything stops matching.
//
// It derives three things, each from the source rather than from our prose:
//
//   1. the names, from BOTH registration paths;
//   2. the C symbol each name is bound to, so `arc_all_led`'s
//      `return _grid_all_led(l);` is visible as the alias it is;
//   3. **how many values each function returns**, from the `return N;`
//      statements in its body. That is the §4 contract table, measured. A
//      function with returns {0} pushes nothing; {1} pushes one value; {1,2}
//      has conditional arity and is a trap (`system_glob`).
//
// Usage:
//   node tools/extract-api.mjs            # report to stdout
//   node tools/extract-api.mjs --write    # also write src/api/surface.json
//
// Exits non-zero if the counts do not match what this project has verified.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEAVER = path.join(ROOT, "third_party/norns/matron/src/weaver.cc");
const OUT = path.join(ROOT, "src/api/surface.json");

// Verified in this repo, and the reason the tool exits non-zero if they move.
// 174 direct `lua_register_norns("name", …)` call sites, no duplicates, plus
// the 4 in `_image_functions`.
const EXPECT = { direct: 174, viaTable: 4, total: 178 };

const src = fs.readFileSync(WEAVER, "utf8");

// ---------------------------------------------------------------- helpers --

/** Line number (1-based) of a character offset, for error messages. */
function lineAt(offset) {
  return src.slice(0, offset).split("\n").length;
}

/**
 * Body of a C function, by brace matching from its opening `{`.
 * Returns null if the braces do not balance, which is itself worth reporting.
 */
function bodyFrom(openBrace) {
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openBrace + 1, i);
    } else if (c === '"' || c === "'") {
      // Skip string and char literals so a brace inside one cannot unbalance us.
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i === 0) return null;
    }
  }
  return null;
}

/**
 * Find `int <symbol>(…) { … }` and return its body.
 *
 * The parameter list is matched loosely on purpose: the bindings themselves
 * take `(lua_State *l)`, but several of them tail-call a helper with a wider
 * signature — `poll_set_state(lua_State *l, bool start)`,
 * `_push_port_list(lua_State *l, const char **list)` — and the contract we are
 * after lives in the helper, not in the one-line binding.
 *
 * A forward declaration ends in `;` and so never matches the trailing `{`.
 */
function functionBody(symbol) {
  const re = new RegExp(`\\b(?:static\\s+)?int\\s+${symbol}\\s*\\([^;{]*\\)\\s*\\{`, "g");
  const m = re.exec(src);
  if (!m) return null;
  return bodyFrom(m.index + m[0].length - 1);
}

/**
 * The set of values this function returns to Lua.
 *
 * `return N;` is the number of values pushed. `return <call>(l);` is a tail
 * call to another binding — `arc_all_led` is `return _grid_all_led(l);` — so
 * we record the alias and resolve it afterwards rather than guessing.
 */
function returnsOf(symbol, seen = new Set()) {
  if (seen.has(symbol)) return { values: [], alias: null, note: "recursive" };
  seen.add(symbol);

  const body = functionBody(symbol);
  if (body == null) return { values: [], alias: null, note: "body not found" };

  // A tail call to another function, which is how several bindings are
  // written: `arc_all_led` is `return _grid_all_led(l);`, `start_poll` is
  // `return poll_set_state(l, true);`. The callee may take extra arguments and
  // need not be an underscore-prefixed binding.
  //
  // `luaL_error` and `lua_error` are NOT delegations. They never return — they
  // longjmp out — and C merely requires the `return` keyword in front of them.
  // Treating one as an alias would have given `crow_send`, `serial_send` and
  // `send_command` a contract taken from the error path instead of their real
  // `return 0;`.
  const ERRORS = new Set(["luaL_error", "lua_error", "luaL_argerror", "luaL_typeerror"]);
  const tails = [...body.matchAll(/return\s+(\w+)\s*\(\s*\w+\s*(?:,[^;]*?)?\)\s*;/g)]
    .map((m) => m[1])
    .filter((name) => !ERRORS.has(name));
  const numeric = [...body.matchAll(/return\s+(-?\d+)\s*;/g)].map((m) => Number(m[1]));

  // A body can have BOTH — an early `return 0;` bail-out and a tail call on
  // the success path. `_screen_create_image` is exactly that: it returns
  // nothing when the allocation fails and delegates to `_image_new` when it
  // does not. Taking the numeric alone would have declared it silent, and the
  // stub built from that would have left `Screen.draw_to` calling a method on
  // nil. The contract is the UNION.
  if (tails.length) {
    const uniq = [...new Set(tails)];
    if (uniq.length > 1) {
      return { values: [], alias: null, note: `delegates to several: ${uniq.join(", ")}` };
    }
    const inner = returnsOf(uniq[0], seen);
    const values = [...new Set([...numeric, ...inner.values])].sort((a, b) => a - b);
    return { values, alias: uniq[0], note: inner.note };
  }
  return { values: [...new Set(numeric)].sort((a, b) => a - b), alias: null, note: null };
}

// ------------------------------------------------------- the two registries --

const direct = [];
// `lua_register_norns("name", &_fn)` — the definition itself and the loop
// inside lua_register_norns_class do not match, because neither has a string
// literal in that position.
for (const m of src.matchAll(/lua_register_norns\s*\(\s*"([a-z_0-9]+)"\s*,\s*&?\s*(\w+)\s*\)/g)) {
  direct.push({ name: m[1], symbol: m[2], line: lineAt(m.index), via: "call" });
}

/** Parse a `static luaL_Reg <id>[…] = { {"name", fn}, …, {NULL, NULL} };` */
function parseRegTable(id) {
  const re = new RegExp(`static\\s+luaL_Reg\\s+${id}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{`, "g");
  const m = re.exec(src);
  if (!m) return null;
  const body = bodyFrom(m.index + m[0].length - 1);
  if (body == null) return null;
  const entries = [];
  for (const e of body.matchAll(/\{\s*"([^"]+)"\s*,\s*(\w+)\s*\}/g)) {
    entries.push({ name: e[1], symbol: e[2] });
  }
  return { entries, line: lineAt(m.index) };
}

// Find every `lua_register_norns_class(class, methods, functions)` and take
// its third argument: those are module-level functions on `_norns`.
const viaTable = [];
const classMethods = [];
for (const m of src.matchAll(/lua_register_norns_class\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g)) {
  const [, className, methodsId, functionsId] = m;
  const fns = parseRegTable(functionsId);
  const mts = parseRegTable(methodsId);
  if (!fns) {
    console.error(`could not parse the luaL_Reg table "${functionsId}" at line ${lineAt(m.index)}`);
    process.exit(1);
  }
  for (const e of fns.entries) {
    viaTable.push({ ...e, line: fns.line, via: `class:${className}` });
  }
  if (mts) {
    classMethods.push({ class: className, line: mts.line, methods: mts.entries });
  }
}

const all = [...direct, ...viaTable];

// ------------------------------------------------------------- the checks --

const problems = [];
const byName = new Map();
for (const f of all) {
  if (byName.has(f.name)) {
    problems.push(`duplicate registration: ${f.name} (lines ${byName.get(f.name).line} and ${f.line})`);
  }
  byName.set(f.name, f);
}
if (direct.length !== EXPECT.direct) {
  problems.push(`expected ${EXPECT.direct} direct registrations, found ${direct.length}`);
}
if (viaTable.length !== EXPECT.viaTable) {
  problems.push(`expected ${EXPECT.viaTable} table-literal registrations, found ${viaTable.length}`);
}
if (all.length !== EXPECT.total) {
  problems.push(`expected ${EXPECT.total} functions in total, found ${all.length}`);
}

// ------------------------------------------------- derive return contracts --

for (const f of all) {
  const r = returnsOf(f.symbol);
  f.returns = r.values;
  if (r.alias) f.aliasOf = r.alias;
  if (r.note) f.returnNote = r.note;
  if (r.values.length === 0 && !r.note) {
    problems.push(`${f.name} (${f.symbol}): no 'return N;' found — cannot derive its contract`);
  }
}

// ------------------------------------------------------------------ report --

const nothing = all.filter((f) => f.returns.length === 1 && f.returns[0] === 0);
const single = all.filter((f) => f.returns.length === 1 && f.returns[0] === 1);
const multi = all.filter((f) => f.returns.length === 1 && f.returns[0] > 1);
const conditional = all.filter((f) => f.returns.length > 1);
const aliases = all.filter((f) => f.aliasOf);

console.log(`weaver.cc: ${src.split("\n").length} lines`);
console.log(`  direct lua_register_norns("…")      ${direct.length}`);
console.log(`  via luaL_Reg table literals         ${viaTable.length}   ${viaTable.map((f) => f.name).join(", ")}`);
console.log(`  total                               ${all.length}`);
console.log();
console.log("return contracts, derived from the C:");
console.log(`  push nothing (return 0)             ${nothing.length}`);
console.log(`  push one value                      ${single.length}`);
console.log(`  push several                        ${multi.length}   ${multi.map((f) => `${f.name}:${f.returns[0]}`).join(", ")}`);
console.log(`  CONDITIONAL arity                   ${conditional.length}   ${conditional.map((f) => `${f.name}:{${f.returns}}`).join(", ")}`);
console.log(`  tail-call aliases                   ${aliases.length}   ${aliases.map((f) => `${f.name} -> ${f.aliasOf}`).join(", ")}`);
console.log();
for (const c of classMethods) {
  console.log(`class ${c.class} (line ${c.line}): ${c.methods.map((m) => m.name).join(", ")}`);
}

if (problems.length) {
  console.error("\nPROBLEMS");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("\nOK — the surface matches what this project has verified.");

if (process.argv.includes("--write")) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const payload = {
    generatedFrom: "third_party/norns/matron/src/weaver.cc",
    generatedBy: "tools/extract-api.mjs",
    note: "Do not edit by hand. Run `node tools/extract-api.mjs --write`.",
    counts: { direct: direct.length, viaTable: viaTable.length, total: all.length },
    classes: classMethods,
    functions: all
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, symbol, line, via, returns, aliasOf }) => ({
        name, symbol, line, via, returns, ...(aliasOf ? { aliasOf } : {}),
      })),
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}
