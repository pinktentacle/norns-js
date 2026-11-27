// E9-275 — `sox`, the program, compiled as it is.
//
// sampswap, makebreakbeat, zxcvbn, norman and paracosms apt-get sox and
// run it from os.execute: trim, splice, tempo, pitch, stretch, reverse,
// silence, rate, gain, reverb, `-n stat`, `--i`. tools/sox/build.sh
// compiles SoX 14.4.2 — the version a norns installs — to wasm, and this
// runs it the way a shell runs a program: ONE FRESH INSTANCE PER COMMAND,
// synchronously, so `os.execute` returns when the file is written and the
// next line of the script can read it, as on the hardware.
//
// Synchronous needs the module already compiled: `prepareSox()` fetches
// and compiles it at boot; until that has finished a command is refused
// with the reason (it is a few hundred milliseconds into the page).
//
// THE FILES. Each instance has its own memory filesystem. Every word of the
// command that names a file the page has is copied in at its own path,
// sox runs with /home/we as its working directory, and every named file
// that is new or changed afterwards is copied back. Effects that use a
// temporary file (reverse) use the instance's /tmp, gone with it.

import { dirname, normalise, type Vfs } from "./vfs.js";

interface SoxModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    chdir(path: string): void;
  };
  callMain(args: string[]): number;
}

type CreateSox = (opts: Record<string, unknown>) => Promise<SoxModule>;

// The bytes, not a compiled WebAssembly.Module: emscripten's glue starts
// synchronously only from `wasmBinary` (-sWASM_ASYNC_COMPILATION=0). Given
// `instantiateWasm` instead it waits on a promise for the rest of its
// start-up, and a callMain made before that ran with no stdout or stderr —
// the files were written and `sox --i` printed nothing.
let compiled: Uint8Array | null = null;
let factory: CreateSox | null = null;
let preparing: Promise<boolean> | null = null;
let failure: string | null = null;

/** Where the page serves it (tools/sox/build.sh copies it to public/sox/). */
const BASE = "/sox";

/**
 * Fetch and compile sox, once. True when it is ready; false (with the reason
 * kept for the refusal) when this build has no sox.
 */
export function prepareSox(base: string = BASE): Promise<boolean> {
  preparing ??= (async (): Promise<boolean> => {
    try {
      const mod = (await import(/* @vite-ignore */ `${base}/sox.js`)) as { default: CreateSox };
      const res = await fetch(`${base}/sox.wasm`);
      if (!res.ok) throw new Error(`sox.wasm: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Compiled once here only to know it is a module this browser takes.
      await WebAssembly.compile(bytes);
      compiled = bytes;
      factory = mod.default;
      return true;
    } catch (e) {
      failure = (e as Error).message;
      return false;
    }
  })();
  return preparing;
}

/** For tests: the module's bytes and its factory, as prepareSox would leave them. */
export function setSoxModule(c: Uint8Array | null, f: CreateSox | null): void {
  compiled = c;
  factory = f;
  failure = null;
}

export function soxReady(): boolean {
  return compiled !== null && factory !== null;
}

/** Why sox cannot run, when it cannot. */
export function soxUnavailable(): string {
  if (soxReady()) return "";
  return failure !== null ? `sox is not in this build (${failure})` : "sox is still loading";
}

export interface SoxRun {
  /** Exit status, as sox's main returned or exit()ed it. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The words of a command that may name files, as absolute paths. */
function pathsIn(argv: readonly string[], cwd: string): string[] {
  const out = new Set<string>();
  for (const a of argv) {
    let w = a;
    const eq = /^--[\w-]+=(.+)$/.exec(w);
    if (eq !== null) w = eq[1]!;
    if (w === "-" || w === "-n" || w.startsWith("-")) continue;
    // A word with a slash or an extension: a file, or a number like 0.5.
    if (!w.includes("/") && !/\.[A-Za-z0-9]{1,5}$/.test(w)) continue;
    if (/^-?\d*\.?\d+%?$/.test(w)) continue;
    // Relative to the directory sox runs in: normalise's second argument is
    // only what `~` means (E9-276 — relative names used to land in /).
    out.add(normalise(w.startsWith("/") || w.startsWith("~") ? w : `${cwd}/${w}`));
  }
  return [...out];
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Run `sox argv…` (or `soxi` when `name` says so) against the page's files.
 * Null when sox is not ready — the caller refuses with soxUnavailable().
 */
export function runSox(vfs: Vfs, argv: readonly string[], name = "sox", cwd = "/home/we"): SoxRun | null {
  if (compiled === null || factory === null) return null;
  let stdout = "";
  let stderr = "";
  let instance: SoxModule | null = null;
  const opts: Record<string, unknown> = {
    thisProgram: name,
    print: (s: string) => (stdout += s + "\n"),
    printErr: (s: string) => (stderr += s + "\n"),
    // Synchronous: compiled and started here and now, so the runtime is up
    // before the factory returns.
    wasmBinary: compiled,
  };
  void factory(opts).catch(() => {});
  // MODULARIZE assigns the runtime onto the object it was given.
  instance = opts as unknown as SoxModule;
  if (typeof instance.callMain !== "function" || instance.FS === undefined) {
    return { code: 1, stdout: "", stderr: "sox: the module did not start synchronously\n" };
  }
  const FS = instance.FS;
  FS.mkdirTree(cwd);
  FS.mkdirTree("/tmp");
  FS.chdir(cwd);

  const paths = pathsIn(argv, cwd);
  const before = new Map<string, Uint8Array>();
  for (const p of paths) {
    try {
      FS.mkdirTree(dirname(p));
    } catch {
      /* a path sox will refuse on its own */
    }
    const bytes = vfs.read(p);
    if (bytes !== null) {
      FS.writeFile(p, bytes);
      before.set(p, bytes);
    }
  }

  let code = 0;
  try {
    code = instance.callMain([...argv]);
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (typeof status === "number") code = status;
    else {
      code = 1;
      stderr += `sox: ${(e as Error)?.message ?? String(e)}\n`;
    }
  }

  for (const p of paths) {
    let bytes: Uint8Array;
    try {
      bytes = FS.readFile(p);
    } catch {
      continue;
    }
    const old = before.get(p);
    if (old === undefined || !same(old, bytes)) {
      if (!vfs.isDir(dirname(p))) vfs.mkdir(dirname(p));
      vfs.write(p, new Uint8Array(bytes));
    }
  }
  return { code, stdout, stderr };
}
