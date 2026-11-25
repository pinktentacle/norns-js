// E9-228 — zip, tar and tar.gz, told apart by their bytes.

import { describe, expect, it } from "vitest";
import { unpack, untar } from "../src/fs/unpack.js";
import { zip } from "../src/fs/zip.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A ustar header, checksummed as tar writes it. */
function header(name: string, size: number, type = "0", prefix = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (at: number, s: string) => h.set(enc(s), at);
  put(0, name);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, size.toString(8).padStart(11, "0") + "\0");
  put(136, "00000000000\0");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  put(345, prefix);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const v of h) sum += v;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}
const pad = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(b.length / 512) * 512);
  out.set(b);
  return out;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const file = (name: string, body: string, prefix = "") => cat(header(name, enc(body).length, "0", prefix), pad(enc(body)));
const end = new Uint8Array(1024);

const gzip = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

describe("a tar", () => {
  it("gives its files at their paths, and skips folders and links", () => {
    const tar = cat(
      header("lorenzos-drums/", 0, "5"),
      file("lorenzos-drums/kick/1.wav", "RIFF-kick"),
      header("lorenzos-drums/link", 0, "2"),
      file("lorenzos-drums/snare/2.wav", "RIFF-snare"),
      end,
    );
    const got = untar(tar);
    expect(got.map((e) => [e.path, dec(e.bytes)])).toEqual([
      ["lorenzos-drums/kick/1.wav", "RIFF-kick"],
      ["lorenzos-drums/snare/2.wav", "RIFF-snare"],
    ]);
  });

  it("joins the ustar prefix, and takes a PAX path or a GNU long name over the header's", () => {
    const long = "x".repeat(120) + ".wav";
    const paxBody = (() => {
      const rec = ` path=deep/${long}\n`;
      let len = rec.length;
      len += String(len + String(len).length).length;
      return `${len}${rec}`;
    })();
    const tar = cat(
      file("a.wav", "1", "amens"),
      cat(header("PaxHeader", enc(paxBody).length, "x"), pad(enc(paxBody))),
      file("short-name", "2"),
      cat(header("././@LongLink", long.length + 1, "L"), pad(enc(long + "\0"))),
      file("trunc", "3"),
      end,
    );
    expect(untar(tar).map((e) => e.path)).toEqual(["amens/a.wav", `deep/${long}`, long]);
  });

  it("refuses bytes that are not a tar rather than inventing files", () => {
    expect(() => untar(new Uint8Array(1024).fill(65))).toThrow(/not a tar/);
  });
});

describe("unpack", () => {
  it("reads a zip, a tar and a tar.gz the same way", async () => {
    const z = await zip([{ path: "moonraker/1/a.wav", bytes: enc("z") }]);
    const t = cat(file("amenbreak/a.wav", "t"), end);
    const tgz = await gzip(t);
    expect((await unpack(z)).map((e) => e.path)).toEqual(["moonraker/1/a.wav"]);
    expect((await unpack(t)).map((e) => e.path)).toEqual(["amenbreak/a.wav"]);
    expect((await unpack(tgz)).map((e) => [e.path, dec(e.bytes)])).toEqual([["amenbreak/a.wav", "t"]]);
  });

  it("says what it cannot read", async () => {
    await expect(unpack(enc("BZh91AY&SY"))).rejects.toThrow(/bzip2/);
    await expect(unpack(await gzip(enc("just one file")))).rejects.toThrow(/not a tar/);
    await expect(unpack(enc("<!doctype html>"))).rejects.toThrow(/not an archive/);
  });
});
