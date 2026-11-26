// E9-226 — a download a page cannot make, finished by hand; and `unzip`.

import { describe, expect, it } from "vitest";
import { createHandDownloads, type HandDownload } from "../src/fs/hand-downloads.js";
import { runShell } from "../src/fs/shell.js";
import { Vfs } from "../src/fs/vfs.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** A stand-in for zip.ts: the "archive" is JSON of path -> text. */
const fakeUnzip = async (bytes: Uint8Array) =>
  Object.entries(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>).map(([path, t]) => ({
    path,
    bytes: enc(t),
  }));

describe("the shell's unzip", () => {
  it("hands up mx.samples' line, archive and destination", () => {
    const r = runShell(new Vfs(), "unzip /home/we/dust/audio/mx.samples/ghost_piano/download.zip -d /home/we/dust/audio/mx.samples/ghost_piano/");
    expect(r.ok).toBe(false);
    expect(r.fetch).toEqual({
      kind: "unzip",
      url: "/home/we/dust/audio/mx.samples/ghost_piano/download.zip",
      dest: "/home/we/dust/audio/mx.samples/ghost_piano",
    });
  });

  it("reads `cd X && unzip y.zip` as unzipping into X", () => {
    const r = runShell(new Vfs(), "cd ~/dust/audio && unzip -o moonraker.zip");
    expect(r.fetch).toEqual({ kind: "unzip", url: "/home/we/dust/audio/moonraker.zip", dest: "/home/we/dust/audio" });
  });

  it("E9-227: reads moonraker's README line as one download, unzipped where it lands", () => {
    const line =
      "cd ~/dust/audio && echo 'downloading...' && wget -q https://github.com/schollz/moonraker/releases/download/samplepack1/moonraker.zip && unzip moonraker.zip && rm moonraker.zip; echo 'ready (make sure to restart)'";
    const r = runShell(new Vfs(), line);
    expect(r.ok).toBe(false);
    expect(r.fetch).toEqual({
      kind: "file",
      url: "https://github.com/schollz/moonraker/releases/download/samplepack1/moonraker.zip",
      dest: "/home/we/dust/audio/moonraker.zip",
      unzipTo: "/home/we/dust/audio",
    });
  });

  it("E9-227: a chain with anything else in it is not that shape", () => {
    const url = "https://example.org/p.zip";
    // unzipping some other archive, removing something else, a pipe, a command it does not read
    for (const line of [
      `cd ~/dust/audio && wget ${url} && unzip other.zip`,
      `cd ~/dust/audio && wget ${url} && unzip p.zip && rm -rf ~/dust/code`,
      `cd ~/dust/audio && wget ${url} | unzip p.zip`,
      `cd ~/dust/audio && wget ${url} && unzip p.zip && make`,
    ]) {
      expect(runShell(new Vfs(), line).fetch?.unzipTo, line).toBeUndefined();
    }
    // and the old two-part forms are what they were
    expect(runShell(new Vfs(), `cd ~/dust/audio && wget ${url}`).fetch).toEqual({ kind: "file", url, dest: "/home/we/dust/audio/p.zip" });
  });

  it("refuses an unzip that says nowhere", () => {
    expect(runShell(new Vfs(), "unzip thing.zip").fetch).toBeUndefined();
  });
});

describe("a download finished by hand", () => {
  const setup = () => {
    const vfs = new Vfs();
    const asked: HandDownload[] = [];
    const h = createHandDownloads({ vfs, unzip: fakeUnzip, onAsk: (d) => asked.push(d) });
    return { vfs, asked, h };
  };
  const URL_ = "https://github.com/schollz/mx.samples/releases/download/samples/ghost_piano.zip";
  const ZIP = "/home/we/dust/audio/mx.samples/ghost_piano/download.zip";
  const DIR = "/home/we/dust/audio/mx.samples/ghost_piano";

  it("asks a person once the page cannot fetch it, and unzips what they give where the script said", async () => {
    const { vfs, asked, h } = setup();
    h.started(URL_, ZIP); // curl -L -o …
    await h.unzip(ZIP, DIR); // unzip … -d … (the file is not here yet)
    h.failed(ZIP, "Failed to fetch"); // the browser refused GitHub's reply
    h.failed(ZIP, "again");
    expect(asked.length, "asked once").toBe(1);
    expect(asked[0]!.unzipTo).toBe(DIR);

    const n = await h.provide(ZIP, enc(JSON.stringify({ "C4.wav": "riff", "sub/E4.wav": "riff2", "__MACOSX/x": "junk" })));
    expect(n).toBe(2);
    expect(vfs.readText(`${DIR}/C4.wav`)).toBe("riff");
    expect(vfs.readText(`${DIR}/sub/E4.wav`)).toBe("riff2");
    expect(vfs.exists(`${DIR}/__MACOSX/x`)).toBe(false);
    expect(h.pending()).toEqual([]);
  });

  it("writes the file itself when nothing asked to unzip it", async () => {
    const { vfs, h } = setup();
    h.started("https://example.org/a.wav", "/home/we/dust/audio/a.wav");
    h.failed("/home/we/dust/audio/a.wav", "no");
    await h.provide("/home/we/dust/audio/a.wav", enc("bytes"));
    expect(vfs.readText("/home/we/dust/audio/a.wav")).toBe("bytes");
  });

  it("unzips by itself when the page COULD fetch it, and does not keep the archive", async () => {
    const { vfs, asked, h } = setup();
    h.started("https://cors.example/k.zip", "/tmp/k.zip");
    await h.unzip("/tmp/k.zip", "/home/we/dust/audio/k");
    await h.fetched("/tmp/k.zip", enc(JSON.stringify({ "x.wav": "1" })));
    expect(vfs.readText("/home/we/dust/audio/k/x.wav")).toBe("1");
    expect(vfs.exists("/tmp/k.zip"), "the archive is not written: the script's rm already ran").toBe(false);
    expect(asked).toEqual([]);
  });

  it("writes a fetched file that nothing unzips, as before", async () => {
    const { vfs, h } = setup();
    h.started("https://cors.example/a.wav", "/home/we/dust/audio/a.wav");
    await h.fetched("/home/we/dust/audio/a.wav", enc("bytes"));
    expect(vfs.readText("/home/we/dust/audio/a.wav")).toBe("bytes");
    expect(h.pending()).toEqual([]);
  });

  it("E9-227: unzips where a one-line `wget && unzip` said, and mends moonraker's doubled slash", async () => {
    const { vfs, h } = setup();
    h.started("https://github.com/schollz/moonraker/releases/download/samplepack1/moonraker.zip", "/home/we/dust/audio/moonraker.zip", "/home/we/dust/audio");
    await h.fetched("/home/we/dust/audio/moonraker.zip", enc(JSON.stringify({ "moonraker//1/kick.wav": "k" })));
    expect(vfs.readText("/home/we/dust/audio/moonraker/1/kick.wav")).toBe("k");
    expect(vfs.exists("/home/we/dust/audio/moonraker.zip")).toBe(false);
  });

  it("unzips an archive that is already here, and refuses a path that climbs out", async () => {
    const { vfs, h } = setup();
    vfs.write("/home/we/dust/audio/p.zip", enc(JSON.stringify({ "a.wav": "1", "../../evil.lua": "x" })));
    await h.unzip("/home/we/dust/audio/p.zip", "/home/we/dust/audio/p");
    expect(vfs.readText("/home/we/dust/audio/p/a.wav")).toBe("1");
    expect(vfs.exists("/home/we/dust/evil.lua")).toBe(false);
  });
});

describe("the page", () => {
  const main = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "main.ts"), "utf8") as string;

  it("tells the registry every file fetch, and asks a person when one fails", () => {
    expect(main).toMatch(/if \(f\.kind === "file"\) handDownloads\.started\(f\.url, f\.dest, f\.unzipTo\);/);
    expect(main).toMatch(/if \(f\.kind === "file"\) handDownloads\.failed\(f\.dest,/);
    expect(main).toMatch(/await handDownloads\.fetched\(f\.dest, got\.bytes\);/);
  });

  it("hands every unzip to the registry, never to the fetcher", () => {
    // E9-255 — with the line at the top of the page started first.
    expect(main).toMatch(/if \(f\.kind === "unzip"\) \{[\s\S]{0,200}?await handDownloads\.unzip\(f\.url, f\.dest\)/);
  });
});
