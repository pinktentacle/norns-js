// Types for classlib-loader.js, which is plain JavaScript because it has to
// run three ways: under Node in the spike's self-test, as a module in the
// browser, and as part of the app bundle. Same arrangement as
// src/clock/ring.d.ts.

export interface LoadClassLibraryOptions {
  /** Archive URL. `.tar.gz` is sniffed and inflated; a plain `.tar` is used. */
  url?: string;
  /** Where the archive's top level lands. Default `/sc`, sclang's data dir. */
  root?: string;
  /** Skip the fetch and unpack these bytes. */
  bytes?: Uint8Array | ArrayBuffer | null;
  /**
   * What to do if `root/SCClassLibrary` is already there — which it is on a
   * build that still has `--preload-file`.
   */
  onConflict?: "error" | "overwrite";
  fetch?: typeof fetch;
}

export interface LoadClassLibraryResult {
  files: number;
  bytes: number;
  archiveBytes: number;
  skipped: number;
  fetchMs: number;
  inflateMs: number;
  writeMs: number;
  totalMs: number;
}

/** Unpack a class-library archive into an emscripten MEMFS. */
export function loadClassLibrary(
  Module: unknown,
  opts?: LoadClassLibraryOptions,
): Promise<LoadClassLibraryResult>;
