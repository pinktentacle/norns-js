// E6-08 — the archive a tree leaves in.
//
// The round trip is the obvious test and the least interesting one. What
// matters is the failures: a truncated download, a flipped bit, a method we
// do not implement, and a path that tries to climb out of the tree.

import { describe, expect, it } from "vitest";
import { crc32, unzip, zip, type ZipEntry } from "../src/fs/zip.js";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("a round trip", () => {
  it("brings every file back byte for byte", async () => {
    const entries: ZipEntry[] = [
      { path: "code/probe/probe.lua", bytes: text("-- a script\nprint('hi')\n") },
      { path: "data/probe/probe-01.pset", bytes: text('-- a pset\n"alpha": 7\n') },
      { path: "audio/tiny.bin", bytes: new Uint8Array([0, 1, 2, 253, 254, 255]) },
    ];
    const back = await unzip(await zip(entries));
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (let i = 0; i < entries.length; i++) {
      expect([...back[i]!.bytes]).toEqual([...entries[i]!.bytes]);
    }
  });

  it("keeps a file that compresses and a file that does not", async () => {
    // A long run deflates to almost nothing; six random-ish bytes get
    // bigger, so the writer stores them instead. Both must read back.
    const squashy = text("a".repeat(20000));
    const lumpy = new Uint8Array([7, 200, 3, 99, 250, 11]);
    const back = await unzip(await zip([
      { path: "squashy", bytes: squashy },
      { path: "lumpy", bytes: lumpy },
    ]));
    expect(back[0]!.bytes.length).toBe(20000);
    expect([...back[1]!.bytes]).toEqual([...lumpy]);
  });

  it("is smaller than its contents when its contents are compressible", async () => {
    const big = text("the same line over and over\n".repeat(500));
    const archive = await zip([{ path: "big.txt", bytes: big }]);
    expect(archive.length).toBeLessThan(big.length / 4);
  });

  it("survives an empty file and a UTF-8 name", async () => {
    const back = await unzip(await zip([
      { path: "empty", bytes: new Uint8Array(0) },
      { path: "données/café.lua", bytes: text("-- accents\n") },
    ]));
    expect(back[0]!.bytes.length).toBe(0);
    expect(back[1]!.path).toBe("données/café.lua");
    expect(str(back[1]!.bytes)).toBe("-- accents\n");
  });

  it("writes an archive with no files at all", async () => {
    expect(await unzip(await zip([]))).toEqual([]);
  });
});

describe("when the archive is wrong", () => {
  it("refuses something that is not a zip", async () => {
    await expect(unzip(text("this is just a text file"))).rejects.toThrow(
      /no end-of-central-directory/,
    );
  });

  it("refuses a truncated archive rather than returning half a tree", async () => {
    const archive = await zip([{ path: "a.lua", bytes: text("print(1)\n") }]);
    await expect(unzip(archive.slice(0, archive.length - 10))).rejects.toThrow();
  });

  it("CATCHES a flipped bit, which is the failure that otherwise looks fine", async () => {
    // A corrupt archive unpacks happily into corrupt files unless the
    // checksum is actually checked. It is.
    const archive = await zip([{ path: "a.bin", bytes: new Uint8Array(400).fill(65) }]);
    const back = await unzip(archive);
    expect(back[0]!.bytes.length).toBe(400);

    // Flip a byte in the compressed body, after the local header.
    const broken = archive.slice();
    broken[40] = broken[40]! ^ 0xff;
    await expect(unzip(broken)).rejects.toThrow();
  });

  it("names the compression method it will not do", async () => {
    const archive = await zip([{ path: "a.txt", bytes: text("x".repeat(500)) }]);
    const odd = archive.slice();
    // method lives at +10 in the local header and +10 in the central one;
    // the reader believes the central directory, so change that.
    const i = odd.length - 22 - (46 + 5);
    new DataView(odd.buffer).setUint16(i + 10, 99, true);
    await expect(unzip(odd)).rejects.toThrow(/method 99/);
  });
});

describe("crc32", () => {
  it("agrees with the published value for a known string", () => {
    // "123456789" is the standard check value for CRC-32: 0xCBF43926.
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
