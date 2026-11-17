// E0-38 / E4-02 — fetch the class-library archive and unpack it into MEMFS.
//
// This is how sclang gets its 373 class files when it is built WITHOUT
// `--preload-file`. The preload bakes them into a 2 MB `sclang.data` that
// has to be re-downloaded whenever sclang is rebuilt, for reasons that have
// nothing to do with the class library; the archive is 529 KB gzipped, is
// cached on its own, and can be replaced without touching the binary.
//
// Runs after the sclang module instantiates and BEFORE bootInterpreter().
// That ordering is the whole mechanism, and it is already proven: the norns
// classes have been written into MEMFS with FS.writeFile at exactly this
// point since E0-18 (research/sclang-wasm-osc-proof.md §6, and
// spike/audio/norns-host.mjs injectNorns()). This does the same thing for
// the other 356 files instead of baking them into sclang.data.
//
//   import { loadClassLibrary } from "./classlib-loader.js";
//   const sclang = await ScLang({ locateFile: (p) => `/sclang/${p}` });
//   await loadClassLibrary(sclang, { url: "/pack/sclang-lib.tar.gz" });
//   sclang.bootInterpreter();
//
// Dependency-free. Gzip is undone by the platform's DecompressionStream, so
// there is no decompressor in the payload.

import { readTar } from "./tar.js";

const now = () =>
  (globalThis.performance?.now?.() ?? Date.now());

/** Is this a gzip member? RFC 1952 §2.3.1: magic 0x1f 0x8b, CM 8. */
function isGzip(b) {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "the archive is gzipped but DecompressionStream is unavailable here. " +
      "Either run somewhere that has it, or serve sclang-lib.tar (uncompressed " +
      "on disk) and let the server apply Content-Encoding.");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** mkdir -p, on whichever FS this emscripten build shipped. */
function mkdirp(FS, dir) {
  if (typeof FS.mkdirTree === "function") { FS.mkdirTree(dir); return; }
  let cur = "";
  for (const part of dir.split("/")) {
    if (!part) continue;
    cur += "/" + part;
    try { FS.mkdir(cur); } catch (e) { if (e?.errno !== 20 && e?.code !== "EEXIST") throw e; }
  }
}

function exists(FS, p) {
  try { FS.stat(p); return true; } catch { return false; }
}

/**
 * Unpack a class-library archive into an emscripten MEMFS.
 *
 * @param Module  the instantiated sclang module (needs Module.FS, i.e. the
 *                build must export it: -sEXPORTED_RUNTIME_METHODS=FS)
 * @param opts.url        archive URL. .tar.gz is sniffed and inflated; a plain
 *                        .tar is used as-is, which is also what you get when
 *                        the server did the decompression (Content-Encoding).
 * @param opts.root       where the archive's top level lands. Default "/sc",
 *                        which is sclang's SC_DATA_DIR.
 * @param opts.bytes      skip the fetch and unpack these bytes instead.
 * @param opts.onConflict "error" (default) | "overwrite" — what to do if
 *                        root/SCClassLibrary already exists, which it does on
 *                        a build that still has --preload-file.
 * @param opts.fetch      fetch implementation, for tests.
 * @returns {{files, bytes, archiveBytes, skipped, fetchMs, inflateMs, writeMs, totalMs}}
 */
export async function loadClassLibrary(Module, opts = {}) {
  const {
    url = "sclang-lib.tar.gz",
    root = "/sc",
    bytes: given = null,
    onConflict = "error",
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  } = opts;

  const FS = Module?.FS;
  if (!FS) {
    throw new Error(
      "Module.FS is not exported. Build sclang with " +
      "-sEXPORTED_RUNTIME_METHODS=FS (tools/sclang/build.sh already does).");
  }

  const t0 = now();
  let raw;
  if (given) {
    raw = given instanceof Uint8Array ? given : new Uint8Array(given);
  } else {
    if (!fetchImpl) throw new Error("no fetch available; pass opts.bytes or opts.fetch");
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    raw = new Uint8Array(await res.arrayBuffer());
  }
  const tFetched = now();

  const tar = isGzip(raw) ? await gunzip(raw) : raw;
  const tInflated = now();

  const { entries, skipped } = readTar(tar);
  if (entries.length === 0) throw new Error(`${url}: archive contains no files`);

  const base = root.replace(/\/+$/, "");
  const top = new Set(entries.map((e) => e.name.split("/")[0]));
  for (const t of top) {
    const p = `${base}/${t}`;
    if (exists(FS, p) && onConflict === "error") {
      throw new Error(
        `${p} already exists. On a build that still has --preload-file the ` +
        `class library is already in MEMFS; pass { onConflict: "overwrite" } ` +
        `if replacing it is what you meant.`);
    }
  }

  let bytes = 0;
  const made = new Set();
  for (const e of entries) {
    const full = `${base}/${e.name}`;
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (!made.has(dir)) { mkdirp(FS, dir); made.add(dir); }
    // Written as bytes, not text: no encoding guesswork, and MEMFS stores
    // the array directly.
    FS.writeFile(full, e.data);
    bytes += e.data.length;
  }
  const tWritten = now();

  return {
    files: entries.length,
    bytes,
    archiveBytes: raw.length,
    tarBytes: tar.length,
    skipped,
    compressed: isGzip(raw),
    fetchMs: +(tFetched - t0).toFixed(1),
    inflateMs: +(tInflated - tFetched).toFixed(1),
    writeMs: +(tWritten - tInflated).toFixed(1),
    totalMs: +(tWritten - t0).toFixed(1),
  };
}

export default loadClassLibrary;
