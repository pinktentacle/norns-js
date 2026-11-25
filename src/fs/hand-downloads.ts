// E9-226 — a download a page cannot make, finished by hand.
//
// mx.samples installs an instrument the way a norns does it, in four shell
// lines: `mkdir`, `curl -L -o …/download.zip https://github.com/…/releases/
// download/samples/<id>.zip`, `unzip …/download.zip -d …/<id>/`, `rm`. The
// shell already hands `curl -o` to the page (E9-37), and the page fetched
// it — and GitHub's release downloads answer a page with a redirect and no
// CORS header, at both hops, so the fetch could never succeed. And `unzip`
// was not a command here at all. The instrument never arrived; the script
// listed nothing.
//
// No page can fetch those bytes, but a PERSON can download the file in one
// tap. So the attempt is remembered — where the script wanted the file and,
// if it then asked for it to be unzipped, where the contents go — and the
// person is asked for the file. When it is handed over it lands exactly
// where the shell commands would have put it. A fetch that does work (any
// host that sends CORS) is finished here too, unzip included.
//
// A plain registry with no DOM: `main.ts` owns the asking.

import type { Vfs } from "./vfs.js";

export interface HandDownload {
  readonly url: string;
  /** Where the script asked for the file to be written. */
  readonly dest: string;
  /** Where `unzip` was asked to put its contents, once it was. */
  unzipTo?: string;
  /** The page could not fetch it; a person has been asked. */
  askedFor: boolean;
}

export interface HandDownloadsOptions {
  readonly vfs: Vfs;
  /** An archive's entries, as `transfer.ts` reads them. */
  readonly unzip: (bytes: Uint8Array) => Promise<Array<{ path: string; bytes: Uint8Array }>>;
  readonly log?: (line: string) => void;
  /** Ask a person for this file. Called once per download. */
  readonly onAsk: (d: HandDownload) => void;
}

export interface HandDownloads {
  /**
   * The shell handed up `curl -o` / `wget -O` for this url and path — and,
   * from a one-line `wget … && unzip …` (E9-227), where it is unzipped.
   */
  started(url: string, dest: string, unzipTo?: string): void;
  /**
   * The page fetched it (E9-227: often through its own server's relay).
   * The bytes are written where the script said, or — when an `unzip` is
   * waiting on them — unzipped and NOT written: the script's `rm` of the
   * archive ran long before the archive arrived, and 95 MB of zip left
   * beside its own contents is storage the person never asked to spend.
   */
  fetched(dest: string, bytes: Uint8Array): Promise<void>;
  /** The page could not fetch it. */
  failed(dest: string, why: string): void;
  /** The shell handed up `unzip <zip> -d <dir>`. */
  unzip(zip: string, dir: string): Promise<void>;
  /** A person handed the file over. Returns how many files landed. */
  provide(dest: string, bytes: Uint8Array): Promise<number>;
  /** What is still waiting, newest last. */
  pending(): HandDownload[];
}

const SKIP = /(^|\/)(__MACOSX\/|\.DS_Store$)/;

export function createHandDownloads(opts: HandDownloadsOptions): HandDownloads {
  const log = opts.log ?? (() => {});
  const byDest = new Map<string, HandDownload>();

  /** Write an archive's entries under `dir`, as `unzip -d` does: paths kept. */
  const extract = async (bytes: Uint8Array, dir: string): Promise<number> => {
    const entries = await opts.unzip(bytes);
    let n = 0;
    for (const e of entries) {
      // `moonraker//1/x.wav`: its pack has a doubled slash in every path.
      const rel = e.path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
      if (rel === "" || rel.endsWith("/") || SKIP.test(rel) || rel.split("/").includes("..")) continue;
      opts.vfs.write(`${dir.replace(/\/+$/, "")}/${rel}`, e.bytes);
      n++;
    }
    return n;
  };

  const finish = async (d: HandDownload, bytes: Uint8Array): Promise<number> => {
    byDest.delete(d.dest);
    if (d.unzipTo === undefined) {
      opts.vfs.write(d.dest, bytes);
      log(`download: ${d.dest} is in place (${(bytes.length / 1048576).toFixed(1)} MB)`);
      return 1;
    }
    const n = await extract(bytes, d.unzipTo);
    log(`download: ${n} file(s) unzipped into ${d.unzipTo}`);
    return n;
  };

  return {
    started(url, dest, unzipTo) {
      byDest.set(dest, { url, dest, askedFor: false, ...(unzipTo !== undefined ? { unzipTo } : {}) });
    },
    async fetched(dest, bytes) {
      const d = byDest.get(dest);
      if (d === undefined || d.unzipTo === undefined) {
        if (d !== undefined) byDest.delete(dest);
        opts.vfs.write(dest, bytes);
        return;
      }
      await finish(d, bytes);
    },
    failed(dest, why) {
      const d = byDest.get(dest);
      if (d === undefined || d.askedFor) return;
      d.askedFor = true;
      log(`download: ${d.url} cannot be fetched by a page (${why}) — asking for it by hand`);
      opts.onAsk(d);
    },
    async unzip(zip, dir) {
      const here = opts.vfs.read(zip);
      if (here !== null) {
        const n = await extract(here, dir);
        log(`unzip: ${n} file(s) from ${zip} into ${dir}`);
        return;
      }
      const d = byDest.get(zip);
      if (d === undefined) {
        log(`unzip: ${zip} is not there`);
        return;
      }
      // The download is still on its way, or waiting for a person: the
      // contents go where this asked, whenever the file comes.
      d.unzipTo = dir;
    },
    async provide(dest, bytes) {
      const d = byDest.get(dest);
      if (d === undefined) return 0;
      return finish(d, bytes);
    },
    pending: () => [...byDest.values()],
  };
}
