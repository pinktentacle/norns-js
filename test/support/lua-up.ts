// E9-117 — the interpreter, up once for the whole suite.
//
// fengari was a JavaScript module: importing it was having it. PUC Lua is
// wasm and has to be instantiated, which is asynchronous, so something has
// to await it before the first `luaL_newstate`. Nineteen test files create a
// state; this is the one line that serves them all, from `setupFiles` in
// `vite.config.ts`, rather than nineteen `beforeAll`s that would each have
// to be remembered by whoever writes the twentieth.
import { initLua } from "../../src/lua/lua.js";

await initLua();
