// Browser-side loading of norns' Lua tree.
//
// The same map `host-node.ts` builds from the filesystem, built instead at
// bundle time. Vite inlines every match as a string, so the sources travel in
// the JS bundle and there is no second round trip before boot — which matters
// because `require('core/norns')` pulls in about 60 files and a fetch each
// would be 60 requests before anything is on screen.

const modules = import.meta.glob("/third_party/norns/lua/**/*.lua", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

import { applyLuaPatches } from "./patches.js";

const PREFIX = "/third_party/norns/lua/";

/** Module name (`core/norns`, `lib/util`) → source. */
export function loadNornsLuaWeb(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, src] of Object.entries(modules)) {
    if (!path.startsWith(PREFIX)) continue;
    out.set(path.slice(PREFIX.length).replace(/\.lua$/, ""), src);
  }
  // To a COPY, on the way in. third_party/ is never modified, and a missing
  // anchor throws rather than quietly handing back an unpatched file.
  applyLuaPatches(out);
  return out;
}

export function loadConfigWeb(): string {
  const src = modules[`${PREFIX}core/config.lua`];
  if (!src) throw new Error("core/config.lua was not bundled");
  return src;
}
