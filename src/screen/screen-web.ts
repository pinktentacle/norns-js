// Browser-side loading of the screen wasm module.
//
// Same job as `screen-node.ts`: tell emscripten where its own files are.
// `new URL(..., import.meta.url)` resolves against this module rather than
// against the page, which is the whole point — the page may be at any path,
// and E0-19 lost an afternoon to exactly this with `sclang.data`.

export async function loadScreenModuleWeb(): Promise<any> {
  const { default: factory } = await import("./build/screen.mjs");
  return factory({
    locateFile: (file: string) => new URL(`./build/${file}`, import.meta.url).href,
    printErr: (s: string) => console.warn("[screen]", s),
  });
}
