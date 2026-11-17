// The one door the editor reaches its files through.
//
// WHY AN INTERFACE AND NOT THE VFS DIRECTLY. The editor lives in the page
// today, where the store is a function call away. The alternative that was
// weighed and set aside — a second browser window, files over OPFS and the
// REPL over a BroadcastChannel — is the same five operations with a
// synchronisation problem behind them. Keeping them behind one small
// interface is what makes that a swap rather than a rewrite, and it costs
// about forty lines.
//
// WHAT IT REFUSES, AND WHY THAT IS THE POINT. A file tree over this store
// is not a file tree over a disk. Three of the things in it cannot be
// edited and each would fail differently and silently:
//
//   a DECLARED file  — the manifest says it exists and where, and its bytes
//                      have never been fetched. `vfs.read` answers null,
//                      which an editor would show as an empty buffer and
//                      save back as an empty file. That is 9.7 MB of amen
//                      break destroyed by Ctrl-S. (E5-38, E5-40.)
//   a BINARY file    — a .wav that IS here decodes to replacement
//                      characters, and saving those writes mangled UTF-8
//                      over the sample. Same loss, different route.
//   a DIRECTORY      — opens as nothing at all.
//
// So `open` returns a refusal with a reason rather than a string, and the
// reason is shown. An editor that cannot say why it will not open something
// teaches people that it is broken.

import type { Vfs } from "../fs/vfs.js";

/** Whether a file's bytes are actually here. */
export type Presence = "here" | "remote" | "gone";

export interface EditorEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir" | "file";
  readonly presence: Presence;
  /** Bytes, which a declared file knows without having them. */
  readonly size: number | null;
  /**
   * Written in this session rather than supplied by the build.
   *
   * The dust tree is mounted read-only and writes land in an overlay that
   * wins, so editing a bundled script makes a copy — which is what you
   * want, and which the tree has to show, or there is no way to tell what
   * a reset would take away.
   */
  readonly mine: boolean;
}

export type Opened = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string };

/** What a file operation did, or why it would not. */
export type FileOp =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly why: string };

export interface EditorStore {
  readonly root: string;
  list(path: string): EditorEntry[];
  open(path: string): Opened;
  save(path: string, text: string): void;
  /** An empty file, or a folder. */
  create(path: string, kind: "file" | "folder"): FileOp;
  /** Move one path to another, a whole subtree if it is a folder. */
  rename(from: string, to: string): FileOp;
  /** Delete, a whole subtree if it is a folder. */
  remove(path: string): FileOp;
  /** Beside the original, under a free name. */
  duplicate(path: string): FileOp;
  /** Is this a folder? The file actions ask before deciding what they mean. */
  isDir(path: string): boolean;
  /** True when the build supplies this path, so an edit can be undone. */
  canRevert(path: string): boolean;
  /** Put it back to what the build supplies. */
  revert(path: string): FileOp;
  /** Called when anything under the root changed. Returns an unsubscribe. */
  watch(fn: () => void): () => void;
}

/** `awake.lua` -> `awake-copy.lua`, `awake-copy-2.lua`, and so on. */
function freeName(taken: (p: string) => boolean, path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const stem = dot > slash ? path.slice(0, dot) : path;
  const ext = dot > slash ? path.slice(dot) : "";
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? `${stem}-copy${ext}` : `${stem}-copy-${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem}-copy-${Date.now()}${ext}`;
}

/**
 * Bigger than any script, smaller than a sample.
 *
 * `cheat_codes_2` is the largest Lua file in the bundled tree at about
 * 150 kB, so a megabyte is room to spare; a sound file that reached here
 * without the UTF-8 check catching it is stopped by this instead.
 */
const MAX_TEXT_BYTES = 1024 * 1024;

export function createVfsStore(vfs: Vfs, root = "/home/we/dust"): EditorStore {
  /**
   * Which paths are the user's own.
   *
   * `dirty()` is every overlay entry, and that includes files merely
   * DOWNLOADED — reading a lazily-fetched sample caches its bytes in the
   * same overlay a written file lands in. `wasFetched` is the difference,
   * and the export code learned it the expensive way: an export of "what
   * you changed" that came to 8.2 MB.
   */
  const mineSet = (): Set<string> => {
    const out = new Set<string>();
    for (const d of vfs.dirty()) if (!vfs.wasFetched(d.path)) out.add(d.path);
    return out;
  };

  /**
   * Nothing outside the tree, and nothing with a `..` in it.
   *
   * The names come from a text box, and a text box is where
   * `../../etc/passwd` comes from — `transfer.ts` learned that about
   * archives and the same holds here.
   */
  const within = (path: string): string | null => {
    if (!path.startsWith(root + "/")) return "outside the dust tree";
    if (path.split("/").includes("..")) return "that name climbs out of the tree";
    if (path.endsWith("/")) return "that has no name";
    return null;
  };

  const presenceOf = (path: string): Presence => {
    if (vfs.remoteAt(path) !== null) return "remote";
    return vfs.exists(path) ? "here" : "gone";
  };

  return {
    root,

    list(path) {
      const mine = mineSet();
      return vfs
        .list(path)
        .map((e) => {
          const full = `${path}/${e.name}`;
          return {
            name: e.name,
            path: full,
            kind: e.isDir ? ("dir" as const) : ("file" as const),
            presence: e.isDir ? ("here" as const) : presenceOf(full),
            size: e.isDir ? null : vfs.size(full),
            mine: mine.has(full),
          };
        })
        .sort((a, b) =>
          a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
        );
    },

    open(path) {
      if (vfs.isDir(path)) return { ok: false, why: "that is a folder" };
      if (vfs.remoteAt(path) !== null) {
        return {
          ok: false,
          why: "not downloaded — this file loads when a script plays it",
        };
      }
      const bytes = vfs.read(path);
      if (bytes === null) return { ok: false, why: "no such file" };
      if (bytes.length > MAX_TEXT_BYTES) {
        return { ok: false, why: `too big to edit — ${Math.round(bytes.length / 1024)} kB` };
      }
      try {
        // FATAL, not the forgiving default. A lenient decode turns a sample
        // into replacement characters, and saving those back writes
        // nonsense over the file. Throwing here is the file saying it is
        // not text.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { ok: true, text };
      } catch {
        return { ok: false, why: "not a text file" };
      }
    },

    create(path, kind) {
      const guard = within(path);
      if (guard !== null) return { ok: false, why: guard };
      if (vfs.exists(path) || vfs.isDir(path)) return { ok: false, why: "there is one already" };
      if (kind === "folder") vfs.mkdir(path);
      else vfs.write(path, "");
      return { ok: true, path };
    },

    rename(from, to) {
      const guard = within(to) ?? within(from);
      if (guard !== null) return { ok: false, why: guard };
      if (from === to) return { ok: true, path: to };
      if (vfs.exists(to) || vfs.isDir(to)) return { ok: false, why: "there is one there already" };
      if (vfs.isDir(from)) {
        // A FOLDER IS ITS CONTENTS. There is no directory object to move:
        // every path under it is moved, and the folder stops existing
        // because nothing is under it any more.
        const under = vfs.walk(from);
        if (under.length === 0) {
          vfs.mkdir(to);
          return { ok: true, path: to };
        }
        for (const p of under) {
          const bytes = vfs.read(p);
          if (bytes === null) continue;
          vfs.write(to + p.slice(from.length), bytes);
          vfs.remove(p);
        }
        return { ok: true, path: to };
      }
      const bytes = vfs.read(from);
      if (bytes === null) {
        return { ok: false, why: "it has no bytes here to move" };
      }
      vfs.write(to, bytes);
      vfs.remove(from);
      return { ok: true, path: to };
    },

    remove(path) {
      const guard = within(path);
      if (guard !== null) return { ok: false, why: guard };
      if (vfs.isDir(path)) {
        for (const p of vfs.walk(path)) vfs.remove(p);
        // And the folder itself, which may be nothing but a placeholder
        // from `mkdir` — `walk` only answers with files.
        vfs.remove(path);
        return { ok: true, path };
      }
      if (!vfs.exists(path)) return { ok: false, why: "it is not there" };
      vfs.remove(path);
      return { ok: true, path };
    },

    duplicate(path) {
      const guard = within(path);
      if (guard !== null) return { ok: false, why: guard };
      if (vfs.isDir(path)) return { ok: false, why: "folders are not duplicated" };
      const bytes = vfs.read(path);
      if (bytes === null) {
        // A declared file has no bytes here, and a copy of nothing is a
        // zero-length file wearing the name of a 9 MB sample.
        return { ok: false, why: "not downloaded — there is nothing here to copy" };
      }
      const to = freeName((p) => vfs.exists(p) || vfs.isDir(p), path);
      vfs.write(to, bytes);
      return { ok: true, path: to };
    },

    isDir(path) {
      return vfs.isDir(path);
    },

    canRevert(path) {
      // Asked of the VFS rather than guessed from the tag: a file can be
      // the session's AND the build's, which is exactly the case this is
      // for.
      return vfs.hasBase(path);
    },

    revert(path) {
      const guard = within(path);
      if (guard !== null) return { ok: false, why: guard };
      if (!vfs.revert(path)) return { ok: false, why: "the build does not supply this one" };
      return { ok: true, path };
    },

    save(path, text) {
      // Through the VFS, which notifies its watchers — and the OPFS mirror
      // is one of them, so a save survives a reload without this knowing
      // that persistence exists.
      vfs.write(path, text);
    },

    watch(fn) {
      return vfs.watch(() => fn());
    },
  };
}
