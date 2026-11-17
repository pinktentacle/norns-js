// Browser-side dust tree: one fetch, unpacked synchronously into the VFS.
//
// One request rather than 690, and not inlined in the JS bundle, so the
// browser can cache the scripts across deploys of the application. It has to
// complete BEFORE Lua starts, because `io.open` and `loadfile` are
// synchronous and have nowhere to await.

import { Vfs, seedDust, type RemoteFile } from "./vfs.js";

export async function loadDustWeb(
  url = "/dust.json",
  vfs = new Vfs(),
  assetsUrl = "/dust-assets.json",
): Promise<Vfs> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const tree = (await res.json()) as Record<string, string>;
  for (const [p, content] of Object.entries(tree)) vfs.mount(p, () => content);

  // The sound files scripts ship, declared but not fetched. 12 MB across the
  // bundled set, 11 of it one script's, and most sessions read none of it —
  // so the manifest says a file is there and how big it is, and the bytes
  // arrive the first time something wants them.
  //
  // Not fatal if it is missing: a tree built before this existed has no
  // manifest, and the scripts that do not use a sample are unaffected.
  try {
    const assetRes = await fetch(assetsUrl);
    if (assetRes.ok) {
      vfs.mountRemoteAll((await assetRes.json()) as Record<string, RemoteFile>);
    }
  } catch {
    /* no manifest; sound files are simply absent */
  }

  seedDust(vfs);
  return vfs;
}
