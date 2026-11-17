// E9-70 — when an `include`/`require` of somebody else's folder is NOT a
// blocker.
//
// `build-blockers.mjs` reported ten of these and every one of them was
// wrong. Measured, all ten, with the library deliberately absent and then
// deliberately present: eight of the scripts ran either way, and the two
// that did not failed for reasons that had nothing to do with the library
// (cheat_codes_2 on its own MIDI loop, shnthsalslied on an engine class its
// repository does not publish). Two notes were false outright and six were
// true about the catalogue and false about the script.
//
// So there are two questions the old rule never asked, and this file is
// both of them.
//
//   1. Does NORNS ITSELF answer this? `sky` and `container` are not
//      libraries anybody installs — they are in the norns image, and the
//      rule only knew about the catalogue and our dust bundle.
//
//   2. Does the SCRIPT decide whether to ask? Every one of the other six
//      sits behind an explicit guard: a mod that has to be enabled, a
//      folder the script tests for, a device that has to be plugged in,
//      a constant that ships `false`.
//
// Exported and pure so the rules can be measured against the real lines
// rather than asserted — `test/lib-ask.test.ts` feeds them the guards as
// they are written in the eight repositories.

/**
 * What `include` searches, after the script's own folder and `~/dust/code`.
 *
 * `core/startup.lua:53` — `{norns.state.path, _path.code, _path.extn}` —
 * and `core/config.lua:24` makes `_path.extn` `~/norns/lua/extn/`. That is
 * the whole list: `include` does NOT see `lua/lib`, which is why this is a
 * different set from the one below.
 */
export const INCLUDE_ROOTS = ["extn/"];

/**
 * What `require` searches, from `core/config.lua:16`'s package.path.
 *
 * Lua keeps a literal `/` in a module name, so `require('container/deque')`
 * tries each of these with `container/deque.lua` appended — and the fifth
 * one, `lua/lib/`, is where norns keeps it.
 */
export const REQUIRE_PREFIXES = ["", "core/", "engine/", "core/params/", "lib/", "softcut/"];

/**
 * Does norns' own Lua tree answer this ask?
 *
 * `has(name)` says whether `third_party/norns/lua/<name>.lua` is in the
 * tree. `keyword` matters: `include` and `require` look in different
 * places, and reading `lua/lib` into `include` would hide a real failure.
 */
export function nornsAnswers(keyword, target, has) {
  const roots = keyword === "include" ? INCLUDE_ROOTS : REQUIRE_PREFIXES;
  return roots.some((r) => has(r + target));
}

/**
 * Is the ask behind a guard the script itself writes?
 *
 * Three shapes, each exact and each taken from a real script rather than
 * imagined:
 *
 *   lib/mod.lua                      the file IS a mod, and `core/mods.lua`
 *                                    only `require`s a mod that is enabled
 *                                    (`Mods.load_enabled`). cyrene and
 *                                    fixed-filter-banking-crisis.
 *
 *   _mods.is_enabled('z_tuning')     the script asks the mod system first.
 *                                    sines.
 *
 *   util.file_exists(_path.code..    the script asks the filesystem first.
 *     "namesizer")                   cheat_codes_2.
 *
 * The head has to be NAMED in the guard. A bare `if x then` around a
 * require is not evidence of anything, and the two scripts whose guard is
 * of that kind are measured by hand in `build-blockers.mjs` instead.
 */
export function isGuarded(file, source, head) {
  if (/(^|\/)lib\/mod\.lua$/.test(file)) return true;
  // Only a plain name, which every library head is. Anything else is not
  // something to build a regular expression out of.
  if (!/^[A-Za-z0-9_-]+$/.test(head)) return false;
  if (new RegExp(`is_enabled\\s*\\(\\s*["']${head}["']`, "i").test(source)) return true;
  if (new RegExp(`file_exists\\s*\\([^)]*["']${head}["']`, "i").test(source)) return true;
  return false;
}
