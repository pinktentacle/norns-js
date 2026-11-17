// `tmp` — fengari uses it inside `os.tmpname`, which norns never calls. The
// real package is Node-only: it reads the legacy `constants` module and opens
// files through `fs`.
//
// Permissive no-op, for the same reason as readline-sync.ts: anything that
// throws while a module is loading takes the page with it, and this package
// is reached at import time. `os.tmpname()` therefore returns nil in Lua,
// which is a failure Lua can describe.
const noop = (): undefined => undefined;

const permissive = new Proxy(
  {},
  {
    get: () => noop,
    has: () => true,
  },
) as Record<string, () => undefined>;

export default permissive;
export const tmpNameSync = noop;
export const fileSync = noop;
