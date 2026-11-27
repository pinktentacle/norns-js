// E6-01 — the dust tree, as a filesystem norns can believe in.
//
// Two layers, and the split is the whole design:
//
//   * a READ-ONLY base, supplied by the build — norns' own resources and the
//     community scripts. Lazy: a file's bytes are produced on first read, so
//     439 Lua files cost a map of thunks rather than 3.9 MB of strings at
//     start-up.
//   * a WRITABLE overlay, in memory, holding everything written since.
//     Favourites, PSETs, settings. A write shadows the base; a delete of a
//     base file is recorded as a tombstone rather than forgotten, or the file
//     would come back on the next read.
//
// Persistence (OPFS) is deliberately not here. It is an async API and every
// caller of this one is Lua, which is synchronous all the way down —
// `io.open` cannot await. So the overlay is the source of truth during a
// session and OPFS becomes a load-at-boot, flush-after-write mirror of it.
// Mixing the two would mean a Lua read that sometimes returns a promise.

export type Bytes = Uint8Array;

/** Produces a file's contents the first time it is read. */
export type Supplier = () => Bytes | string;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes(v: Bytes | string): Bytes {
  return typeof v === "string" ? encoder.encode(v) : v;
}

/**
 * E9-276 — a working directory, for the length of one command.
 *
 * The shell has none: a relative path is read from `/`, which every caller
 * so far has lived with. A `lua` process has one — sampswap starts it as
 * `cd …/sampswap/lib/ && lua sampswap.lua`, and the script then writes
 * `original.wav` beside itself — so while a command it runs is being
 * carried out, relative paths are read from there. Null the rest of the
 * time, so nothing else changes.
 */
let cwd: string | null = null;

export function withCwd<T>(dir: string, f: () => T): T {
  const prev = cwd;
  cwd = normalise(dir);
  try {
    return f();
  } finally {
    cwd = prev;
  }
}

/** The directory relative paths are read from right now, or null for `/`. */
export function currentCwd(): string | null {
  return cwd;
}

/**
 * Absolute, no trailing slash, no `.` or `..`, `~` expanded.
 *
 * norns writes paths by concatenating strings, so `//` and a trailing slash
 * both turn up in real commands — `find ~/dust/code/` is one of them.
 */
export function normalise(path: string, home = "/home/we"): string {
  let p = path.trim();
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  if (!p.startsWith("/")) p = (cwd ?? "") + "/" + p;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function dirname(path: string): string {
  const p = normalise(path);
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalise(path);
  return p.slice(p.lastIndexOf("/") + 1);
}

export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

/**
 * A file that exists but whose bytes are not here yet.
 *
 * Sound files a script ships: `amen` alone is 11 MB and its break is the
 * whole script, but most sessions never read one. The manifest says a file
 * is there and how big it is; the bytes arrive the first time something
 * wants them. See tools/build-dust.mjs.
 */
export interface RemoteFile {
  readonly url: string;
  readonly size: number;
  /**
   * What `sound_file_inspect` would answer, read from the header at BUILD
   * time.
   *
   * Without it, `audio.file_info` on a file that has not been fetched says
   * nothing, and a script that computes a duration from it gets NaN all the
   * way through — `amen` asks the engine to load `nan` samples and draws
   * `NaN/NaN` on screen. The three numbers are in the first 44 bytes;
   * pulling 1.2 MB over the network to find them would be absurd.
   */
  readonly audio?: { channels: number; frames: number; sampleRate: number };
}

export class Vfs {
  private readonly base = new Map<string, Supplier>();
  private readonly remote = new Map<string, RemoteFile>();
  /** The subset of `remote` that a copy made rather than the build. */
  private readonly copied = new Map<string, RemoteFile>();
  /** Fetches in flight, so two readers of one file make one request. */
  private readonly inFlight = new Map<string, Promise<Bytes | null>>();
  private readonly overlay = new Map<string, Bytes>();
  private readonly deleted = new Set<string>();
  /** Directories created by mkdir that hold nothing yet. */
  private readonly emptyDirs = new Set<string>();

  /**
   * Told about every change to the OVERLAY, for a persistence mirror.
   *
   * The base is not reported: it is supplied fresh on every load by the
   * build, and writing it back out would be copying the dust tree into the
   * browser's storage for no reason.
   *
   * A list rather than one callback because more than one thing may want to
   * watch, and because a mirror that throws must not stop the others.
   */
  private readonly watchers: Array<(path: string) => void> = [];

  /** Overlay entries whose bytes came from the network. See `fetchRemote`. */
  private readonly fetchedPaths = new Set<string>();

  constructor(readonly home = "/home/we") {}

  /** Returns a function that stops watching. */
  watch(fn: (path: string) => void): () => void {
    this.watchers.push(fn);
    return () => {
      const i = this.watchers.indexOf(fn);
      if (i >= 0) this.watchers.splice(i, 1);
    };
  }

  private changed(path: string): void {
    for (const w of this.watchers) {
      try {
        w(path);
      } catch {
        /* a mirror's problem is not the filesystem's */
      }
    }
  }

  /** Add a read-only file. The supplier is called at most once. */
  mount(path: string, supply: Supplier): void {
    this.base.set(normalise(path, this.home), supply);
  }

  mountAll(files: Readonly<Record<string, Supplier>>): void {
    for (const [p, s] of Object.entries(files)) this.mount(p, s);
  }

  /** Declare a file whose bytes are elsewhere. */
  mountRemote(path: string, file: RemoteFile): void {
    this.remote.set(normalise(path, this.home), file);
  }

  mountRemoteAll(files: Readonly<Record<string, RemoteFile>>): void {
    for (const [p, f] of Object.entries(files)) this.mountRemote(p, f);
  }

  /**
   * Declare a reference that somebody MADE, rather than one the build
   * supplied — `cp` of a sound file whose bytes have not arrived.
   *
   * The distinction is the whole point of `references()`. The build's
   * declarations are re-mounted from the manifest on every boot and must
   * not be written to a store; a copy a script made exists nowhere else,
   * and forgetting it leaves a folder full of names pointing at nothing.
   */
  copyRemote(path: string, file: RemoteFile): void {
    const p = normalise(path, this.home);
    this.remote.set(p, file);
    this.deleted.delete(p);
    this.copied.set(p, file);
    this.changed(p);
  }

  /** Every declaration this tree holds, copied or supplied by the build. */
  allRemotes(): RemoteFile[] {
    return [...this.remote.values()];
  }

  /** What `copyRemote` has made, for a mirror to keep. */
  references(): Array<[string, RemoteFile]> {
    const out: Array<[string, RemoteFile]> = [];
    for (const [p, f] of this.copied) {
      // A copy that has since been fetched is an ordinary file now, and a
      // copy that was deleted is gone. Neither is a reference any more.
      if (this.overlay.has(p) || this.deleted.has(p)) continue;
      out.push([p, f]);
    }
    return out;
  }

  /**
   * The reference, if this path is a file whose bytes have not arrived.
   *
   * `null` once they have: a fetched file is an ordinary one. This is how
   * `cp` copies a sound file without pulling 11 MB through the shell — it
   * copies the REFERENCE, and the bytes are fetched later if ever.
   */
  remoteAt(path: string): RemoteFile | null {
    const p = normalise(path, this.home);
    if (this.overlay.has(p) || this.deleted.has(p)) return null;
    const here = this.remote.get(p);
    if (here) return here;
    const q = this.fold(p); // see `fold`
    if (q === p || this.overlay.has(q) || this.deleted.has(q)) return null;
    return this.remote.get(q) ?? null;
  }

  /**
   * Fetch a remote file's bytes and keep them.
   *
   * Returns null for a path that is not remote or cannot be fetched. The
   * result is written into the overlay, so every later `read` is ordinary
   * and synchronous — which is what matters, because `read` is called from
   * Lua and Lua cannot wait.
   */
  async fetchRemote(path: string): Promise<Bytes | null> {
    const p = normalise(path, this.home);
    const ref = this.remoteAt(p);
    if (ref === null) return this.read(p);
    // ONE FETCH PER PATH, however many readers ask at once. softcut and
    // scsynth read the same tree and both fetch; a script triggering
    // several voices on one sample asks several times in the same tick.
    // Without this each of them downloaded the file again -- 9.3 MB twice
    // for amen's vinyl loop -- and each wrote it back, which the OPFS
    // mirror then persisted again.
    const already = this.inFlight.get(p);
    if (already) return already;
    const job = this.fetchOnce(p, ref).finally(() => void this.inFlight.delete(p));
    this.inFlight.set(p, job);
    return job;
  }

  private async fetchOnce(p: string, ref: RemoteFile): Promise<Bytes | null> {
    const res = await fetch(ref.url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.write(p, bytes);
    // Written, but not BY anyone. The overlay cannot tell a download from a
    // save on its own, and the difference matters the moment someone asks
    // for "everything I changed": an export that counted a cached sample as
    // a change came to 8.2 MB, of which 9.7 MB uncompressed was one file
    // the server will hand out again. `write` clears this, so editing a
    // fetched file makes it the user's after all.
    this.fetchedPaths.add(p);
    return bytes;
  }

  /** True when this path's bytes were downloaded here rather than written. */
  wasFetched(path: string): boolean {
    return this.fetchedPaths.has(normalise(path, this.home));
  }

  /**
   * E9-55 — the script folder, spelled the way it is actually spelled.
   *
   * The installer names a script's folder after the catalogue entry, folded
   * to lower case, and a script that builds its own paths out of something
   * CAPITALISED then misses by case alone:
   *
   *     Ygg.lua:36    local CODE_DIR = _path.code .. engine.name .. "/"
   *     Ygg.lua:1172  tree = screen.load_png(CODE_DIR .. "img/tree.png")
   *                   assert(tree, "tree.png failed to load")
   *
   * The engine is `Ygg`, the folder is `ygg`, and the script asserted its
   * way out of `init` with a file that was right there. E9-27 met the same
   * mismatch through `include` and answered it the same way: fix the
   * LOOKUP, because the two spellings are a disagreement and neither of
   * them is wrong -- renaming one would only move the miss to the scripts
   * that write the other.
   *
   * ONLY the first segment under `~/dust/code`, ONLY after the exact path
   * has already missed, and ONLY when exactly one folder matches when
   * folded. An ambiguous pair is left alone: answering one of two is worse
   * than answering neither, because the caller cannot tell it happened.
   */
  private fold(p: string): string {
    const CODE = "/home/we/dust/code/";
    if (!p.startsWith(CODE)) return p;
    const rest = p.slice(CODE.length);
    const slash = rest.indexOf("/");
    // The folder itself — `walk(code .. 'Ygg')` — as well as a path inside
    // it. Only the FOLDERS of `~/dust/code` are candidates, so a file
    // sitting directly in it (`code/Thing.lua`) matches nothing and is left
    // exactly as asked.
    const dir = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? "" : rest.slice(slash);
    if (dir === "") return p;
    const want = dir.toLowerCase();
    if (want === dir && this.hasPrefix(CODE + dir + "/")) return p;
    let hit: string | null = null;
    for (const name of this.list("/home/we/dust/code")) {
      if (!name.isDir) continue;
      if (name.name === dir) return p; // the exact spelling exists
      if (name.name.toLowerCase() !== want) continue;
      if (hit !== null) return p; // two folders differing only by case
      hit = name.name;
    }
    return hit === null ? p : CODE + hit + tail;
  }

  /** Is there any file under this prefix? Used only by `fold`. */
  private hasPrefix(prefix: string): boolean {
    for (const k of this.overlay.keys()) if (k.startsWith(prefix)) return true;
    for (const k of this.base.keys()) if (k.startsWith(prefix) && !this.deleted.has(k)) return true;
    for (const k of this.remote.keys()) if (k.startsWith(prefix) && !this.deleted.has(k)) return true;
    return false;
  }

  exists(path: string): boolean {
    const p = normalise(path, this.home);
    if (this.overlay.has(p)) return true;
    if (this.deleted.has(p)) return false;
    if (this.base.has(p) || this.remote.has(p)) return true;
    const q = this.fold(p);
    return q !== p && (this.overlay.has(q) || this.base.has(q) || this.remote.has(q));
  }

  /** A directory exists if anything lives under it, or mkdir made it. */
  isDir(path: string): boolean {
    const p = this.fold(normalise(path, this.home));
    if (p === "/") return true;
    if (this.emptyDirs.has(p)) return true;
    const prefix = p + "/";
    for (const k of this.overlay.keys()) if (k.startsWith(prefix)) return true;
    for (const k of this.base.keys()) {
      if (k.startsWith(prefix) && !this.deleted.has(k)) return true;
    }
    for (const k of this.remote.keys()) {
      if (k.startsWith(prefix) && !this.deleted.has(k)) return true;
    }
    return false;
  }

  /**
   * E9-31 — when a file was last written, for `stat -c %Y` and `touch -d`.
   *
   * ONLY FOR FILES THIS VFS HAS WRITTEN. A file that comes from the build
   * manifest has no honest answer here: the manifest is regenerated by
   * every build and restored fresh on every load, so any number would be a
   * property of the page's lifetime rather than of the file. `mtimeOf`
   * returns null for those and the shell's `stat` says so, rather than
   * inventing a timestamp that would sort a script's presets at random.
   *
   * The two scripts that read it — `tmi` and `twins` — both use it to
   * order the user's own PSETS, which are exactly the files that are in
   * the overlay and carry a real time.
   */
  private readonly mtimes = new Map<string, number>();

  /** Milliseconds since the epoch, or null when this VFS never wrote it. */
  mtimeOf(path: string): number | null {
    return this.mtimes.get(normalise(path, this.home)) ?? null;
  }

  /**
   * Say when a file was modified, for `touch -d` and for a move.
   *
   * Only for a file that EXISTS: a time on its own is not a file, and
   * recording one for a path with no bytes would make `stat` list it.
   */
  setMtime(path: string, at: number): void {
    const p = normalise(path, this.home);
    if (this.exists(p)) this.mtimes.set(p, at);
  }

  read(path: string): Bytes | null {
    const p = normalise(path, this.home);
    const w = this.overlay.get(p);
    if (w) return w;
    if (this.deleted.has(p)) return null;
    const supply = this.base.get(p);
    if (supply) return toBytes(supply());
    // See `fold`: a last resort, after the exact path has missed.
    const q = this.fold(p);
    if (q === p) return null;
    const folded = this.overlay.get(q);
    if (folded) return folded;
    if (this.deleted.has(q)) return null;
    const supplyFolded = this.base.get(q);
    return supplyFolded ? toBytes(supplyFolded()) : null;
  }

  readText(path: string): string | null {
    const b = this.read(path);
    return b === null ? null : decoder.decode(b);
  }

  write(path: string, data: Bytes | string): void {
    // NOT folded. A write creates what it names, which is the only way a
    // folder whose spelling differs by case alone can ever come to exist —
    // the installer writes through here too, and folding would have merged
    // a newly installed `Thing` into an existing `thing` without saying so.
    // Nothing is split by this: a script reads back the exact path it
    // wrote, and the fold is a LAST resort that only runs after an exact
    // miss.
    const p = normalise(path, this.home);
    this.overlay.set(p, toBytes(data));
    this.mtimes.set(p, Date.now());
    this.deleted.delete(p);
    this.fetchedPaths.delete(p);
    // Every parent now exists implicitly, so forget any mkdir placeholder.
    for (let d = dirname(p); d !== "/"; d = dirname(d)) this.emptyDirs.delete(d);
    this.changed(p);
  }

  /**
   * Is this path the SESSION'S, rather than the build's?
   *
   * The difference matters to anything that persists: the base arrives
   * fresh from the build on every load, and the overlay is the only part
   * that has to survive. `read` cannot answer it — it returns bytes either
   * way, which is the whole point of an overlay.
   */
  hasOverlay(path: string): boolean {
    return this.overlay.has(normalise(path, this.home));
  }

  /** Does the BUILD supply this path? The question `revert` turns on. */
  hasBase(path: string): boolean {
    return this.base.has(normalise(path, this.home));
  }

  /**
   * Put a path back to what the build supplies, if the build supplies it.
   *
   * NOT `remove`. Removing a base-backed path leaves a tombstone, because
   * a deleted file that reappeared on the next load would be a deletion
   * that did not happen — so `remove` is how you make a bundled file GO,
   * and this is how you undo an edit to one. Editing a bundled script
   * writes a copy that wins for ever, and until this existed the only way
   * back was to remember the original bytes and write them again.
   *
   * Returns false when there is nothing to fall back to, and changes
   * nothing: reverting a file you wrote yourself would be deleting it,
   * and that is a different word.
   */
  revert(path: string): boolean {
    const p = normalise(path, this.home);
    if (!this.base.has(p)) return false;
    const had = this.overlay.delete(p) || this.deleted.delete(p);
    if (had) this.changed(p);
    return true;
  }

  remove(path: string): boolean {
    const p = normalise(path, this.home);
    const had = this.exists(p) || this.emptyDirs.has(p);
    this.overlay.delete(p);
    this.mtimes.delete(p);
    // THE PLACEHOLDER GOES TOO, and the ones beneath it.
    //
    // A directory made by `mkdir` and still empty exists only as a name in
    // this set, so deleting it did nothing at all: the folder stayed in
    // every listing with no way to be rid of it. Found by deleting a
    // folder in the editor and watching it survive.
    this.emptyDirs.delete(p);
    const prefix = p + "/";
    for (const d of [...this.emptyDirs]) if (d.startsWith(prefix)) this.emptyDirs.delete(d);
    // A tombstone, not an omission: without it a deleted base file reappears.
    //
    // E9-31: AND A DECLARED REMOTE NEEDS ONE TOO. A sound file the manifest
    // names but nothing has downloaded lives only in `remote`, which this
    // never touched — so `rm` on one returned true and `exists` went on
    // saying yes, and a `mv` built out of copy-then-delete left the file at
    // both ends. Found by moving one.
    if (this.base.has(p) || this.remote.has(p)) this.deleted.add(p);
    this.changed(p);
    return had;
  }

  mkdir(path: string): void {
    const p = normalise(path, this.home);
    if (!this.isDir(p)) {
      this.emptyDirs.add(p);
      this.changed(p);
    }
  }

  /** Directories made but never written into, which a mirror must keep. */
  placeholders(): string[] {
    return [...this.emptyDirs];
  }

  /**
   * Put a file back WITHOUT telling the watchers.
   *
   * For a persistence mirror reading its own store at boot. `write` would
   * report every restored file as a change and the mirror would copy the
   * whole tree straight back out again, which is a lot of work to reach the
   * state it was already in.
   */
  restore(path: string, data: Bytes, mtime?: number | undefined): void {
    const p = normalise(path, this.home);
    this.overlay.set(p, data);
    // The REAL time, when the caller knows it. OPFS files carry a
    // `lastModified` the browser maintains, so a restored pset keeps the
    // moment it was saved rather than the moment the page came up — which
    // is the whole difference between `stat -c %Y` being useful and being
    // a clock that resets on every reload.
    if (mtime !== undefined) this.mtimes.set(p, mtime);
    this.deleted.delete(p);
    // A restored file the MANIFEST still declares is a cached download, not
    // the user's work. OPFS keeps bytes and not provenance, so this is the
    // only signal left after a reload — and without it an export of "what
    // you changed" carries back every sample a script ever played.
    if (this.remote.has(p)) this.fetchedPaths.add(p);
    for (let d = dirname(p); d !== "/"; d = dirname(d)) this.emptyDirs.delete(d);
  }

  /** Immediate children, sorted, directories and files alike. */
  list(path: string): DirEntry[] {
    // `fold` answers for `~/dust/code` itself without listing anything, so
    // the call it makes back into here cannot recur.
    const dir = this.fold(normalise(path, this.home));
    const prefix = dir === "/" ? "/" : dir + "/";
    const names = new Map<string, boolean>(); // name -> isDir

    /**
     * `asDir` is for the empty-directory set, and it is not a detail.
     *
     * Those keys ARE the directory, not a file inside it, so they land in
     * the `slash === -1` branch that means "a leaf" for every other source
     * — and an empty folder came back as a FILE. `isDir` said directory and
     * this said file about the same path, which is as wrong as a filesystem
     * gets. Found by building a file tree over this and watching
     * `dust/audio/amen` refuse to open because it was a folder, while the
     * tree had drawn it as something openable.
     *
     * The consequence outside the tree is the one E5-43 already cost a day:
     * `util.scandir` is `ls -pL`, the shell shim marks directories with the
     * trailing slash this flag decides, and a script asking which folders
     * exist would be told one of them is a file. A script's own
     * `util.make_dir` on first run is exactly how such a folder appears.
     */
    const consider = (full: string, asDir = false): void => {
      if (!full.startsWith(prefix)) return;
      const rest = full.slice(prefix.length);
      if (!rest) return;
      const slash = rest.indexOf("/");
      if (slash === -1) names.set(rest, (names.get(rest) ?? false) || asDir);
      else names.set(rest.slice(0, slash), true);
    };

    for (const k of this.base.keys()) if (!this.deleted.has(k)) consider(k);
    for (const k of this.remote.keys()) if (!this.deleted.has(k)) consider(k);
    for (const k of this.overlay.keys()) consider(k);
    for (const k of this.emptyDirs) consider(k, true);

    return [...names.entries()]
      .map(([name, isDir]) => ({ name, isDir }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every file at or below `path`, sorted. Directories are not included. */
  walk(path: string): string[] {
    const dir = this.fold(normalise(path, this.home));
    const prefix = dir === "/" ? "/" : dir + "/";
    const out = new Set<string>();
    for (const k of this.base.keys()) {
      if (k.startsWith(prefix) && !this.deleted.has(k)) out.add(k);
    }
    for (const k of this.remote.keys()) {
      if (k.startsWith(prefix) && !this.deleted.has(k)) out.add(k);
    }
    for (const k of this.overlay.keys()) if (k.startsWith(prefix)) out.add(k);
    return [...out].sort();
  }

  size(path: string): number | null {
    // The manifest knows a remote file's size without fetching it, and a
    // caller asking for a size is usually deciding whether to read at all.
    const ref = this.remoteAt(path);
    if (ref !== null) return ref.size;
    const b = this.read(path);
    return b === null ? null : b.length;
  }

  /** Everything the session has written, for persisting it (E6-01 follow-up). */
  dirty(): Array<{ path: string; data: Bytes }> {
    return [...this.overlay.entries()].map(([path, data]) => ({ path, data }));
  }

  /** Paths deleted from the read-only base, which persistence must remember. */
  tombstones(): string[] {
    return [...this.deleted];
  }
}

/**
 * The directories norns expects to exist before it writes anything.
 *
 * `~/dust/data` holds favourites, PSETs and settings, and the very first
 * thing SELECT does is `tabutil.save` the favourites — into a path whose
 * parent a real filesystem would insist on.
 */
/**
 * What `norns.version.update` reports.
 *
 * `core/norns.lua:176` reads `~/version.txt`, and with no file there it
 * settles on `"000000"` -- which is not a neutral default. Scripts gate on
 * it: `dreamsequence` declares `norns.version.required = 231114` and
 * `Script.run` refuses to start anything whose requirement is higher, so a
 * host with no version file cannot run a script written after 2000.
 *
 * The number is the commit date of the norns tree under `third_party/`,
 * because that is the Lua API a script is actually being offered here. It
 * must be bumped with that tree -- claiming a version we do not ship would
 * send a script looking for functions that are not there.
 */
export const NORNS_VERSION = "261026";

export function seedDust(vfs: Vfs): void {
  for (const d of ["/home/we/dust", "/home/we/dust/code", "/home/we/dust/data", "/home/we/dust/audio"]) {
    vfs.mkdir(d);
  }
  if (vfs.readText("/home/we/version.txt") === null) {
    vfs.write("/home/we/version.txt", NORNS_VERSION + "\n");
  }
}
