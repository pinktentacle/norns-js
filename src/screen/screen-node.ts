// Node-side loading of the screen wasm module.
//
// The whole content of this file is `locateFile`, and it exists because
// getting it wrong is silent until it is fatal. Emscripten resolves
// `screen.wasm` and `screen.data` against the PAGE, not against the script —
// so under vitest it looked for `screen.data` in the repository root and threw
// ENOENT from inside a promise. E0-19 hit the identical thing with
// `sclang.data`; writing it down once beats rediscovering it per module.

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build");

export async function loadScreenModule(): Promise<any> {
  const { default: factory } = await import("./build/screen.mjs");
  return factory({
    locateFile: (file: string) => path.join(BUILD, file),
    // Emscripten prints font-loading chatter on stderr; the module reports
    // which fonts loaded through screen_fonts_loaded instead.
    printErr: () => {},
  });
}
