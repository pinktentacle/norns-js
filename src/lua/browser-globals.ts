// The two globals fengari reads before it will load in a browser.
//
// Fengari is a Node-shaped CommonJS package: it reads `process` while it
// initialises, and a browser has none, so it throws before exporting
// anything. The error is `ReferenceError: process is not defined` from inside
// a Vite-optimised bundle, which says nothing about Lua at all.
//
// This is deliberately the smallest thing that gets past that — not a
// polyfill library — because the alternative was the authors' separate
// `fengari-web` build, which would mean the browser and the tests running
// different copies of the Lua interpreter. One interpreter, one shim. See
// src/lua/shims/README.md for the module-level aliases that go with it.
//
// IMPORT THIS FIRST, before anything that reaches fengari. Static imports
// execute in source order, so `import "./browser-globals.js"` at the top of a
// page module runs before the import that pulls fengari in. A dynamic import
// of the host after this module is also fine; the other order is not.
//
// Safe to import more than once: both globals are only installed if absent.

const g = globalThis as unknown as Record<string, unknown>;

if (g["process"] === undefined) {
  // stdout/stderr go to the console rather than being dropped: Lua's
  // `io.write` reaches them, and silence there would be a debugging trap.
  g["process"] = {
    env: {},
    argv: [],
    platform: "browser",
    version: "",
    versions: {},
    cwd: () => "/",
    exit: () => {},
    on: () => {},
    nextTick: (f: () => void) => {
      void Promise.resolve().then(f);
    },
    stdout: {
      write: (s: unknown) => {
        console.log(String(s).replace(/\n$/, ""));
        return true;
      },
      isTTY: false,
    },
    stderr: {
      write: (s: unknown) => {
        console.warn(String(s).replace(/\n$/, ""));
        return true;
      },
      isTTY: false,
    },
  };
}

// Fengari reaches Buffer by the GLOBAL name, not through require("buffer"),
// so the module alias in vite.config.ts does not reach it. Two places matter
// and they want different methods:
//
//   lbaselib.js:115  Buffer.from(...)    wrapping print's output
//   lauxlib.js:905   Buffer.alloc(1024)  the read buffer loadfile uses
//
// The second one cost a confusing failure: without `alloc`, constructing the
// loader threw, fengari turned that into a load error, and the Lua message
// was nothing but the filename — so boot died on `core/screen.lua:13`
// reporting `/home/we/dust/data/system.display` and nothing else.
if (g["Buffer"] === undefined) {
  g["Buffer"] = {
    alloc: (n: number) => new Uint8Array(n),
    allocUnsafe: (n: number) => new Uint8Array(n),
    from: (v: unknown) => {
      if (typeof v === "string") return new TextEncoder().encode(v);
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      return Uint8Array.from(v as ArrayLike<number>);
    },
    concat: (list: Uint8Array[]) => {
      const total = list.reduce((a, b) => a + b.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const b of list) {
        out.set(b, at);
        at += b.length;
      }
      return out;
    },
    byteLength: (s: unknown) => new TextEncoder().encode(String(s)).length,
    isBuffer: (v: unknown) => v instanceof Uint8Array,
  };
}

export {};
