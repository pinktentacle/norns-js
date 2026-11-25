/**
 * E9-247 — `/d_load` and `/d_loadDir` read SynthDef files from the SERVER's
 * disk.
 *
 * On a norns sclang and scsynth share one filesystem, so an engine can write
 * its defs with `writeDefFile` and have the server load them back by path.
 * grains does exactly that to start faster: the first load writes every def
 * under `~/dust/data/grains/defs/` with a stamp, and every later load sends
 * `/d_loadDir` for the folder instead of compiling them again.
 *
 * Here the two are separate wasm modules with a MEMFS each. sclang's
 * `writeDefFile` lands in sclang's, and the server was asked to read a
 * folder it had never seen. With exceptions off in that file the server's
 * own "Directory does not exist" killed its async thread for the session
 * (fixed apart, E9-247's -fexceptions); with it on, grains would load with
 * none of its SynthDefs.
 *
 * So the files go across first: the matching `.scsyndef` files are copied
 * from sclang's filesystem to the server's, at the same path, and the
 * message then goes on unchanged for the server to do its own loading.
 */

import { decode } from "./osc.js";

/** The part of emscripten's `FS` this uses. */
export interface DefFS {
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  mkdirTree(path: string): void;
}

/** scsynth's command numbers: `cmd_d_load = 6`, `cmd_d_loadDir = 7`. */
const CMD_D_LOAD = 6;
const CMD_D_LOAD_DIR = 7;

const startsWith = (bytes: Uint8Array, s: string): boolean => {
  if (bytes.length <= s.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[i] !== s.charCodeAt(i)) return false;
  return bytes[s.length] === 0;
};

/**
 * What a packet asks the server to load from disk, if anything. Cheap for
 * everything else: one or two byte compares before any decoding.
 */
export function defLoadOf(bytes: Uint8Array): { kind: "file" | "dir"; path: string } | null {
  if (bytes.length < 8) return null;
  let kind: "file" | "dir" | null = null;
  if (bytes[0] === 0) {
    const c = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0);
    kind = c === CMD_D_LOAD ? "file" : c === CMD_D_LOAD_DIR ? "dir" : null;
  } else if (bytes[1] === 0x64 /* d */ && bytes[2] === 0x5f /* _ */) {
    kind = startsWith(bytes, "/d_loadDir") ? "dir" : startsWith(bytes, "/d_load") ? "file" : null;
  }
  if (kind === null) return null;
  try {
    const m = decode(bytes) as { args?: unknown[] };
    const p = m.args?.[0];
    return typeof p === "string" && p !== "" ? { kind, path: p } : null;
  } catch {
    return null;
  }
}

/** `*` and `?` in the last part of a path, as scsynth's glob reads them. */
function globRe(name: string): RegExp {
  const body = name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/**
 * Copy what the load names from `from` to `to`. Returns how many files went
 * across; 0 when sclang has nothing there either, and the server then says
 * so itself.
 */
export function mirrorDefs(from: DefFS, to: DefFS, load: { kind: "file" | "dir"; path: string }): number {
  let n = 0;
  const copy = (p: string): void => {
    const slash = p.lastIndexOf("/");
    if (slash > 0) to.mkdirTree(p.slice(0, slash));
    to.writeFile(p, from.readFile(p));
    n++;
  };
  const isDir = (p: string): boolean | null => {
    try {
      return from.isDir(from.stat(p).mode);
    } catch {
      return null;
    }
  };
  const walk = (dir: string): void => {
    for (const name of from.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const p = `${dir.replace(/\/$/, "")}/${name}`;
      const d = isDir(p);
      if (d === true) walk(p);
      else if (d === false && name.endsWith(".scsyndef")) copy(p);
    }
  };
  if (load.kind === "dir") {
    if (isDir(load.path) === true) walk(load.path);
    return n;
  }
  const slash = load.path.lastIndexOf("/");
  const dir = slash > 0 ? load.path.slice(0, slash) : "/";
  const base = load.path.slice(slash + 1);
  if (!/[*?]/.test(base)) {
    if (isDir(load.path) === false) copy(load.path);
    return n;
  }
  if (isDir(dir) !== true) return n;
  const re = globRe(base);
  for (const name of from.readdir(dir)) {
    const p = `${dir}/${name}`;
    if (re.test(name) && isDir(p) === false) copy(p);
  }
  return n;
}
