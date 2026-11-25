// E9-220 — where a script's class is compiled from, read as where it lives.
//
// norns compiles `~/dust/code` in place, so a class knows its own file as
// `/home/we/dust/code/<script>/lib/Engine_X.sc`, and an engine that finds
// its samples beside itself writes
//
//     PathName(Engine_Coverts.filenameSymbol.asString).pathOnly ++ "../waves/"
//
// Here the class library is staged into `/sc/SCClassLibrary/dust/` (see
// `host.ts`), and that is the path `filenameSymbol` answers with. Only the
// `.sc` and `.scd` files are staged, so every sample asked for under it
// was "no such file": coverts loaded none of its fourteen wavetable banks,
// its engine failed on the first `numFrames` of a buffer that never came,
// and the script ran with no commands at all.
//
// So a path into the staged copy is read as the same path in the dust tree,
// which is where the page keeps the file. Nothing else is touched.

import { normalise } from "../fs/vfs.js";

/** Where `host.ts` stages the scripts' own classes for sclang. */
export const STAGED_DUST = "/sc/SCClassLibrary/dust";
const DUST_CODE = "/home/we/dust/code";

/** The dust-tree path for a path into the staged classes; anything else unchanged. */
export function stagedToDust(path: string): string {
  const p = normalise(path);
  if (p === STAGED_DUST) return DUST_CODE;
  if (p.startsWith(STAGED_DUST + "/")) return DUST_CODE + p.slice(STAGED_DUST.length);
  return path;
}
