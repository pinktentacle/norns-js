// E9-268 — the sound files scsynth writes, carried out of its filesystem.
//
// scsynth is built with libsndfile now (tools/sclang/build-sndfile.sh), so
// `/b_write` does what it says: Buffer.write, Recorder and DiskOut write
// AIFF and WAV through the server's own code. But the server is a separate
// wasm module with its own MEMFS, and a script's files live in the page's
// filesystem (ADR-04c), so two things have to happen around each write:
//
//   BEFORE   the folder exists in the server's filesystem. libsndfile opens
//            the path and fails when its directory is missing, and every
//            script writes somewhere under ~/dust that the server has never
//            heard of.
//   AFTER    the finished file is copied into the page's filesystem, where
//            the script, the editor and persistence can see it, and dropped
//            from the server's, which would otherwise keep a second copy of
//            every recording.
//
// "Finished" is the server's word for it: `/done /b_write` for a file
// written whole, and for one left OPEN — Recorder's `/b_alloc` carries a
// `/b_write` with leaveOpen=1, then DiskOut streams into it until `/b_close`
// — the `/done` of the `/b_close` (or `/b_free`, which closes it too). A
// file still being written is never copied half-done.
//
// The `/b_write` can be anywhere in a packet: alone, in a bundle, or as the
// COMPLETION MESSAGE of another command, which is exactly where Recorder
// puts it. All three are read here.

import { decode } from "./osc.js";

export interface SoundWrite {
  readonly bufnum: number;
  readonly path: string;
  readonly leaveOpen: boolean;
}

type Msg = { address?: string; args?: Array<number | string | Uint8Array>; bundle?: Msg[] };

/** Every `/b_write` a packet asks for, completion messages and bundles included. */
export function writesIn(bytes: Uint8Array): SoundWrite[] {
  // "/b_" or "#bundle": nothing else can hold one, and a note never reaches decode.
  const b0 = bytes[0];
  if (!(b0 === 0x2f && bytes[1] === 0x62 && bytes[2] === 0x5f) && b0 !== 0x23) return [];
  let m: Msg;
  try {
    m = decode(bytes) as Msg;
  } catch {
    return [];
  }
  const out: SoundWrite[] = [];
  const walk = (x: Msg, depth: number): void => {
    if (depth > 4) return;
    if (x.bundle !== undefined) {
      for (const e of x.bundle) walk(e, depth + 1);
      return;
    }
    const a = x.args ?? [];
    if (x.address === "/b_write" && typeof a[0] === "number" && typeof a[1] === "string") {
      out.push({ bufnum: a[0], path: a[1], leaveOpen: typeof a[6] === "number" && a[6] !== 0 });
    }
    // A completion message is an OSC blob — NOT always the last argument:
    // `/b_alloc` puts the sample rate after it (`,iiibf`, measured from
    // Recorder), so every blob is looked into.
    for (const blob of a) {
      if (!(blob instanceof Uint8Array) || blob.length === 0) continue;
      try {
        walk(decode(blob) as Msg, depth + 1);
      } catch {
        /* a blob that is not OSC is not a completion message */
      }
    }
  };
  walk(m, 0);
  return out;
}

export interface WriteTrackerOptions {
  /** Make a folder in the SERVER's filesystem. */
  readonly mkdir: (dir: string) => void;
  /** Read a file from the server's filesystem, or null when it is not there. */
  readonly readFile: (path: string) => Uint8Array | null;
  readonly unlink: (path: string) => void;
  /** A finished file, for the page's filesystem. */
  readonly onFile: (path: string, bytes: Uint8Array) => void;
  readonly log?: (line: string) => void;
}

export interface WriteTracker {
  /** Every packet on its way from sclang to the server, before it is forwarded. */
  fromLang(bytes: Uint8Array): void;
  /** Every `/done` and `/fail` from the server, with its arguments. */
  fromServer(address: string, args: ReadonlyArray<number | string | Uint8Array>): void;
}

const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
};

export function createWriteTracker(opts: WriteTrackerOptions): WriteTracker {
  const log = opts.log ?? ((): void => {});
  /** Whole-file writes waiting for their `/done`, in order, per buffer. */
  const whole = new Map<number, string[]>();
  /** Files left open for DiskOut, until the buffer is closed or freed. */
  const open = new Map<number, string>();

  const carry = (path: string): void => {
    const bytes = opts.readFile(path);
    if (bytes === null) {
      log(`sound file: the server said ${path} was written, and it is not there`);
      return;
    }
    opts.onFile(path, bytes);
    try {
      opts.unlink(path);
    } catch {
      /* already gone is fine */
    }
  };

  return {
    fromLang(bytes) {
      for (const w of writesIn(bytes)) {
        try {
          opts.mkdir(dirOf(w.path));
        } catch (e) {
          log(`sound file: could not make ${dirOf(w.path)} for the server — ${(e as Error).message}`);
        }
        if (w.leaveOpen) open.set(w.bufnum, w.path);
        else whole.set(w.bufnum, [...(whole.get(w.bufnum) ?? []), w.path]);
      }
    },
    fromServer(address, args) {
      const cmd = String(args[0] ?? "");
      if (address === "/fail") {
        // `/fail <cmd> <why>`: no buffer number to match, so said and left.
        if (cmd === "/b_write") log(`sound file: the server could not write it — ${String(args[1] ?? "")}`);
        return;
      }
      const bufnum = Number(args[1] ?? -1);
      if (cmd === "/b_write") {
        const q = whole.get(bufnum);
        const path = q?.shift();
        if (q !== undefined && q.length === 0) whole.delete(bufnum);
        if (path === undefined) return; // a leaveOpen write: its file is still open
        carry(path);
        return;
      }
      if ((cmd === "/b_close" || cmd === "/b_free") && address === "/done") {
        const path = open.get(bufnum);
        if (path === undefined) return;
        open.delete(bufnum);
        carry(path);
      }
    },
  };
}
