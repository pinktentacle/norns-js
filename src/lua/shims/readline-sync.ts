// `readline-sync` — fengari uses it for the interactive `debug.debug()`
// prompt, which reads a terminal's stdin. There is none here, and norns never
// enters the Lua debugger.
//
// This is a permissive no-op rather than a throwing stub, and the reason is
// worth stating: `ldblib.js:474` calls `setDefaultOptions` while the MODULE
// LOADS, not when the debugger is entered. A stub that throws on an unknown
// member therefore takes the whole page down during import, and the error
// names a JavaScript package instead of the Lua feature. Adding members one
// at a time is worse — each one costs a dependency re-optimisation to
// discover the next.
//
// So: every member is a function that does nothing and returns undefined. If
// Lua ever genuinely reaches `debug.debug()`, it gets nil back and fails on
// the Lua side, where the message will at least name `debug`.
const noop = (): undefined => undefined;

const permissive = new Proxy(
  {},
  {
    get: () => noop,
    has: () => true,
  },
) as Record<string, () => undefined>;

export default permissive;
export const setDefaultOptions = noop;
export const question = noop;
export const prompt = noop;
