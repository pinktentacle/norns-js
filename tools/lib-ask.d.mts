// Types for `lib-ask.mjs`, which is a tool and stays JavaScript: the
// generator it belongs to runs under plain node, with no build step.
// `test/lib-ask.test.ts` is what makes the rules measured, and it needs
// these to compile.

/** What `include` searches beyond the script's folder and `~/dust/code`. */
export const INCLUDE_ROOTS: readonly string[];
/** What `require` searches, from `core/config.lua`'s package.path. */
export const REQUIRE_PREFIXES: readonly string[];

/** Does norns' own Lua tree answer this ask? */
export function nornsAnswers(
  keyword: "include" | "require",
  target: string,
  has: (name: string) => boolean,
): boolean;

/** Is the ask behind a guard the script writes, naming the library? */
export function isGuarded(file: string, source: string, head: string): boolean;
