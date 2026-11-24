// E6-08 — getting a tree out, and getting one back in.
//
// Everything a user makes here lives in one origin's storage. Clear the site
// data, use a private window, or switch machines, and it is gone — with no
// warning and no copy. On a norns you would reach for the SD card; here
// there is nothing to reach for unless we build it.
//
// THREE OPERATIONS, and they are deliberately different shapes:
//
//   * EXPORT writes a zip of what the user CHANGED, not of the whole tree.
//     The 690 bundled files arrive fresh from the build on every load, so
//     putting them in the archive would make a 5 MB file of which 5 MB is
//     already on the server. What is irreplaceable is the overlay: a script
//     they wrote, the psets they saved, a tape they recorded. `everything`
//     is there for when someone wants the lot anyway.
//
//   * IMPORT puts an archive back, and REFUSES any path that tries to climb
//     out of the tree. A zip is an untrusted input even when the user chose
//     the file: `../../etc/passwd` is a real entry name in real archives,
//     and a VFS is no excuse for honouring it.
//
//   * INSTALL takes a script's archive — a GitHub zip, usually — and puts
//     it under `code/<name>/`, stripping the wrapper directory that GitHub
//     adds. That is the shape people actually have.

import { unzip, zip, type ZipEntry } from "./zip.js";
import type { Vfs } from "./vfs.js";

export const DUST = "/home/we/dust";

export interface ExportOptions {
  readonly root?: string;
  /**
   * Include the files the build supplies. Off by default: they are the same
   * bytes the server will hand out again on the next load.
   */
  readonly everything?: boolean;
}

export interface ExportResult {
  readonly bytes: Uint8Array;
  readonly files: number;
  /** Files that exist but have no bytes here — the lazily fetched assets. */
  readonly skipped: string[];
}

export async function exportTree(vfs: Vfs, opts: ExportOptions = {}): Promise<ExportResult> {
  const root = opts.root ?? DUST;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];

  // A DOWNLOADED ASSET IS NOT A CHANGE, and the VFS cannot tell the
  // difference on its own: reading a lazily-fetched sound file caches its
  // bytes into the same overlay a written file lands in, so `dirty()`
  // reports both. Measured the first time this ran: an export of "what you
  // changed" came to 8.2 MB, of which 9.7 MB uncompressed was one amen
  // sample the server will hand out again on request. Anything the manifest
  // declares is left out unless `everything` was asked for.
  const paths = opts.everything
    ? vfs.walk(root)
    : vfs
        .dirty()
        .map((d) => d.path)
        .filter((p) => p.startsWith(prefix))
        .filter((p) => {
          if (!vfs.wasFetched(p)) return true;
          skipped.push(p);
          return false;
        });

  for (const path of [...new Set(paths)].sort()) {
    const bytes = vfs.read(path);
    if (!bytes) {
      // A remote asset: declared in the manifest, fetched only when read.
      // Writing a zero-length file for it would be a lie that imports.
      skipped.push(path);
      continue;
    }
    entries.push({ path: path.slice(prefix.length), bytes });
  }

  return { bytes: await zip(entries), files: entries.length, skipped };
}

export interface ImportResult {
  readonly written: number;
  /** Entries left out, with the reason. */
  readonly refused: Array<{ path: string; why: string }>;
}

/**
 * A path from an archive, or null if it must not be written.
 *
 * Absolute paths, `..` segments and Windows drive letters are all refused.
 * This is the only place that decides, so there is one rule rather than a
 * check at every call site.
 */
export function safeJoin(root: string, path: string): string | null {
  const clean = path.replace(/\\/g, "/");
  if (clean === "" || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) return null;
  const parts: string[] = [];
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return `${root.replace(/\/$/, "")}/${parts.join("/")}`;
}

export async function importTree(
  vfs: Vfs,
  archive: Uint8Array,
  opts: { root?: string } = {},
): Promise<ImportResult> {
  const root = opts.root ?? DUST;
  const refused: Array<{ path: string; why: string }> = [];
  let written = 0;

  for (const entry of await unzip(archive)) {
    const target = safeJoin(root, entry.path);
    if (target === null) {
      refused.push({ path: entry.path, why: "the path leaves the tree" });
      continue;
    }
    const dir = target.slice(0, target.lastIndexOf("/"));
    if (dir) vfs.mkdir(dir);
    vfs.write(target, entry.bytes);
    written++;
  }
  return { written, refused };
}

/**
 * The directory every entry is inside, or "" if they do not share one.
 *
 * GitHub wraps a repository zip in `<repo>-<ref>/`, and nobody wants a
 * script installed at `code/awake-main/awake-main/awake.lua`.
 */
export function commonPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0]!.split("/");
  if (first.length < 2) return "";
  const head = first[0]!;
  return paths.every((p) => p.startsWith(`${head}/`)) ? head : "";
}

export interface InstallResult {
  readonly name: string;
  readonly files: number;
  readonly refused: Array<{ path: string; why: string }>;
}

/**
 * Install a script's archive under `code/<name>/`.
 *
 * The name comes from the archive's own wrapper directory with a `-main`,
 * `-master` or `-vN.N.N` suffix removed, because that is what GitHub's zip
 * is called and not what the script is called. A caller that knows better
 * passes one.
 */
export async function installScript(
  vfs: Vfs,
  archive: Uint8Array,
  opts: { name?: string; root?: string } = {},
): Promise<InstallResult> {
  const entries = await unzip(archive);
  const wrapper = commonPrefix(entries.map((e) => e.path));
  const derived = wrapper.replace(/-(main|master|v?\d+(\.\d+)*)$/i, "");
  const name = (opts.name ?? derived ?? "").trim();
  if (name === "") throw new Error("install: no name for this script, and none in the archive");

  const root = `${opts.root ?? DUST}/code/${name}`;
  const refused: Array<{ path: string; why: string }> = [];
  let files = 0;
  for (const entry of entries) {
    const rel = wrapper ? entry.path.slice(wrapper.length + 1) : entry.path;
    const target = safeJoin(root, rel);
    if (target === null) {
      refused.push({ path: entry.path, why: "the path leaves the tree" });
      continue;
    }
    const dir = target.slice(0, target.lastIndexOf("/"));
    if (dir) vfs.mkdir(dir);
    vfs.write(target, entry.bytes);
    files++;
  }
  return { name, files, refused };
}

/**
 * E9-211 — a sample pack, put where its script's instructions put it.
 *
 * Some scripts are silent until a pack of samples is in `~/dust/audio`,
 * and on a norns that is a line their README has you paste into maiden:
 * `cd ~/dust/audio && wget …/moonraker.zip && unzip moonraker.zip`. The
 * pack is a GitHub release, which a page may not fetch — but a person can
 * download it like any file, and this is the `unzip` half: the archive's
 * own paths, under `audio/`. Nothing is stripped, because these archives
 * already carry the folder the script looks in (`moonraker/1/…`).
 *
 * What a Mac adds to a zip it made is left out; it is never a sample.
 */
export async function importSamples(
  vfs: Vfs,
  archive: Uint8Array,
  opts: { root?: string } = {},
): Promise<ImportResult & { folders: string[]; bytes: number }> {
  const root = `${opts.root ?? DUST}/audio`;
  const refused: Array<{ path: string; why: string }> = [];
  const folders = new Set<string>();
  let written = 0;
  let bytes = 0;
  for (const entry of await unzip(archive)) {
    const parts = entry.path.replace(/\\/g, "/").split("/").filter((s) => s !== "");
    if (parts.length === 0 || parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store") continue;
    const target = safeJoin(root, entry.path);
    if (target === null) {
      refused.push({ path: entry.path, why: "the path leaves the tree" });
      continue;
    }
    const dir = target.slice(0, target.lastIndexOf("/"));
    if (dir) vfs.mkdir(dir);
    vfs.write(target, entry.bytes);
    written++;
    bytes += entry.bytes.length;
    folders.add(target.slice(root.length + 1).split("/")[0]!);
  }
  return { written, refused, folders: [...folders].sort(), bytes };
}

/**
 * Fetch an archive, and say plainly when the web will not let us.
 *
 * MOST URLS WILL FAIL, and the reason is not a bug to be fixed here: a page
 * may only read a cross-origin response when that origin sends CORS headers,
 * and GitHub's codeload does not. The browser reports that as an opaque
 * network error with no detail, so the detail is supplied here — otherwise
 * the user is left with "failed to fetch" and the belief that the URL was
 * wrong.
 */
export async function fetchArchive(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      `could not fetch ${url}. A page can only read another origin's files ` +
        "when that origin allows it (CORS), and most code hosts do not — " +
        "download the zip yourself and use import.",
    );
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}
