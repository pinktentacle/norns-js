// Fengari ships no types. Declaring the module here rather than sprinkling
// `any` at import sites keeps the untyped boundary in one visible place — the
// same reason src/screen/build-types.d.ts exists for the wasm module.
//
// The surface is deliberately loose: `src/lua/lua.ts` is the only file that
// touches it, and everything downstream goes through the typed helpers there.
declare module "fengari" {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fengari: any;
  export default fengari;
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(s: string): Uint8Array;
}
