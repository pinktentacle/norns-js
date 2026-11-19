// E6-01 / E5-09 — the writable overlay, mirrored into OPFS.
//
// WHY A MIRROR AND NOT A FILESYSTEM. `src/fs/vfs.ts` says it: OPFS is async
// on the main thread, and every caller here is Lua, which is synchronous all
// the way down. `io.open` has nowhere to await. So the overlay stays the
// session's truth and OPFS is a copy of it, written behind the caller's
// back:
//
//   * **load at boot**, awaited before Lua starts, because `state.resume`
//     reads `system.state` during `_startup` and a file that arrives later
//     arrives after the only moment anything reads it;
//   * **flush after write**, coalesced, never awaited by the writer.
//
// WHAT IS MIRRORED. The overlay only. The base — 690 dust files — is
// supplied fresh by the build on every load, and copying it into the
// browser's storage would cost megabytes to reproduce something already
// there. Tombstones are mirrored too: deleting a bundled script has to
// survive a reload, or it comes back.
//
// A PLACEHOLDER DIRECTORY IS A FILE SYSTEM FACT. `util.make_dir` is how
// norns creates `~/dust/data/<script>/` before writing a PSET into it, and
// between the mkdir and the first write the directory exists with nothing
// in it. OPFS represents that natively, so `mkdir` is mirrored as a real
// directory rather than ignored until something lands in it.
//
// FAILURE IS NOT FATAL. A private window, a cleared origin, a quota — all of
// them end with no persistence, and none of them should stop the page. Every
// path here reports once and carries on.

import type { Vfs } from "./vfs.js";

/** The subset of the OPFS API used, so a test can supply it. */
export interface DirHandleLike {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, DirHandleLike | FileHandleLike]>;
}

export interface FileHandleLike {
  readonly kind?: string;
  // `lastModified` is OPFS's own, maintained by the browser and surviving
  // a reload. It is optional here because the fakes in the tests do not
  // have to invent one, and a missing time is read as "unknown" rather
  // than as "now" — see Vfs.mtimeOf.
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; lastModified?: number }>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

export interface OpfsOptions {
  readonly log?: (line: string) => void;
  /** Supplied by tests; `navigator.storage.getDirectory()` otherwise. */
  readonly root?: () => Promise<DirHandleLike>;
  /** How long writes are gathered before a flush. */
  readonly debounceMs?: number;
}

/**
 * Where the mirror lives inside the origin's OPFS.
 *
 * Under a directory of its own rather than at the root, so that a future
 * use of OPFS for something else — a cache, a download staging area — does
 * not have to tell its files apart from the dust tree's.
 */
const ROOT_DIR = "norns-dust";

/** Deleted base paths, as one file rather than as absences. */
const TOMBSTONE_FILE = ".tombstones.json";

/** Directories made but never written into. */
const PLACEHOLDER_FILE = ".placeholders.json";
/**
 * References a COPY made, as `[path, remote]` pairs.
 *
 * The fourth sidecar, beside the bytes, the tombstones and the empty
 * directories. A sound file a script ships is fetched the first time it is
 * played, so `cp` copies the REFERENCE rather than pulling megabytes
 * through a shell for a copy nobody may read — and without this the
 * reference lived only in memory. `beets` copies its demo loops on first
 * run, and on the second run the folder listed names that read as nothing,
 * for ever: it only copies `if util.file_exists(dir) == false`.
 */
const REFERENCE_FILE = ".references.json";

function defaultRoot(): Promise<DirHandleLike> {
  const nav = globalThis.navigator as unknown as {
    storage?: { getDirectory?: () => Promise<DirHandleLike> };
  };
  if (nav?.storage?.getDirectory === undefined) {
    return Promise.reject(new Error("no OPFS in this browser"));
  }
  return nav.storage.getDirectory();
}

function parts(path: string): string[] {
  return path.split("/").filter((p) => p !== "");
}

/** `mkdir -p`, in OPFS terms. */
async function dirFor(root: DirHandleLike, segments: string[]): Promise<DirHandleLike> {
  let at = root;
  for (const seg of segments) at = await at.getDirectoryHandle(seg, { create: true });
  return at;
}

/**
 * E9-56 — a folder does not outlive the files that were in it.
 *
 * Deleting a file removed the file and left its directory. The restore
 * walks OPFS and calls `vfs.mkdir` for every directory it meets, so an
 * emptied folder came back next load as an empty placeholder — and
 * maiden's installed list is folders, so 281 scripts whose files had been
 * removed were still offered as installed, with nothing in SELECT to
 * choose. Found by a user asking why terrarium could not be selected.
 *
 * ONLY a directory the Vfs no longer calls one, and ONLY under
 * `~/dust/code`. Both halves are deliberate. An empty folder somebody MADE
 * is in `emptyDirs` and `isDir` answers true for it — but a folder that was
 * made, filled and then emptied is NOT: `write` drops the placeholder the
 * moment a file lands in it, and nothing puts it back. Under `~/dust/data`
 * that folder is a script's own, and a script's `util.make_dir` is exactly
 * how it got there, so it is left alone. Under `~/dust/code` an empty
 * folder is not a script and should not be offered as one.
 *
 * Walking up stops at the first directory that is still a directory, at
 * `~/dust/code` itself, and at the first refusal from OPFS.
 */
const CODE_SEGS = ["home", "we", "dust", "code"];

async function pruneEmpty(
  root: DirHandleLike,
  segments: string[],
  stillADir: (path: string) => boolean,
): Promise<void> {
  if (!CODE_SEGS.every((s, i) => segments[i] === s)) return;
  for (let segs = [...segments]; segs.length > CODE_SEGS.length; segs.pop()) {
    if (stillADir("/" + segs.join("/"))) return;
    const name = segs[segs.length - 1]!;
    try {
      const parent = await dirFor(root, segs.slice(0, -1));
      // NOT recursive: if anything is still in there, this throws and the
      // walk stops, which is the guard rather than a check that could race.
      await parent.removeEntry(name);
    } catch {
      return;
    }
  }
}

async function readWhole(h: FileHandleLike): Promise<Uint8Array> {
  const f = await h.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/** The same bytes, with OPFS's own last-modified time when it has one. */
async function readWholeWithTime(
  h: FileHandleLike,
): Promise<{ data: Uint8Array; mtime: number | undefined }> {
  const f = await h.getFile();
  return { data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified };
}

async function writeWhole(dir: DirHandleLike, name: string, data: Uint8Array): Promise<void> {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  // A fresh writable truncates, so a shorter file does not leave the old
  // tail behind — which is exactly how a rewritten PSET would end up with
  // half of its predecessor stuck to it.
  await w.write(data);
  await w.close();
}

function isFileHandle(h: DirHandleLike | FileHandleLike): h is FileHandleLike {
  return (h as FileHandleLike).getFile !== undefined;
}

export interface OpfsRestore {
  readonly files: number;
  readonly tombstones: number;
  readonly placeholders: number;
  readonly references: number;
  readonly bytes: number;
  /** Empty `~/dust/code` folders dropped rather than restored (E9-65). */
  readonly ghosts: number;
}

/**
 * Read the mirror back into the VFS. Await this BEFORE Lua boots.
 *
 * Returns zeros when there is nothing stored or no OPFS at all, which are
 * the same thing from here: a first run.
 */
export async function restoreFromOpfs(vfs: Vfs, opts: OpfsOptions = {}): Promise<OpfsRestore> {
  const log = opts.log ?? (() => {});
  const empty = { files: 0, tombstones: 0, placeholders: 0, references: 0, bytes: 0, ghosts: 0 };
  let root: DirHandleLike;
  try {
    root = await (opts.root ?? defaultRoot)();
    root = await root.getDirectoryHandle(ROOT_DIR, { create: true });
  } catch (e) {
    log(`opfs: unavailable — ${(e as Error).message}`);
    return empty;
  }

  let files = 0;
  let bytes = 0;
  const decoder = new TextDecoder();

  const walk = async (dir: DirHandleLike, prefix: string): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      if (
        prefix === "" &&
        (name === TOMBSTONE_FILE || name === PLACEHOLDER_FILE || name === REFERENCE_FILE)
      ) {
        continue;
      }
      const path = `${prefix}/${name}`;
      if (isFileHandle(handle)) {
        const { data, mtime } = await readWholeWithTime(handle);
        // Straight into the overlay. Not `write`, because that would call
        // the watchers and send everything we just read back out again.
        // The time comes with it: a pset restored at boot keeps the moment
        // it was SAVED, which is what `stat -c %Y` is asked for.
        vfs.restore(path, data, mtime);
        files++;
        bytes += data.length;
      } else {
        vfs.mkdir(path);
        await walk(handle, path);
      }
    }
  };

  let tombstones = 0;
  let placeholders = 0;
  let references = 0;
  /**
   * Does the build still declare this target?
   *
   * The manifest's own remotes are mounted before a restore runs, so their
   * urls are the set of everything this version can serve.
   */
  const servedUrls = new Set<string>();
  for (const r of vfs.allRemotes()) servedUrls.add(String(r.url));
  const served = (url: string): boolean => servedUrls.has(url);
  try {
    await walk(root, "");
    const readJson = async (name: string): Promise<string[]> => {
      try {
        const h = await root.getFileHandle(name);
        const text = decoder.decode(await readWhole(h));
        const v: unknown = JSON.parse(text);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    };
    for (const p of await readJson(TOMBSTONE_FILE)) {
      vfs.remove(p);
      tombstones++;
    }
    for (const p of await readJson(PLACEHOLDER_FILE)) {
      vfs.mkdir(p);
      placeholders++;
    }
    // A reference points at a URL THIS BUILD serves. Update norns-js with a
    // different dust tree and a stored one aims at nothing — so a target the
    // manifest no longer declares is dropped here and said out loud, rather
    // than restored to fail later at the moment somebody presses play.
    // Its own reader: `readJson` keeps strings, and these are pairs.
    const readPairs = async (name: string): Promise<unknown[]> => {
      try {
        const h = await root.getFileHandle(name);
        const v: unknown = JSON.parse(decoder.decode(await readWhole(h)));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };
    for (const entry of await readPairs(REFERENCE_FILE)) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [path, file] = entry as [unknown, { url?: unknown }];
      if (typeof path !== "string" || file === null || typeof file !== "object") continue;
      const url = String(file.url ?? "");
      if (url === "" || !served(url)) {
        log(`opfs: dropped a copy of ${path} — this version no longer supplies it`);
        continue;
      }
      vfs.copyRemote(path, file as Parameters<Vfs["copyRemote"]>[1]);
      references++;
    }
  } catch (e) {
    log(`opfs: restore stopped — ${(e as Error).message}`);
  }

  /**
   * E9-65 — AN EMPTY SCRIPT FOLDER IS NOT A SCRIPT, and it must not come
   * back for ever.
   *
   * An empty directory is worth keeping almost everywhere: `util.make_dir`
   * is how a script claims `~/dust/data/<name>` on its first run, and one
   * that vanished on the next boot would be made again and again. Under
   * `~/dust/code` it is the opposite — nothing creates a script folder
   * except an install, and an install puts files in it. A folder with
   * nothing in it is the residue of something that went wrong.
   *
   * And it was PERMANENT. The folder is restored from OPFS or from the
   * placeholder sidecar, `mkdir` puts it back in the sidecar, and the next
   * boot restores it again. Thirty-four were on this disk, one per script
   * whose files were lost to a reload between a remove and a reinstall,
   * and maiden listed every one as installed until E9-56 asked for a file
   * instead of a folder.
   *
   * Dropped here rather than deleted from storage: the directory leaves
   * the Vfs, so the next flush's own prune takes it out of OPFS because
   * nothing claims it any more.
   */
  const CODE = "/home/we/dust/code";
  const ghosts = vfs
    .list(CODE)
    .filter((e) => e.isDir && vfs.walk(`${CODE}/${e.name}`).length === 0)
    .map((e) => e.name);
  for (const name of ghosts) vfs.remove(`${CODE}/${name}`);

  if (files > 0 || tombstones > 0 || references > 0) {
    log(
      `opfs: restored ${files} file(s), ${(bytes / 1024).toFixed(1)} KB, ` +
        `${tombstones} deletion(s)` +
        (references > 0 ? `, ${references} copied file(s)` : ""),
    );
  }
  if (ghosts.length > 0) {
    log(
      `opfs: dropped ${ghosts.length} empty script folder${ghosts.length === 1 ? "" : "s"} — ` +
        ghosts.slice(0, 6).join(", ") +
        (ghosts.length > 6 ? ", …" : ""),
    );
  }
  return { files, tombstones, placeholders, references, bytes, ghosts: ghosts.length };
}

/**
 * E9-143 — ERASE EVERYTHING THIS ORIGIN HAS SAVED.
 *
 * The whole `norns-dust` directory, tombstones and reference lists
 * included, which is the one thing a file-by-file reset cannot be: a
 * factory default has to leave nothing behind to be restored, and the
 * bookkeeping files beside the tree are part of what would be.
 *
 * STOP THE MIRROR FIRST, which is the caller's job — this cannot do it,
 * because it does not own one, and a mirror still running would write
 * the overlay straight back into the directory this has just removed.
 *
 * It answers false rather than throwing: a browser that will not give up
 * its storage is a browser where the page should say so, not one where
 * the page should fall over.
 */
export async function wipeOpfs(opts: OpfsOptions = {}): Promise<boolean> {
  try {
    const r = await (opts.root ?? defaultRoot)();
    await r.removeEntry(ROOT_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export interface OpfsMirror {
  /** Everything written so far has reached OPFS. For tests and for a quit. */
  flush(): Promise<void>;
  stop(): void;
  readonly stats: { writes: number; removes: number; errors: number };
}

/**
 * Keep OPFS in step with the overlay.
 *
 * Coalesced: a burst of writes to the same path costs one flush, and a
 * script that rewrites its state on every encoder turn does not queue a
 * hundred OPFS transactions. One flush runs at a time, so two overlapping
 * bursts cannot interleave halfway through a file.
 */
export function mirrorToOpfs(vfs: Vfs, opts: OpfsOptions = {}): OpfsMirror {
  const log = opts.log ?? (() => {});
  const debounce = opts.debounceMs ?? 150;
  const stats = { writes: 0, removes: 0, errors: 0 };
  /** A sample of what the last flush deleted, for the line it prints. */
  let removedPaths: string[] = [];
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;
  let announced = false;

  const rootOnce = (async (): Promise<DirHandleLike | null> => {
    try {
      const r = await (opts.root ?? defaultRoot)();
      return await r.getDirectoryHandle(ROOT_DIR, { create: true });
    } catch (e) {
      log(`opfs: nothing will be saved — ${(e as Error).message}`);
      return null;
    }
  })();

  async function flushNow(): Promise<void> {
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    const root = await rootOnce;
    if (root === null) return;

    for (const path of batch) {
      try {
        const segs = parts(path);
        const name = segs.pop();
        if (name === undefined) continue;
        // THE OVERLAY, NOT THE FILE. `read` answers with the build's bytes
        // for a path the session never wrote, so asking it would make a
        // REVERT look like a write and copy the bundled file straight back
        // into storage -- where the next load would restore it as an edit
        // and the revert would not have happened.
        const data = vfs.hasOverlay(path) ? vfs.read(path) : null;
        if (data !== null) {
          const dir = await dirFor(root, segs);
          await writeWhole(dir, name, data);
          stats.writes++;
        } else if (vfs.isDir(path)) {
          // A mkdir with nothing in it yet.
          await dirFor(root, [...segs, name]);
        } else if (vfs.remoteAt(path) !== null) {
          // A COPIED REFERENCE, whose bytes have not arrived. It reads as
          // null and is not a directory, so the branch below used to
          // DELETE it — the mirror erasing what it could not describe. It
          // is kept in the sidecar instead, with the tombstones and the
          // empty directories.
        } else {
          const dir = await dirFor(root, segs);
          await dir.removeEntry(name, { recursive: true }).catch(() => {
            /* already gone, which is the state we wanted */
          });
          stats.removes++;
          // E9-65 — SAY HOW MANY, at the end of the flush rather than one
          // line per file: the whole dust tree went missing twice in one
          // session with nothing in the log to say what took it, and a
          // mirror that deletes in silence is a mirror you cannot trust.
          // The paths go into `removedPaths`, which the summary samples.
          if (removedPaths.length < 8) removedPaths.push(path);
          await pruneEmpty(root, segs, (d) => vfs.isDir(d));
        }
      } catch (e) {
        stats.errors++;
        if (!announced) {
          announced = true;
          log(`opfs: could not save ${path} — ${(e as Error).message}. Further errors are counted.`);
        }
      }
    }

    // The two sidecars are rewritten whole: they are short, and a diff of a
    // tombstone list is more code than the list.
    try {
      const enc = new TextEncoder();
      await writeWhole(root, TOMBSTONE_FILE, enc.encode(JSON.stringify(vfs.tombstones())));
      await writeWhole(root, PLACEHOLDER_FILE, enc.encode(JSON.stringify(vfs.placeholders())));
      await writeWhole(root, REFERENCE_FILE, enc.encode(JSON.stringify(vfs.references())));
      // E9-65 — what this flush deleted, once, with examples. A removal is
      // the only thing the mirror does that cannot be undone, and it is
      // the one thing it used to do without a word.
      if (removedPaths.length > 0) {
        const n = removedPaths.length;
        log(
          `opfs: removed ${n} path${n === 1 ? "" : "s"} — ` +
            removedPaths.slice(0, 4).join(", ") +
            (n > 4 ? ", …" : ""),
        );
        removedPaths = [];
      }
    } catch (e) {
      stats.errors++;
      if (!announced) {
        announced = true;
        log(`opfs: could not save the deletion list — ${(e as Error).message}`);
      }
    }
  }

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = running.then(flushNow).catch(() => {
        /* counted in stats; the chain must survive */
      });
    }, debounce);
  };

  const unwatch = vfs.watch((path) => {
    if (stopped) return;
    pending.add(path);
    schedule();
  });

  return {
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      running = running.then(flushNow).catch(() => {});
      await running;
    },
    stop() {
      stopped = true;
      unwatch();
      if (timer !== undefined) clearTimeout(timer);
    },
    stats,
  };
}
